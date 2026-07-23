/// Type inference for Gema using constraint-based unification.
///
/// Walks the resolved AST and assigns a `TypeId` to every expression
/// by solving equality constraints between types.  Uses a simple
/// unification-based approach with `InferVar` type variables.
use rustc_hash::FxHashMap;

use crate::ast::*;
use crate::builtins::BuiltinFunc;
use crate::diagnostics::DiagnosticsBag;
use crate::interner::{IdentId, Interner};
use crate::source::Span;
use crate::symbol::{ScopeId, ScopeTree, SymbolId, SymbolKind};
use crate::types::{TypeArena, TypeId, TypeKind};

/// Run type inference on a resolved AST.
///
/// Returns a map from every expression node to its inferred `TypeId`.
pub fn infer_types(
    arena: &AstArena,
    scope_tree: &mut ScopeTree,
    type_arena: &mut TypeArena,
    interner: &Interner,
    root: NodeId,
    diagnostics: &mut DiagnosticsBag,
    file_idx: usize,
) -> FxHashMap<NodeId, TypeId> {
    let mut infer = Inferer::new(
        arena,
        scope_tree,
        type_arena,
        interner,
        diagnostics,
        file_idx,
    );
    infer.infer_expr(root);
    let types = std::mem::take(&mut infer.types);
    scope_tree.populate_from_types(&types);
    types
}

struct Inferer<'a> {
    arena: &'a AstArena,
    scope_tree: &'a mut ScopeTree,
    type_arena: &'a mut TypeArena,
    interner: &'a Interner,
    diagnostics: &'a mut DiagnosticsBag,
    file_idx: usize,
    /// Bindings from InferVar ids to their solved types.
    bindings: FxHashMap<u32, TypeId>,
    /// Final types for every expression node.
    types: FxHashMap<NodeId, TypeId>,
    /// Scope stack of variable types.  Each entry corresponds to a
    /// lexical scope (top-level, block, function body, etc.).  Variable
    /// lookups walk the stack top-to-bottom; assignments insert into
    /// the top frame.  The bool indicates whether the variable was
    /// declared with `mut`.
    var_type_stack: Vec<FxHashMap<IdentId, (TypeId, bool)>>,
    /// Current function's return type (for return statements).
    return_type: Option<TypeId>,
    /// Inferred return types for function definitions, keyed by the
    /// function's `NodeId`.  Populated during `FuncDef` inference and
    /// used by `function_type_from_def` so call sites see the inferred
    /// return type even without an explicit annotation.
    function_return_types: FxHashMap<NodeId, TypeId>,
}

impl<'a> Inferer<'a> {
    fn new(
        arena: &'a AstArena,
        scope_tree: &'a mut ScopeTree,
        type_arena: &'a mut TypeArena,
        interner: &'a Interner,
        diagnostics: &'a mut DiagnosticsBag,
        file_idx: usize,
    ) -> Self {
        Self {
            arena,
            scope_tree,
            type_arena,
            interner,
            diagnostics,
            file_idx,
            bindings: FxHashMap::default(),
            types: FxHashMap::default(),
            var_type_stack: vec![FxHashMap::default()],
            return_type: None,
            function_return_types: FxHashMap::default(),
        }
    }

    fn fresh_infer_var(&mut self) -> TypeId {
        self.type_arena.fresh_infer_var()
    }

    // ── Resolution ──

    /// Follow the binding chain of an `InferVar` to its resolved type.
    fn resolve(&self, mut ty: TypeId) -> TypeId {
        loop {
            match self.type_arena.get(ty) {
                TypeKind::InferVar { id } => match self.bindings.get(id) {
                    Some(&bound) => ty = bound,
                    None => return ty,
                },
                _ => return ty,
            }
        }
    }

    // ── Occurs check ──

    fn occurs(&self, var_id: u32, ty: TypeId) -> bool {
        let ty = self.resolve(ty);
        match self.type_arena.get(ty) {
            TypeKind::InferVar { id } => *id == var_id,
            TypeKind::Arr(inner) => self.occurs(var_id, *inner),
            TypeKind::Iter(inner) => self.occurs(var_id, *inner),
            TypeKind::MutArr(inner) => self.occurs(var_id, *inner),
            TypeKind::Set(inner) => self.occurs(var_id, *inner),
            TypeKind::MutSet(inner) => self.occurs(var_id, *inner),
            TypeKind::Maybe(inner) => self.occurs(var_id, *inner),
            TypeKind::Dict { key, val } => self.occurs(var_id, *key) || self.occurs(var_id, *val),
            TypeKind::MutDict { key, val } => {
                self.occurs(var_id, *key) || self.occurs(var_id, *val)
            }
            TypeKind::Tuple(elems) => elems.iter().any(|e| self.occurs(var_id, *e)),
            TypeKind::Func { params, ret } => {
                params.iter().any(|p| self.occurs(var_id, *p)) || self.occurs(var_id, *ret)
            }
            TypeKind::Custom { args, .. } => args.iter().any(|a| self.occurs(var_id, *a)),
            _ => false,
        }
    }

    // ── Unification ──

    /// Unify two types.  Returns the unified type.
    fn unify(&mut self, a: TypeId, b: TypeId) -> TypeId {
        let a = self.resolve(a);
        let b = self.resolve(b);
        if a == b {
            return a;
        }

        let ak = self.type_arena.get(a).clone();
        let bk = self.type_arena.get(b).clone();

        // Int and Num are separate types — no automatic promotion.
        // Mixing them requires explicit conversion (toNum, toInt).

        match (&ak, &bk) {
            // InferVar on either side → bind
            (TypeKind::InferVar { id }, _) => self.bind_infer_var(*id, b),
            (_, TypeKind::InferVar { id }) => self.bind_infer_var(*id, a),
            // Void (bottom type) unifies with anything, returns the other
            (TypeKind::Void, _) => b,
            (_, TypeKind::Void) => a,
            // Same primitives
            (TypeKind::Int, TypeKind::Int)
            | (TypeKind::Num, TypeKind::Num)
            | (TypeKind::Str, TypeKind::Str)
            | (TypeKind::Bool, TypeKind::Bool)
            | (TypeKind::Unknown, _)
            | (_, TypeKind::Unknown) => a,
            // Arrays
            (TypeKind::Arr(ia), TypeKind::Arr(ib)) => {
                let inner = self.unify(*ia, *ib);
                self.type_arena.intern(TypeKind::Arr(inner))
            }
            (TypeKind::Iter(ia), TypeKind::Iter(ib)) => {
                let inner = self.unify(*ia, *ib);
                self.type_arena.intern(TypeKind::Iter(inner))
            }
            (TypeKind::MutArr(ia), TypeKind::MutArr(ib)) => {
                let inner = self.unify(*ia, *ib);
                self.type_arena.intern(TypeKind::MutArr(inner))
            }
            (TypeKind::Set(ia), TypeKind::Set(ib)) => {
                let inner = self.unify(*ia, *ib);
                self.type_arena.intern(TypeKind::Set(inner))
            }
            (TypeKind::MutSet(ia), TypeKind::MutSet(ib)) => {
                let inner = self.unify(*ia, *ib);
                self.type_arena.intern(TypeKind::MutSet(inner))
            }
            (TypeKind::Maybe(ia), TypeKind::Maybe(ib)) => {
                let inner = self.unify(*ia, *ib);
                self.type_arena.intern(TypeKind::Maybe(inner))
            }
            // Dicts
            (TypeKind::Dict { key: ka, val: va }, TypeKind::Dict { key: kb, val: vb }) => {
                let k = self.unify(*ka, *kb);
                let v = self.unify(*va, *vb);
                self.type_arena.intern(TypeKind::Dict { key: k, val: v })
            }
            (TypeKind::MutDict { key: ka, val: va }, TypeKind::MutDict { key: kb, val: vb }) => {
                let k = self.unify(*ka, *kb);
                let v = self.unify(*va, *vb);
                self.type_arena.intern(TypeKind::MutDict { key: k, val: v })
            }
            // Tuples (must have same length)
            (TypeKind::Tuple(ea), TypeKind::Tuple(eb)) => {
                if ea.len() != eb.len() {
                    self.emit_error(
                        self.current_span(),
                        format!(
                            "tuple length mismatch: expected {}, found {}",
                            ea.len(),
                            eb.len()
                        ),
                    );
                    return self.type_arena.unknown_id();
                }
                let elems: Vec<_> = ea
                    .iter()
                    .zip(eb.iter())
                    .map(|(a, b)| self.unify(*a, *b))
                    .collect();
                self.type_arena.intern(TypeKind::Tuple(elems))
            }
            // Functions (must have same param count)
            (
                TypeKind::Func {
                    params: pa,
                    ret: ra,
                },
                TypeKind::Func {
                    params: pb,
                    ret: rb,
                },
            ) => {
                if pa.len() != pb.len() {
                    self.emit_error(
                        self.current_span(),
                        format!(
                            "function parameter count mismatch: expected {}, found {}",
                            pa.len(),
                            pb.len()
                        ),
                    );
                    return self.type_arena.unknown_id();
                }
                let params: Vec<_> = pa
                    .iter()
                    .zip(pb.iter())
                    .map(|(a, b)| self.unify(*a, *b))
                    .collect();
                let ret = self.unify(*ra, *rb);
                self.type_arena.intern(TypeKind::Func { params, ret })
            }
            // Generic type parameters unify with any type
            (TypeKind::Generic { .. }, _) => b,
            (_, TypeKind::Generic { .. }) => a,
            // Custom types with same name
            (TypeKind::Custom { name: na, args: aa }, TypeKind::Custom { name: nb, args: ab })
                if na == nb && aa.len() == ab.len() =>
            {
                let args: Vec<_> = aa
                    .iter()
                    .zip(ab.iter())
                    .map(|(a, b)| self.unify(*a, *b))
                    .collect();
                self.type_arena.intern(TypeKind::Custom { name: *na, args })
            }
            // Fallthrough: type mismatch
            _ => {
                self.emit_type_mismatch(a, b);
                self.type_arena.unknown_id()
            }
        }
    }

    /// Bind an InferVar to a type, with occurs check.
    fn bind_infer_var(&mut self, id: u32, ty: TypeId) -> TypeId {
        if self.occurs(id, ty) {
            self.emit_error(
                self.current_span(),
                "recursive type: type contains itself".to_string(),
            );
            return self.type_arena.unknown_id();
        }
        self.bindings.insert(id, ty);
        ty
    }

    // ── Error reporting ──

    fn emit_error(&mut self, span: Span, msg: String) {
        self.diagnostics.error(self.file_idx, span, msg);
    }

    fn emit_type_mismatch(&mut self, a: TypeId, b: TypeId) {
        let a_str = self.fmt_type(a);
        let b_str = self.fmt_type(b);
        self.emit_error(
            self.current_span(),
            format!("mismatched types: expected '{a_str}', found '{b_str}'"),
        );
    }

    fn fmt_type(&self, ty: TypeId) -> String {
        let resolved = self.resolve(ty);
        match self.type_arena.get(resolved) {
            TypeKind::Int => "Int".into(),
            TypeKind::Num => "Num".into(),
            TypeKind::Str => "Str".into(),
            TypeKind::Bool => "Bool".into(),
            TypeKind::Void => "Void".into(),
            TypeKind::InferVar { id } => format!("?{id}"),
            TypeKind::Unknown => "?".into(),
            TypeKind::Arr(inner) => format!("Arr[{}]", self.fmt_type(*inner)),
            TypeKind::Iter(inner) => format!("Iter[{}]", self.fmt_type(*inner)),
            TypeKind::MutArr(inner) => format!("MutArr[{}]", self.fmt_type(*inner)),
            TypeKind::Set(inner) => format!("Set[{}]", self.fmt_type(*inner)),
            TypeKind::MutSet(inner) => format!("MutSet[{}]", self.fmt_type(*inner)),
            TypeKind::Maybe(inner) => format!("Maybe[{}]", self.fmt_type(*inner)),
            TypeKind::Dict { key, val } => {
                format!("Dict[{}, {}]", self.fmt_type(*key), self.fmt_type(*val))
            }
            TypeKind::MutDict { key, val } => {
                format!("MutDict[{}, {}]", self.fmt_type(*key), self.fmt_type(*val))
            }
            TypeKind::Tuple(elems) => {
                let inner: Vec<_> = elems.iter().map(|e| self.fmt_type(*e)).collect();
                format!("Tup[{}]", inner.join(", "))
            }
            TypeKind::Func { params, ret } => {
                let ps: Vec<_> = params.iter().map(|p| self.fmt_type(*p)).collect();
                format!("Func[{}, {}]", ps.join(", "), self.fmt_type(*ret))
            }
            TypeKind::Custom { args, .. } => {
                if args.is_empty() {
                    "Custom".into()
                } else {
                    let inner: Vec<_> = args.iter().map(|a| self.fmt_type(*a)).collect();
                    format!("Custom[{}]", inner.join(", "))
                }
            }
            TypeKind::Generic { .. } => "generic".into(),
            TypeKind::SelfType => "Self".into(),
        }
    }

    fn current_span(&self) -> Span {
        Span::empty_at(0)
    }

    // ── Main inference dispatch ──

    fn infer_expr(&mut self, node: NodeId) -> TypeId {
        let ty = match &self.arena[node] {
            Expr::IntLit(_) => self.type_arena.int_id(),
            Expr::NumLit(_) => self.type_arena.num_id(),
            Expr::StrLit(_) => self.type_arena.str_id(),
            Expr::BoolLit(_) => self.type_arena.bool_id(),
            Expr::NoneLit(n) => self.infer_none_lit(n),
            Expr::Var(v) => self.infer_var(node, v),
            Expr::Call(c) => self.infer_call(node, c),
            Expr::Binary(b) => self.infer_binary(b),
            Expr::Unary(u) => self.infer_unary(u),
            Expr::Assign(a) => self.infer_assign(node, a),
            Expr::Block(b) => self.infer_block(b),
            Expr::If(i) => self.infer_if(node, i),
            Expr::Match(m) => self.infer_match(node, m),
            Expr::FuncDef(f) => {
                // Register the function's type so calls can find it
                // BEFORE inferring the body (enables recursion).
                let func_ty = self.function_type_from_def(node);
                let func_kind = self.type_arena.get(func_ty).clone();
                let return_ty = match func_kind {
                    TypeKind::Func { ret, .. } => ret,
                    _ => self.fresh_infer_var(),
                };
                let top = self.var_type_stack.len() - 1;
                self.var_type_stack[top].insert(f.name, (func_ty, false));

                // Collect generic type param names for this function.
                let generic_names: Vec<IdentId> = f.type_params.iter().map(|tp| tp.name).collect();

                // Push a scope frame and register params.
                self.var_type_stack.push(FxHashMap::default());
                for param in &f.params {
                    let param_ty = if let Some(ref tn) = param.type_node {
                        // If the param type is a reference to a generic type param,
                        // use an InferVar so it can unify with concrete call args.
                        let is_generic_ref = matches!(tn, TypeNode::Named { name, params } if generic_names.contains(name) && params.is_empty());
                        if is_generic_ref {
                            self.fresh_infer_var()
                        } else {
                            self.lower_type_node(tn)
                        }
                    } else {
                        self.fresh_infer_var()
                    };
                    let frame = self.var_type_stack.len() - 1;
                    self.var_type_stack[frame].insert(param.name, (param_ty, false));
                }

                // Infer the body with the declared return type as context.
                let prev_ret = self.return_type.replace(return_ty);
                let body_ty = self.infer_expr(f.body);
                self.var_type_stack.pop();

                // Unify body type with declared return type.
                self.return_type = prev_ret;
                self.unify(body_ty, return_ty);

                // Store the resolved return type so callers can use it.
                self.function_return_types
                    .insert(node, self.resolve(return_ty));

                self.type_arena.void_id()
            }
            Expr::AnonFunc(a) => self.infer_anon_func(node, a),
            Expr::Return(r) => self.infer_return(node, r),
            Expr::ForLoop(f) => self.infer_for_loop(f),
            Expr::ArrLit(a) => self.infer_array(a),
            Expr::TupleLit(t) => self.infer_tuple(t),
            Expr::RangeIter(r) => self.infer_range(r),
            Expr::FieldAccess(f) => self.infer_field_access(node, f),
            Expr::TypeAssociated(t) => self.infer_type_associated(node, t),
            Expr::TupleUnpack(t) => self.infer_tuple_unpack(node, t),
            Expr::DropValue(d) => {
                self.infer_expr(d.child);
                self.type_arena.void_id()
            }
            Expr::FieldAssign(f) => self.infer_field_assign(node, f),
            Expr::Use(_)
            | Expr::UseJs(_)
            | Expr::Continue(_)
            | Expr::Break(_)
            | Expr::StructDef(_)
            | Expr::EnumDef(_)
            | Expr::TraitDef(_)
            | Expr::ErrorExpr => self.type_arena.void_id(),
            Expr::ImplBlock(i) => self.infer_impl_block(node, i),
        };
        self.types.insert(node, ty);
        ty
    }

    // ── Literals ──

    fn infer_none_lit(&mut self, n: &NoneLit) -> TypeId {
        if let Some(ref inner_type) = n.inner_type {
            // Annotation present: `none: Int` → Maybe[Int]
            let inner = self.lower_type_node(inner_type);
            self.type_arena.intern(TypeKind::Maybe(inner))
        } else {
            // No annotation: create Maybe[α] with fresh variable
            let inner = self.fresh_infer_var();
            self.type_arena.intern(TypeKind::Maybe(inner))
        }
    }

    // ── Variables ──

    fn infer_var(&mut self, node: NodeId, v: &Var) -> TypeId {
        // If the variable has template type annotations (e.g. `foo[Num]`),
        // resolve to the matching function overload.
        if !v.template_types.is_empty() {
            let scope = self
                .scope_tree
                .node_scope
                .get(&node)
                .copied()
                .unwrap_or(self.scope_tree.root_scope);
            let type_annotation = self.lower_type_node(&v.template_types[0]);

            let func_def_nodes: Vec<NodeId> = self
                .scope_tree
                .lookup_functions(scope, v.name)
                .iter()
                .map(|sym| sym.def_node)
                .collect();

            for &def_node in &func_def_nodes {
                let func_type = self.function_type_from_def(def_node);
                if let TypeKind::Func { params, .. } = self.type_arena.get(func_type).clone() {
                    if params.is_empty() {
                        continue;
                    }
                    let saved_diag_len = self.diagnostics.len();
                    let unified = self.unify(params[0], type_annotation);
                    if !matches!(self.type_arena.get(unified), TypeKind::Unknown) {
                        self.scope_tree.inferred_defs.insert(node, def_node);
                        return self.resolve(func_type);
                    }
                    self.diagnostics.truncate(saved_diag_len);
                }
            }
        }

        // Walk the scope stack from top (innermost) to bottom.
        for frame in self.var_type_stack.iter().rev() {
            if let Some(&(tid, _)) = frame.get(&v.name) {
                return tid;
            }
        }

        if let Some(&sid) = self.scope_tree.resolved_refs.get(&node) {
            let sym = &self.scope_tree.symbols[sid];
            match &sym.kind {
                SymbolKind::Variable { .. } => self.fresh_infer_var(),
                SymbolKind::Function { .. }
                | SymbolKind::Struct { .. }
                | SymbolKind::Enum { .. }
                | SymbolKind::Trait { .. }
                | SymbolKind::Impl { .. }
                | SymbolKind::TypeParam { .. }
                | SymbolKind::TraitMethod { .. } => {
                    let name_str = self.interner.lookup(v.name);
                    self.emit_error(
                        self.arena[node].span(),
                        format!("'{name_str}' is not a value"),
                    );
                    self.type_arena.unknown_id()
                }
            }
        } else {
            self.type_arena.unknown_id()
        }
    }

    // ── Call ──

    fn infer_call(&mut self, node: NodeId, c: &Call) -> TypeId {
        let arg_types: Vec<TypeId> = c.args.iter().map(|&arg| self.infer_expr(arg)).collect();
        // Check if the callee is a named variable (name-based overload resolution).
        if let Expr::Var(v) = &self.arena[c.callee] {
            let named_result = self.infer_named_call(node, v.name, &arg_types);
            if !matches!(self.type_arena.get(named_result), TypeKind::Unknown) {
                return named_result;
            }
            // Named lookup failed but name may exist as a variable.
            // Fall through to expression callee path.
        }

        // Expression callee — infer its type and unify with a function signature.
        let caller_ty = self.infer_expr(c.callee);

        let fresh_ret = self.fresh_infer_var();
        let fresh_params: Vec<TypeId> = (0..arg_types.len())
            .map(|_| self.fresh_infer_var())
            .collect();
        let expected_func = self.type_arena.intern(TypeKind::Func {
            params: fresh_params.clone(),
            ret: fresh_ret,
        });

        let unified = self.unify(caller_ty, expected_func);
        if matches!(self.type_arena.get(unified), TypeKind::Unknown) {
            self.emit_error(
                self.arena[node].span(),
                "called expression is not a function".to_string(),
            );
            return self.type_arena.unknown_id();
        }

        // Unify param types with arg types
        for (param, arg) in fresh_params.iter().zip(arg_types.iter()) {
            self.unify(*param, *arg);
        }

        self.resolve(fresh_ret)
    }

    /// Infer a call to a named function — handles overload resolution,
    /// struct constructors, trait methods, and builtins.
    fn infer_named_call(&mut self, node: NodeId, name: IdentId, arg_types: &[TypeId]) -> TypeId {
        // Collect function defs and their cached signatures separately
        // to avoid borrow conflicts with self.lower_type_node.
        let funcs: Vec<(NodeId, Option<Box<crate::ast::TypeNode>>)> = self
            .scope_tree
            .lookup_functions(
                self.scope_tree
                    .node_scope
                    .get(&node)
                    .copied()
                    .unwrap_or(self.scope_tree.root_scope),
                name,
            )
            .iter()
            .map(|s| {
                let sig = match &s.kind {
                    SymbolKind::Function {
                        cached_signature, ..
                    } => cached_signature.clone(),
                    _ => None,
                };
                (s.def_node, sig)
            })
            .collect();

        let func_info: Vec<(NodeId, Option<TypeId>)> = funcs
            .into_iter()
            .map(|(def_node, cached_sig)| {
                let ct = cached_sig.as_ref().map(|sig| self.lower_type_node(sig));
                (def_node, ct)
            })
            .collect();

        if func_info.is_empty() {
            // Check if it's a struct constructor instead.
            if let Some(result) = self.try_struct_constructor(node, name, arg_types) {
                return result;
            }
            // Check if it's a builtin function.
            let name_str = self.interner.lookup(name);
            if let Some(builtin) = BuiltinFunc::try_from_name(name_str)
                && let Some(ret_ty) = builtin.infer_return_type(arg_types, self.type_arena)
            {
                return ret_ty;
            }
            // The name wasn't found as a function or builtin — check if it
            // resolves to any symbol (variable, etc.). If so, return Unknown
            // to let infer_call try the expression callee path.
            let scope = self
                .scope_tree
                .node_scope
                .get(&node)
                .copied()
                .unwrap_or(self.scope_tree.root_scope);
            if self.scope_tree.lookup(scope, name).is_some() {
                return self.fresh_infer_var();
            }
            self.emit_error(
                self.arena[node].span(),
                format!("undefined function '{}'", self.interner.lookup(name)),
            );
            return self.type_arena.unknown_id();
        }
        for (def_node, cached_type) in func_info {
            let func_type = if let Some(ct) = cached_type {
                ct
            } else {
                self.function_type_from_def(def_node)
            };
            let func_kind = self.type_arena.get(func_type).clone();
            match func_kind {
                TypeKind::Func { params, ret } => {
                    if params.len() != arg_types.len() {
                        continue;
                    }
                    let saved_bindings = self.bindings.clone();
                    let saved_diag_len = self.diagnostics.len();
                    let mut ok = true;
                    for (param, arg) in params.iter().zip(arg_types.iter()) {
                        let unified = self.unify(*param, *arg);
                        if matches!(self.type_arena.get(unified), TypeKind::Unknown) {
                            ok = false;
                            break;
                        }
                    }
                    if !ok {
                        self.bindings = saved_bindings;
                        self.diagnostics.truncate(saved_diag_len);
                        continue;
                    }
                    let resolved = self.resolve(ret);
                    // Record which overload was selected for this call
                    self.scope_tree.inferred_defs.insert(node, def_node);
                    return resolved;
                }
                _ => continue,
            }
        }

        let name_str = self.interner.lookup(name);
        self.emit_error(
            self.arena[node].span(),
            format!("no matching function '{name_str}' for the given arguments"),
        );
        self.type_arena.unknown_id()
    }

    /// Try to infer a trait method call inside a generic function body.
    /// Looks up the name in the scope chain for a `TraitMethod` symbol.
    /// Replace `Self` in a `TypeNode` with a `TypeParamRef`.
    /// Trait requirement signatures use `Self` to refer to the implementing
    /// type; inside a generic function body, `Self` should be replaced with
    /// the type parameter so the call can be properly inferred.
    fn substitute_self_in_type_node(tn: &TypeNode, type_param: IdentId) -> TypeNode {
        match tn {
            TypeNode::SelfType => TypeNode::TypeParamRef {
                name: type_param,
                traits: vec![],
            },
            TypeNode::Arr(inner) => TypeNode::Arr(Box::new(Self::substitute_self_in_type_node(
                inner, type_param,
            ))),
            TypeNode::Iter(inner) => TypeNode::Iter(Box::new(Self::substitute_self_in_type_node(
                inner, type_param,
            ))),
            TypeNode::MutArr(inner) => TypeNode::MutArr(Box::new(
                Self::substitute_self_in_type_node(inner, type_param),
            )),
            TypeNode::Set(inner) => TypeNode::Set(Box::new(Self::substitute_self_in_type_node(
                inner, type_param,
            ))),
            TypeNode::MutSet(inner) => TypeNode::MutSet(Box::new(
                Self::substitute_self_in_type_node(inner, type_param),
            )),
            TypeNode::Maybe(inner) => TypeNode::Maybe(Box::new(
                Self::substitute_self_in_type_node(inner, type_param),
            )),
            TypeNode::Dict { key, val } => TypeNode::Dict {
                key: Box::new(Self::substitute_self_in_type_node(key, type_param)),
                val: Box::new(Self::substitute_self_in_type_node(val, type_param)),
            },
            TypeNode::MutDict { key, val } => TypeNode::MutDict {
                key: Box::new(Self::substitute_self_in_type_node(key, type_param)),
                val: Box::new(Self::substitute_self_in_type_node(val, type_param)),
            },
            TypeNode::Tup(elems) => TypeNode::Tup(
                elems
                    .iter()
                    .map(|e| Self::substitute_self_in_type_node(e, type_param))
                    .collect(),
            ),
            TypeNode::Func { params, ret } => TypeNode::Func {
                params: params
                    .iter()
                    .map(|p| Self::substitute_self_in_type_node(p, type_param))
                    .collect(),
                ret: Box::new(Self::substitute_self_in_type_node(ret, type_param)),
            },
            // Primitives, Named, TypeParamRef — no Self to substitute.
            other => other.clone(),
        }
    }

    #[allow(unused_variables)]
    fn try_trait_method_call(
        &mut self,
        node: NodeId,
        name: IdentId,
        arg_types: &[TypeId],
    ) -> Option<TypeId> {
        // Find the TraitMethod symbol and extract its signature and type_param.
        let mut current = self
            .scope_tree
            .node_scope
            .get(&node)
            .copied()
            .unwrap_or(self.scope_tree.root_scope);
        let mut info: Option<(IdentId, crate::ast::TypeNode)> = None;
        loop {
            if let Some(ids) = self.scope_tree.scopes[current].symbols.get(&name) {
                for &sid in ids.iter().rev() {
                    if let SymbolKind::TraitMethod {
                        signature: sig,
                        type_param,
                        ..
                    } = &self.scope_tree.symbols[sid].kind
                    {
                        // Substitute Self → type param in the signature.
                        let substituted = Self::substitute_self_in_type_node(sig, *type_param);
                        info = Some((*type_param, substituted));
                        break;
                    }
                }
                if info.is_some() {
                    break;
                }
            }
            match self.scope_tree.scopes[current].parent {
                Some(p) => current = p,
                None => return None,
            }
        }

        let (_type_param, sig) = info?;
        let func_ty = self.lower_type_node(&sig);
        match self.type_arena.get(func_ty).clone() {
            TypeKind::Func { params, ret } => {
                if params.len() != arg_types.len() {
                    return None;
                }
                let mut ok = true;
                for (param, arg) in params.iter().zip(arg_types.iter()) {
                    let unified = self.unify(*param, *arg);
                    if matches!(self.type_arena.get(unified), TypeKind::Unknown) {
                        ok = false;
                        break;
                    }
                }
                if !ok {
                    return None;
                }
                Some(self.resolve(ret))
            }
            _ => None,
        }
    }

    /// Try to infer a struct constructor call.  Returns `Some` if the
    /// name resolves to a `Struct` symbol and construction succeeds.
    fn try_struct_constructor(
        &mut self,
        node: NodeId,
        name: IdentId,
        arg_types: &[TypeId],
    ) -> Option<TypeId> {
        let scope = self
            .scope_tree
            .node_scope
            .get(&node)
            .copied()
            .unwrap_or(self.scope_tree.root_scope);
        let sid = self.find_struct(scope, name)?;
        let sym = &self.scope_tree.symbols[sid];

        // Clone struct definition data before making mutable calls.
        let struct_data = match &sym.kind {
            SymbolKind::Struct {
                cached_fields: Some(fields),
                type_params,
                ..
            } => {
                let fields: Vec<_> = fields
                    .iter()
                    .map(|f| (f.name, f.type_node.clone()))
                    .collect();
                let type_params: Vec<_> = type_params.clone();
                let struct_name = sym.name;
                (fields, type_params, struct_name)
            }
            _ => match &self.arena[sym.def_node] {
                Expr::StructDef(s) => {
                    let fields: Vec<_> = s
                        .fields
                        .iter()
                        .map(|f| (f.name, f.type_node.clone()))
                        .collect();
                    let type_params: Vec<_> = s.type_params.iter().map(|tp| tp.name).collect();
                    let struct_name = s.name;
                    (fields, type_params, struct_name)
                }
                _ => return None,
            },
        };

        let (fields, type_params, struct_name) = struct_data;
        if arg_types.len() != fields.len() {
            self.emit_error(
                self.arena[node].span(),
                format!(
                    "expected {} arguments, found {}",
                    fields.len(),
                    arg_types.len()
                ),
            );
            return Some(self.type_arena.unknown_id());
        }

        let mut generic_params = FxHashMap::default();
        let mut fresh_args: Vec<TypeId> = Vec::new();
        for tp_name in &type_params {
            let fv = self.fresh_infer_var();
            fresh_args.push(fv);
            generic_params.insert(*tp_name, fv);
        }

        for (i, (_field_name, field_type_node)) in fields.iter().enumerate() {
            let field_ty = self.lower_type_node_with(field_type_node, &generic_params);
            self.unify(field_ty, arg_types[i]);
        }

        let resolved: Vec<TypeId> = fresh_args.iter().map(|&a| self.resolve(a)).collect();
        Some(self.type_arena.intern(TypeKind::Custom {
            name: struct_name,
            args: resolved,
        }))
    }

    // ── Binary and Unary ──

    fn infer_binary(&mut self, b: &Binary) -> TypeId {
        let left = self.infer_expr(b.left);
        let right = self.infer_expr(b.right);

        match b.op {
            BinaryOp::Add => self.unify(left, right),
            BinaryOp::Sub
            | BinaryOp::Mul
            | BinaryOp::Div
            | BinaryOp::IntDiv
            | BinaryOp::Mod
            | BinaryOp::EucMod
            | BinaryOp::Pow => self.unify(left, right),
            BinaryOp::Eq
            | BinaryOp::Ne
            | BinaryOp::Lt
            | BinaryOp::Le
            | BinaryOp::Gt
            | BinaryOp::Ge => {
                self.unify(left, right);
                self.type_arena.bool_id()
            }
            BinaryOp::And | BinaryOp::Or => {
                self.unify(left, self.type_arena.bool_id());
                self.unify(right, self.type_arena.bool_id());
                self.type_arena.bool_id()
            }
        }
    }

    fn infer_unary(&mut self, u: &Unary) -> TypeId {
        let child = self.infer_expr(u.child);
        match u.op {
            UnaryOp::Neg => {
                // Must be numeric
                child
            }
            UnaryOp::Not => {
                self.unify(child, self.type_arena.bool_id());
                self.type_arena.bool_id()
            }
        }
    }

    // ── Assignments ──

    fn infer_assign(&mut self, node: NodeId, a: &Assign) -> TypeId {
        let val_ty = self.infer_expr(a.value);
        let ty = if let Some(ref ann) = a.type_annotation {
            let ann_ty = self.lower_type_node(ann);
            self.unify(val_ty, ann_ty)
        } else {
            val_ty
        };

        let top = self.var_type_stack.len() - 1;

        // Same-scope reassignment — name exists in top frame.
        if let Some(&(existing, existing_mut)) = self.var_type_stack[top].get(&a.name) {
            if !existing_mut {
                let name_str = self.interner.lookup(a.name);
                self.emit_error(
                    self.arena[node].span(),
                    format!("cannot reassign immutable variable '{name_str}'"),
                );
            }
            let unified = self.unify(existing, ty);
            self.var_type_stack[top].insert(a.name, (unified, a.is_mut));
            return unified;
        }

        // Check parent frames (innermost to outermost).
        for i in (0..top).rev() {
            if let Some(&(parent_ty, parent_mut)) = self.var_type_stack[i].get(&a.name) {
                if a.is_mut {
                    // Explicit shadow — new variable in current frame.
                    self.var_type_stack[top].insert(a.name, (ty, true));
                    return ty;
                }
                if parent_mut {
                    // Reassignment of parent — type-check.
                    let unified = self.unify(parent_ty, ty);
                    self.var_type_stack[top].insert(a.name, (unified, false));
                    return unified;
                }
                // Immutable parent — this is a shadow (the resolver
                // registered a new symbol).  New declaration.
                self.var_type_stack[top].insert(a.name, (ty, false));
                return ty;
            }
        }

        // New declaration.
        self.var_type_stack[top].insert(a.name, (ty, a.is_mut));
        ty
    }

    // ── Blocks ──

    fn infer_block(&mut self, b: &Block) -> TypeId {
        self.var_type_stack.push(FxHashMap::default());
        let mut last_ty = self.type_arena.void_id();
        for &stmt in &b.stmts {
            last_ty = self.infer_expr(stmt);
        }
        self.var_type_stack.pop();
        last_ty
    }

    fn infer_impl_block(&mut self, _node: NodeId, i: &ImplBlock) -> TypeId {
        // Infer each member (FuncDef or Assign).
        for &member in &i.members {
            self.infer_expr(member);
        }
        self.type_arena.void_id()
    }

    // ── If ──

    fn infer_if(&mut self, _node: NodeId, i: &If) -> TypeId {
        for branch in &i.branches {
            let cond_ty = self.infer_expr(branch.condition);
            self.unify(cond_ty, self.type_arena.bool_id());
        }

        let else_body = match i.else_branch {
            Some(eb) => eb,
            None => {
                // With no else, the expression may not produce a value.
                for branch in &i.branches {
                    self.infer_expr(branch.body);
                }
                return self.type_arena.void_id();
            }
        };

        // With an else, all branches must unify to the same type.
        let mut branch_tys = Vec::new();
        for branch in &i.branches {
            branch_tys.push(self.infer_expr(branch.body));
        }
        branch_tys.push(self.infer_expr(else_body));
        let mut result = self.type_arena.void_id();
        for bt in &branch_tys {
            result = self.unify(result, *bt);
        }
        result
    }

    // ── Match ──

    fn infer_match(&mut self, _node: NodeId, m: &Match) -> TypeId {
        let _scrutinee_ty = self.infer_expr(m.scrutinee);

        let mut arm_types = Vec::new();
        for arm in &m.arms {
            let arm_ty = self.infer_expr(arm.body);
            arm_types.push(arm_ty);
        }

        // All arms must unify to the same type
        let mut result = self.type_arena.void_id();
        for at in &arm_types {
            result = self.unify(result, *at);
        }
        result
    }

    // ── Anonymous functions ──

    fn infer_anon_func(&mut self, _node: NodeId, a: &AnonFunc) -> TypeId {
        let param_types: Vec<TypeId> = a
            .params
            .iter()
            .map(|p| {
                if let Some(ref tn) = p.type_node {
                    self.lower_type_node(tn)
                } else {
                    self.fresh_infer_var()
                }
            })
            .collect();

        let ret_type = a
            .return_type
            .as_ref()
            .map(|tn| self.lower_type_node(tn))
            .unwrap_or_else(|| self.fresh_infer_var());

        // Infer body with return type context
        let prev_ret = self.return_type.replace(ret_type);
        let body_ty = self.infer_expr(a.body);
        self.unify(body_ty, ret_type);
        self.return_type = prev_ret;

        self.type_arena.intern(TypeKind::Func {
            params: param_types,
            ret: ret_type,
        })
    }

    // ── Return ──

    fn infer_return(&mut self, node: NodeId, r: &Return) -> TypeId {
        if let Some(val) = r.value {
            let val_ty = self.infer_expr(val);
            if let Some(ret_ty) = self.return_type {
                self.unify(val_ty, ret_ty);
            } else {
                self.emit_error(
                    self.arena[node].span(),
                    "return outside of function".to_string(),
                );
            }
        }
        self.type_arena.void_id()
    }

    // ── For loop ──

    fn infer_for_loop(&mut self, f: &ForLoop) -> TypeId {
        let iter_ty = self.infer_expr(f.iter);
        let var_ty = self.fresh_infer_var();
        let expected_iter = self.type_arena.intern(TypeKind::Iter(var_ty));
        self.unify(iter_ty, expected_iter);
        // Register the loop variable in the current scope frame so the
        // body can reference it.
        let top = self.var_type_stack.len() - 1;
        self.var_type_stack[top].insert(f.var_name, (var_ty, false));
        self.infer_expr(f.body);
        self.type_arena.void_id()
    }

    // ── Arrays and tuples ──

    fn infer_array(&mut self, a: &ArrLit) -> TypeId {
        let inner = if let Some(ref ann) = a.inner_type {
            self.lower_type_node(ann)
        } else if a.elements.is_empty() {
            self.fresh_infer_var()
        } else {
            let mut elem_ty = self.infer_expr(a.elements[0]);
            for &elem in &a.elements[1..] {
                let e_ty = self.infer_expr(elem);
                elem_ty = self.unify(elem_ty, e_ty);
            }
            elem_ty
        };
        self.type_arena.intern(TypeKind::Arr(inner))
    }

    fn infer_tuple(&mut self, t: &TupleLit) -> TypeId {
        let elems: Vec<TypeId> = t.elements.iter().map(|&e| self.infer_expr(e)).collect();
        self.type_arena.intern(TypeKind::Tuple(elems))
    }

    fn infer_range(&mut self, r: &RangeIter) -> TypeId {
        let start_ty = self.infer_expr(r.start);
        if let Some(end) = r.end {
            let end_ty = self.infer_expr(end);
            self.unify(start_ty, end_ty);
        }
        self.type_arena.intern(TypeKind::Iter(start_ty))
    }

    // ── Field access ──

    fn infer_field_access(&mut self, node: NodeId, f: &FieldAccess) -> TypeId {
        let raw_ty = self.infer_expr(f.obj);
        let obj_ty = self.resolve(raw_ty);

        let struct_info = match self.type_arena.get(obj_ty) {
            TypeKind::Custom { name, args } => Some((*name, args.clone())),
            _ => None,
        };

        match struct_info {
            Some((name, args)) => self.lookup_field_type(node, name, &args, f.field),
            None => {
                self.emit_error(
                    self.arena[node].span(),
                    "field access on a non-struct type".to_string(),
                );
                self.type_arena.unknown_id()
            }
        }
    }

    fn infer_field_assign(&mut self, node: NodeId, f: &FieldAssign) -> TypeId {
        let raw = self.infer_expr(f.obj);
        let obj_ty = self.resolve(raw);
        let val_ty = self.infer_expr(f.value);

        let struct_info = match self.type_arena.get(obj_ty) {
            TypeKind::Custom { name, args } => Some((*name, args.clone())),
            _ => None,
        };

        match struct_info {
            Some((name, args)) => {
                let field_ty = self.lookup_field_type(node, name, &args, f.field);
                if !matches!(self.type_arena.get(field_ty), TypeKind::Unknown) {
                    self.unify(field_ty, val_ty);
                }
                val_ty
            }
            None => {
                self.emit_error(
                    self.arena[node].span(),
                    "field assignment on a non-struct type".to_string(),
                );
                self.type_arena.unknown_id()
            }
        }
    }

    /// Look up a field's type from a struct definition, substituting
    /// generic parameters with the concrete args.
    fn lookup_field_type(
        &mut self,
        node: NodeId,
        struct_name: IdentId,
        concrete_args: &[TypeId],
        field_name: IdentId,
    ) -> TypeId {
        let scope = self
            .scope_tree
            .node_scope
            .get(&node)
            .copied()
            .unwrap_or(self.scope_tree.root_scope);
        let sym = match self.find_struct(scope, struct_name) {
            Some(sid) => &self.scope_tree.symbols[sid],
            None => return self.fresh_infer_var(),
        };

        // Clone struct data before making mutable calls.
        let (field_data, type_param_names): (Vec<(IdentId, TypeNode)>, Vec<IdentId>) =
            match &sym.kind {
                SymbolKind::Struct {
                    cached_fields: Some(fields),
                    type_params,
                    ..
                } => (
                    fields
                        .iter()
                        .map(|f| (f.name, f.type_node.clone()))
                        .collect(),
                    type_params.clone(),
                ),
                _ => match &self.arena[sym.def_node] {
                    Expr::StructDef(s) => (
                        s.fields
                            .iter()
                            .map(|f| (f.name, f.type_node.clone()))
                            .collect(),
                        s.type_params.iter().map(|tp| tp.name).collect(),
                    ),
                    _ => return self.fresh_infer_var(),
                },
            };

        let mut generic_params = FxHashMap::default();
        for (i, tp_name) in type_param_names.iter().enumerate() {
            if i < concrete_args.len() {
                generic_params.insert(*tp_name, concrete_args[i]);
            }
        }

        for (fname, ftype) in &field_data {
            if *fname == field_name {
                return self.lower_type_node_with(ftype, &generic_params);
            }
        }

        let field_str = self.interner.lookup(field_name);
        let struct_str = self.interner.lookup(struct_name);
        self.emit_error(
            self.arena[node].span(),
            format!("no field '{}' on struct '{}'", field_str, struct_str),
        );
        self.type_arena.unknown_id()
    }

    /// Find a `Struct` symbol by name in the scope chain.
    fn find_struct(&self, from: ScopeId, name: IdentId) -> Option<SymbolId> {
        let mut current = from;
        loop {
            if let Some(ids) = self.scope_tree.scopes[current].symbols.get(&name) {
                for &sid in ids.iter().rev() {
                    if matches!(
                        &self.scope_tree.symbols[sid].kind,
                        SymbolKind::Struct { .. }
                    ) {
                        return Some(sid);
                    }
                }
            }
            match self.scope_tree.scopes[current].parent {
                Some(p) => current = p,
                None => return None,
            }
        }
    }

    // ── Type-associated expressions ──

    fn infer_type_associated(&mut self, node: NodeId, t: &TypeAssociated) -> TypeId {
        // Extract the enum type name and any explicit template args.
        let (enum_name, explicit_args) = match &t.type_node {
            TypeNode::Named { name, params } => (*name, params.clone()),
            _ => {
                if let Expr::Var(v) = &self.arena[t.inner] {
                    return self.infer_typed_function_ref(node, v, t);
                }
                return self.infer_expr(t.inner);
            }
        };

        let scope = self
            .scope_tree
            .node_scope
            .get(&node)
            .copied()
            .unwrap_or(self.scope_tree.root_scope);
        let (variants, type_param_names) = match self.find_enum(scope, enum_name) {
            Some(info) => info,
            None => {
                // If this is not an enum instantiation, look it up in an impl block
                // TODO: This doesn't yet work 100% correctly
                if let Expr::Var(v) = &self.arena[t.inner] {
                    return self.infer_typed_function_ref(node, v, t);
                }
                return self.infer_expr(t.inner);
            }
        };

        let mut generic_params = FxHashMap::default();
        let mut concrete_args = Vec::new();
        for (i, tp_name) in type_param_names.iter().enumerate() {
            let tid = if i < explicit_args.len() {
                self.lower_type_node(&explicit_args[i])
            } else {
                self.fresh_infer_var()
            };
            concrete_args.push(tid);
            generic_params.insert(*tp_name, tid);
        }

        match &self.arena[t.inner] {
            Expr::Call(c) => {
                let call_name = match &self.arena[c.callee] {
                    Expr::Var(v) => v.name,
                    _ => return self.type_arena.unknown_id(),
                };
                let variant = variants.iter().find(|v| v.name == call_name);
                match variant {
                    Some(v) => {
                        if let Some(ref data_type) = v.type_node {
                            let lowered = self.lower_type_node_with(data_type, &generic_params);
                            for &arg in &c.args {
                                let arg_ty = self.infer_expr(arg);
                                self.unify(lowered, arg_ty);
                            }
                        } else {
                            for &arg in &c.args {
                                self.infer_expr(arg);
                            }
                            self.emit_error(
                                self.arena[node].span(),
                                format!(
                                    "'{}' does not take arguments",
                                    self.interner.lookup(v.name)
                                ),
                            );
                        }
                        let resolved: Vec<TypeId> =
                            concrete_args.iter().map(|&a| self.resolve(a)).collect();
                        self.type_arena.intern(TypeKind::Custom {
                            name: enum_name,
                            args: resolved,
                        })
                    }
                    None => {
                        self.emit_error(
                            self.arena[node].span(),
                            format!("unknown variant '{}'", self.interner.lookup(call_name)),
                        );
                        self.type_arena.unknown_id()
                    }
                }
            }
            Expr::Var(v) => {
                let variant = variants.iter().find(|x| x.name == v.name);
                if variant.is_none() {
                    self.emit_error(
                        self.arena[node].span(),
                        format!("unknown variant '{}'", self.interner.lookup(v.name)),
                    );
                    self.type_arena.unknown_id()
                } else {
                    let resolved: Vec<TypeId> =
                        concrete_args.iter().map(|&a| self.resolve(a)).collect();
                    self.type_arena.intern(TypeKind::Custom {
                        name: enum_name,
                        args: resolved,
                    })
                }
            }
            _ => self.type_arena.unknown_id(),
        }
    }

    /// Infer the type of a function reference with a type annotation
    /// (e.g. `foo[Num]`). Finds the matching overload and records it
    /// in `inferred_defs` so the lowerer can emit the machine name.
    fn infer_typed_function_ref(
        &mut self,
        node: NodeId,
        v: &crate::ast::Var,
        t: &TypeAssociated,
    ) -> TypeId {
        let fn_name = v.name;
        let type_annotation = self.lower_type_node(&t.type_node);

        let scope = self
            .scope_tree
            .node_scope
            .get(&node)
            .copied()
            .unwrap_or(self.scope_tree.root_scope);

        // Collect def_nodes first to avoid borrow conflicts.
        let func_def_nodes: Vec<NodeId> = self
            .scope_tree
            .lookup_functions(scope, fn_name)
            .iter()
            .map(|sym| sym.def_node)
            .collect();

        for &def_node in &func_def_nodes {
            let func_type = self.function_type_from_def(def_node);
            if let TypeKind::Func { params, .. } = self.type_arena.get(func_type).clone() {
                if params.is_empty() {
                    continue;
                }
                // Check if the first parameter type matches the annotation
                let saved_diag_len = self.diagnostics.len();
                let unified = self.unify(params[0], type_annotation);
                if !matches!(self.type_arena.get(unified), TypeKind::Unknown) {
                    self.scope_tree.inferred_defs.insert(node, def_node);
                    return self.resolve(func_type);
                }
                self.diagnostics.truncate(saved_diag_len);
            }
        }

        // No matching overload found — fall back to regular inference
        self.infer_expr(t.inner)
    }
    fn find_enum(
        &self,
        from: ScopeId,
        name: IdentId,
    ) -> Option<(Vec<crate::ast::EnumVariant>, Vec<IdentId>)> {
        let mut current = from;
        loop {
            if let Some(ids) = self.scope_tree.scopes[current].symbols.get(&name) {
                for &sid in ids.iter().rev() {
                    if let SymbolKind::Enum {
                        type_params,
                        variants,
                    } = &self.scope_tree.symbols[sid].kind
                    {
                        return Some((variants.clone(), type_params.clone()));
                    }
                }
            }
            match self.scope_tree.scopes[current].parent {
                Some(parent) => current = parent,
                None => return None,
            }
        }
    }

    /// Lower a `TypeNode` to a `TypeId`, resolving `TypeParamRef` via
    /// an explicit generic parameter map.  Recurses into compound types.
    fn lower_type_node_with(
        &mut self,
        tn: &TypeNode,
        generic_params: &FxHashMap<IdentId, TypeId>,
    ) -> TypeId {
        match tn {
            TypeNode::Int => self.type_arena.int_id(),
            TypeNode::Num => self.type_arena.num_id(),
            TypeNode::Str => self.type_arena.str_id(),
            TypeNode::Bool => self.type_arena.bool_id(),
            TypeNode::Void => self.type_arena.void_id(),
            TypeNode::SelfType => self.type_arena.self_id(),
            TypeNode::TypeParamRef { name, traits } => {
                generic_params.get(name).copied().unwrap_or_else(|| {
                    self.type_arena.intern(TypeKind::Generic {
                        name: *name,
                        bounds: traits.clone(),
                    })
                })
            }
            TypeNode::Arr(inner) => {
                let inner_id = self.lower_type_node_with(inner, generic_params);
                self.type_arena.intern(TypeKind::Arr(inner_id))
            }
            TypeNode::Iter(inner) => {
                let inner_id = self.lower_type_node_with(inner, generic_params);
                self.type_arena.intern(TypeKind::Iter(inner_id))
            }
            TypeNode::MutArr(inner) => {
                let inner_id = self.lower_type_node_with(inner, generic_params);
                self.type_arena.intern(TypeKind::MutArr(inner_id))
            }
            TypeNode::Set(inner) => {
                let inner_id = self.lower_type_node_with(inner, generic_params);
                self.type_arena.intern(TypeKind::Set(inner_id))
            }
            TypeNode::MutSet(inner) => {
                let inner_id = self.lower_type_node_with(inner, generic_params);
                self.type_arena.intern(TypeKind::MutSet(inner_id))
            }
            TypeNode::Maybe(inner) => {
                let inner_id = self.lower_type_node_with(inner, generic_params);
                self.type_arena.intern(TypeKind::Maybe(inner_id))
            }
            TypeNode::Dict { key, val } => {
                let key_id = self.lower_type_node_with(key, generic_params);
                let val_id = self.lower_type_node_with(val, generic_params);
                self.type_arena.intern(TypeKind::Dict {
                    key: key_id,
                    val: val_id,
                })
            }
            TypeNode::MutDict { key, val } => {
                let key_id = self.lower_type_node_with(key, generic_params);
                let val_id = self.lower_type_node_with(val, generic_params);
                self.type_arena.intern(TypeKind::MutDict {
                    key: key_id,
                    val: val_id,
                })
            }
            TypeNode::Tup(elems) => {
                let elem_ids: Vec<_> = elems
                    .iter()
                    .map(|e| self.lower_type_node_with(e, generic_params))
                    .collect();
                self.type_arena.intern(TypeKind::Tuple(elem_ids))
            }
            TypeNode::Func { params, ret } => {
                let param_ids: Vec<_> = params
                    .iter()
                    .map(|p| self.lower_type_node_with(p, generic_params))
                    .collect();
                let ret_id = self.lower_type_node_with(ret, generic_params);
                self.type_arena.intern(TypeKind::Func {
                    params: param_ids,
                    ret: ret_id,
                })
            }
            TypeNode::Named { name, params } => {
                // If this name matches a generic parameter, resolve it.
                if params.is_empty()
                    && let Some(&tid) = generic_params.get(name)
                {
                    return tid;
                }
                let arg_ids: Vec<_> = params
                    .iter()
                    .map(|p| self.lower_type_node_with(p, generic_params))
                    .collect();
                self.type_arena.intern(TypeKind::Custom {
                    name: *name,
                    args: arg_ids,
                })
            }
        }
    }

    // ── Tuple unpack ──

    fn infer_tuple_unpack(&mut self, _node: NodeId, t: &TupleUnpack) -> TypeId {
        let source_ty = self.infer_expr(t.source);
        let expected: Vec<TypeId> = (0..t.bindings.len())
            .map(|_| self.fresh_infer_var())
            .collect();
        let expected_ty = self.type_arena.intern(TypeKind::Tuple(expected));
        self.unify(source_ty, expected_ty);
        source_ty
    }

    /// Build a `Func` type from a function definition node.
    /// Uses declared param types from the AST.
    /// For parameters whose type is a reference to a generic type param
    /// (e.g., `x: T` inside `func [T] id(x: T)`), creates an `InferVar`
    /// instead of a `Named`/`Custom` so that the param type can unify
    /// with concrete call args.
    fn function_type_from_def(&mut self, def_node: NodeId) -> TypeId {
        match &self.arena[def_node] {
            Expr::FuncDef(f) => {
                // Collect the names of generic type parameters for this function.
                let generic_names: Vec<IdentId> = f.type_params.iter().map(|tp| tp.name).collect();

                let params: Vec<TypeId> = f
                    .params
                    .iter()
                    .map(|p| {
                        if let Some(ref tn) = p.type_node {
                            // Check if this param's type is a reference to a type param
                            // (parsed as `TypeNode::Named { name: "T" }`).
                            let is_generic_ref = matches!(tn, TypeNode::Named { name, params } if generic_names.contains(name) && params.is_empty());
                            if is_generic_ref {
                                self.fresh_infer_var()
                            } else {
                                self.lower_type_node(tn)
                            }
                        } else {
                            self.fresh_infer_var()
                        }
                    })
                    .collect();
                let ret = self
                    .function_return_types
                    .get(&def_node)
                    .copied()
                    .or_else(|| {
                        f.return_type.as_ref().map(|tn| {
                            let is_generic_ref = matches!(tn, TypeNode::Named { name, params } if generic_names.contains(name) && params.is_empty());
                            if is_generic_ref {
                                self.fresh_infer_var()
                            } else {
                                self.lower_type_node(tn)
                            }
                        })
                    })
                    .unwrap_or_else(|| self.fresh_infer_var());
                self.type_arena.intern(TypeKind::Func { params, ret })
            }
            _ => self.type_arena.unknown_id(),
        }
    }

    // ── Type node lowering ──

    fn lower_type_node(&mut self, tn: &TypeNode) -> TypeId {
        match tn {
            TypeNode::Int => self.type_arena.int_id(),
            TypeNode::Num => self.type_arena.num_id(),
            TypeNode::Str => self.type_arena.str_id(),
            TypeNode::Bool => self.type_arena.bool_id(),
            TypeNode::Void => self.type_arena.void_id(),
            TypeNode::SelfType => self.type_arena.self_id(),
            TypeNode::TypeParamRef { name, traits } => self.type_arena.intern(TypeKind::Generic {
                name: *name,
                bounds: traits.clone(),
            }),
            TypeNode::Arr(inner) => {
                let inner_id = self.lower_type_node(inner);
                self.type_arena.intern(TypeKind::Arr(inner_id))
            }
            TypeNode::Iter(inner) => {
                let inner_id = self.lower_type_node(inner);
                self.type_arena.intern(TypeKind::Iter(inner_id))
            }
            TypeNode::MutArr(inner) => {
                let inner_id = self.lower_type_node(inner);
                self.type_arena.intern(TypeKind::MutArr(inner_id))
            }
            TypeNode::Set(inner) => {
                let inner_id = self.lower_type_node(inner);
                self.type_arena.intern(TypeKind::Set(inner_id))
            }
            TypeNode::MutSet(inner) => {
                let inner_id = self.lower_type_node(inner);
                self.type_arena.intern(TypeKind::MutSet(inner_id))
            }
            TypeNode::Maybe(inner) => {
                let inner_id = self.lower_type_node(inner);
                self.type_arena.intern(TypeKind::Maybe(inner_id))
            }
            TypeNode::Dict { key, val } => {
                let key_id = self.lower_type_node(key);
                let val_id = self.lower_type_node(val);
                self.type_arena.intern(TypeKind::Dict {
                    key: key_id,
                    val: val_id,
                })
            }
            TypeNode::MutDict { key, val } => {
                let key_id = self.lower_type_node(key);
                let val_id = self.lower_type_node(val);
                self.type_arena.intern(TypeKind::MutDict {
                    key: key_id,
                    val: val_id,
                })
            }
            TypeNode::Tup(elems) => {
                let elem_ids: Vec<_> = elems.iter().map(|e| self.lower_type_node(e)).collect();
                self.type_arena.intern(TypeKind::Tuple(elem_ids))
            }
            TypeNode::Func { params, ret } => {
                let param_ids: Vec<_> = params.iter().map(|p| self.lower_type_node(p)).collect();
                let ret_id = self.lower_type_node(ret);
                self.type_arena.intern(TypeKind::Func {
                    params: param_ids,
                    ret: ret_id,
                })
            }
            TypeNode::Named { name, params } => {
                let arg_ids: Vec<_> = params.iter().map(|p| self.lower_type_node(p)).collect();
                self.type_arena.intern(TypeKind::Custom {
                    name: *name,
                    args: arg_ids,
                })
            }
        }
    }
}

// ════════════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse;
    use crate::resolve::resolve_names;
    use crate::scan;
    use crate::source::{SourceMap, SourceText};

    /// Parse, resolve, and infer types for a source string.
    /// Panics on scan/parse/resolve errors.
    fn infer_types_map(
        source: &str,
    ) -> (
        AstArena,
        Interner,
        DiagnosticsBag,
        FxHashMap<NodeId, TypeId>,
        TypeArena,
        NodeId,
    ) {
        let src = SourceText::new("test.gema", source);
        let (tokens, sd) = scan::scan(&src, 0);
        let mut arena = AstArena::new();
        let mut interner = Interner::new();
        let mut diagnostics = DiagnosticsBag::new();
        for d in sd.into_vec() {
            diagnostics.push(d);
        }
        let root = parse::parse(&tokens, &mut arena, &mut interner, &mut diagnostics, 0);
        assert!(
            !diagnostics.has_errors(),
            "parse errors: {:?}",
            diagnostics.format(&SourceMap::new())
        );

        let mut scope_tree = resolve_names(&arena, root, &mut interner, &mut diagnostics, 0);
        assert!(
            !diagnostics.has_errors(),
            "resolve errors: {:?}",
            diagnostics.format(&SourceMap::new())
        );

        let mut type_arena = TypeArena::new();
        let types = infer_types(
            &arena,
            &mut scope_tree,
            &mut type_arena,
            &interner,
            root,
            &mut diagnostics,
            0,
        );
        (arena, interner, diagnostics, types, type_arena, root)
    }

    fn infer_diags(source: &str) -> DiagnosticsBag {
        let src = SourceText::new("test.gema", source);
        let (tokens, sd) = scan::scan(&src, 0);
        let mut arena = AstArena::new();
        let mut interner = Interner::new();
        let mut diagnostics = DiagnosticsBag::new();
        for d in sd.into_vec() {
            diagnostics.push(d);
        }
        let root = parse::parse(&tokens, &mut arena, &mut interner, &mut diagnostics, 0);
        if diagnostics.has_errors() {
            return diagnostics;
        }

        let mut scope_tree = resolve_names(&arena, root, &mut interner, &mut diagnostics, 0);
        if diagnostics.has_errors() {
            return diagnostics;
        }

        let mut type_arena = TypeArena::new();
        infer_types(
            &arena,
            &mut scope_tree,
            &mut type_arena,
            &interner,
            root,
            &mut diagnostics,
            0,
        );
        diagnostics
    }

    /// Get the type of the last (value) expression in the top-level block.
    fn last_expr_type<'a>(
        arena: &AstArena,
        root: NodeId,
        types: &FxHashMap<NodeId, TypeId>,
        _type_arena: &TypeArena,
    ) -> TypeId {
        let block = match &arena[root] {
            Expr::Block(b) => b,
            _ => panic!("expected Block"),
        };
        let last = block.stmts[block.stmts.len() - 1];
        let last_val = if let Expr::DropValue(dv) = &arena[last] {
            dv.child
        } else {
            last
        };
        *types.get(&last_val).expect("no type for last expression")
    }

    /// Get the inferred type of a function at a given index within the root program block
    fn func_body_type(
        arena: &AstArena,
        root: NodeId,
        types: &FxHashMap<NodeId, TypeId>,
        block_index: usize,
    ) -> TypeId {
        let block = match &arena[root] {
            Expr::Block(b) => b,
            _ => panic!("expected Block"),
        };
        let func_def = &arena[block.stmts[block_index]];
        let body = match func_def {
            Expr::FuncDef(f) => f.body,
            _ => panic!("expected FuncDef"),
        };
        *types.get(&body).expect("no type for function body")
    }

    // ── Literals ──

    #[test]
    fn int_literal() {
        let (arena, _interner, diags, types, ta, root) = infer_types_map("42i");
        assert!(
            !diags.has_errors(),
            "errors: {:?}",
            diags.format(&SourceMap::new())
        );
        let ty = last_expr_type(&arena, root, &types, &ta);
        assert_eq!(ta.get(ty), &TypeKind::Int);
    }

    #[test]
    fn num_literal() {
        let (arena, _interner, diags, types, ta, root) = infer_types_map("3.14");
        assert!(!diags.has_errors());
        let ty = last_expr_type(&arena, root, &types, &ta);
        assert_eq!(ta.get(ty), &TypeKind::Num);
    }

    #[test]
    fn str_literal() {
        let (arena, _interner, diags, types, ta, root) = infer_types_map("\"hello\"");
        assert!(!diags.has_errors());
        let ty = last_expr_type(&arena, root, &types, &ta);
        assert_eq!(ta.get(ty), &TypeKind::Str);
    }

    #[test]
    fn bool_literal_true() {
        let (arena, _interner, diags, types, ta, root) = infer_types_map("true");
        assert!(!diags.has_errors());
        let ty = last_expr_type(&arena, root, &types, &ta);
        assert_eq!(ta.get(ty), &TypeKind::Bool);
    }

    #[test]
    fn none_literal() {
        let (arena, _interner, diags, types, ta, root) = infer_types_map("none");
        assert!(!diags.has_errors());
        let ty = last_expr_type(&arena, root, &types, &ta);
        assert!(matches!(ta.get(ty), TypeKind::Maybe(_)));
    }

    #[test]
    fn none_with_annotation() {
        let (arena, _interner, diags, types, ta, root) = infer_types_map("none: Int");
        assert!(!diags.has_errors());
        let ty = last_expr_type(&arena, root, &types, &ta);
        match ta.get(ty) {
            TypeKind::Maybe(inner) => assert_eq!(ta.get(*inner), &TypeKind::Int),
            other => panic!("expected Maybe[Int], got {:?}", other),
        }
    }

    // ── Variables ──

    #[test]
    fn variable_decl_and_lookup() {
        let (arena, _interner, diags, types, ta, root) = infer_types_map("x = 42i; x");
        assert!(
            !diags.has_errors(),
            "errors: {:?}",
            diags.format(&SourceMap::new())
        );
        let ty = last_expr_type(&arena, root, &types, &ta);
        assert_eq!(ta.get(ty), &TypeKind::Int);
    }

    #[test]
    fn variable_decl_and_lookup_in_nested_scope() {
        let (arena, _interner, diags, types, ta, root) = infer_types_map("x = 42; { x }");
        assert!(
            !diags.has_errors(),
            "errors: {:?}",
            diags.format(&SourceMap::new())
        );
        let ty = last_expr_type(&arena, root, &types, &ta);
        assert_eq!(ta.get(ty), &TypeKind::Num);
    }

    #[test]
    fn variable_decl_and_shadowing_in_nested_scope() {
        let (arena, _interner, diags, types, ta, root) =
            infer_types_map("x = 42; { x = \"Hi\"; x }");
        assert!(
            !diags.has_errors(),
            "errors: {:?}",
            diags.format(&SourceMap::new())
        );
        let ty = last_expr_type(&arena, root, &types, &ta);
        assert_eq!(ta.get(ty), &TypeKind::Str);
    }

    #[test]
    fn reassign_immutable_variable_error() {
        // Reassignment to immutable is rejected at inference level.
        let (_arena, _interner, diags, _types, _ta, _root) = infer_types_map("x = 42; x = 0");
        assert!(
            diags.has_errors(),
            "inference should reject immutable reassignment: {:?}",
            diags.format(&SourceMap::new()),
        );
    }

    #[test]
    fn annotated_decl() {
        let (arena, _interner, diags, types, ta, root) = infer_types_map("x: Num = 42");
        assert!(!diags.has_errors());
        let ty = last_expr_type(&arena, root, &types, &ta);
        assert_eq!(ta.get(ty), &TypeKind::Num);
    }

    #[test]
    fn mutable_variable_decl_and_lookup() {
        let (arena, _interner, diags, types, ta, root) = infer_types_map("mut x = 42; x");
        assert!(
            !diags.has_errors(),
            "errors: {:?}",
            diags.format(&SourceMap::new())
        );
        let ty = last_expr_type(&arena, root, &types, &ta);
        assert_eq!(ta.get(ty), &TypeKind::Num);
    }

    #[test]
    fn mutable_variable_decl_and_reassignment() {
        let (arena, _interner, diags, types, ta, root) = infer_types_map("mut x = 0; x = 42");
        assert!(
            !diags.has_errors(),
            "errors: {:?}",
            diags.format(&SourceMap::new())
        );
        let ty = last_expr_type(&arena, root, &types, &ta);
        assert_eq!(ta.get(ty), &TypeKind::Num);
    }

    #[test]
    fn reassign_mutable_variable_incompatible_type_error() {
        let (_arena, _interner, diags, _types, _ta, _root) =
            infer_types_map("mut x = 42; x = \"Hi\"");
        assert!(
            diags.has_errors(),
            "should not be able to assign a mut variable a value with an incompatible type",
        );
    }

    #[test]
    fn reassign_mutable_variable_nested_scope_incompatible_type_error() {
        let (_arena, _interner, diags, _types, _ta, _root) =
            infer_types_map("mut x = 42; { x = \"Hi\" }");
        assert!(
            diags.has_errors(),
            "should not be able to assign a mut variable a value with an incompatible type",
        );
    }

    #[test]
    fn mutable_variable_shadowing() {
        let (arena, _interner, diags, types, ta, root) =
            infer_types_map("mut x = 0; { mut x = \"Hi\" }");
        assert!(
            !diags.has_errors(),
            "errors: {:?}",
            diags.format(&SourceMap::new())
        );
        let ty = last_expr_type(&arena, root, &types, &ta);
        assert_eq!(ta.get(ty), &TypeKind::Str);
    }

    #[test]
    fn reassign_mutable_parent_from_child_ok() {
        // Reassigning a parent's mutable variable from a child scope should succeed.
        let (arena, _interner, diags, types, ta, root) = infer_types_map("mut x = 0; { x = 5 }; x");
        assert!(
            !diags.has_errors(),
            "errors: {:?}",
            diags.format(&SourceMap::new()),
        );
        let ty = last_expr_type(&arena, root, &types, &ta);
        // After reassignment in child scope, the outer x should have type Num (from 5).
        assert_eq!(ta.get(ty), &TypeKind::Num);
    }

    // ── Binary operations ──

    #[test]
    fn binary_add_ints() {
        let (arena, _interner, diags, types, ta, root) = infer_types_map("1i + 2i");
        assert!(!diags.has_errors());
        let ty = last_expr_type(&arena, root, &types, &ta);
        assert_eq!(ta.get(ty), &TypeKind::Int);
    }

    #[test]
    fn binary_add_nums() {
        let (arena, _interner, diags, types, ta, root) = infer_types_map("1.5 + 2.5");
        assert!(!diags.has_errors());
        let ty = last_expr_type(&arena, root, &types, &ta);
        assert_eq!(ta.get(ty), &TypeKind::Num);
    }

    #[test]
    fn binary_comparison() {
        let (arena, _interner, diags, types, ta, root) = infer_types_map("1i == 2i");
        assert!(!diags.has_errors());
        let ty = last_expr_type(&arena, root, &types, &ta);
        assert_eq!(ta.get(ty), &TypeKind::Bool);
    }

    #[test]
    fn binary_and_or() {
        let (arena, _interner, diags, types, ta, root) = infer_types_map("true and false or true");
        assert!(!diags.has_errors());
        let ty = last_expr_type(&arena, root, &types, &ta);
        assert_eq!(ta.get(ty), &TypeKind::Bool);
    }

    // ── Type errors ──

    #[test]
    fn add_int_to_num_error() {
        // Int and Num are different types — mixing them requires an
        // explicit conversion (toNum, toInt).
        let diags = infer_diags("1i + 2.5");
        assert!(diags.has_errors(), "Int + Num should be a type error");
    }

    #[test]
    fn add_str_to_num_error() {
        let diags = infer_diags("\"hello\" + 1");
        assert!(diags.has_errors(), "should produce type error");
    }

    #[test]
    fn comparison_mismatch() {
        let diags = infer_diags("1i == \"hello\"");
        assert!(diags.has_errors(), "should produce type error");
    }

    #[test]
    fn and_with_int_error() {
        let diags = infer_diags("1i and true");
        assert!(diags.has_errors());
    }

    #[test]
    fn or_with_int_error() {
        let diags = infer_diags("true or 1i");
        assert!(diags.has_errors());
    }

    // ── Unary ──

    #[test]
    fn unary_neg() {
        let (arena, _interner, diags, types, ta, root) = infer_types_map("-42i");
        assert!(!diags.has_errors());
        let ty = last_expr_type(&arena, root, &types, &ta);
        assert_eq!(ta.get(ty), &TypeKind::Int);
    }

    #[test]
    fn unary_not() {
        let (arena, _interner, diags, types, ta, root) = infer_types_map("!true");
        assert!(!diags.has_errors());
        let ty = last_expr_type(&arena, root, &types, &ta);
        assert_eq!(ta.get(ty), &TypeKind::Bool);
    }

    // ── Blocks ──

    #[test]
    fn block_last_expr_type() {
        let (arena, _interner, diags, types, ta, root) = infer_types_map("{ 1i; 2i; 3i }");
        assert!(!diags.has_errors());
        let ty = last_expr_type(&arena, root, &types, &ta);
        assert_eq!(ta.get(ty), &TypeKind::Int);
    }

    #[test]
    fn block_dropped_value_is_null() {
        let (arena, _interner, diags, types, ta, root) = infer_types_map("{ 1i; }");
        assert!(!diags.has_errors());
        let ty = last_expr_type(&arena, root, &types, &ta);
        assert_eq!(ta.get(ty), &TypeKind::Void);
    }

    // ── If ──

    #[test]
    fn if_expr() {
        let (arena, _interner, diags, types, ta, root) =
            infer_types_map("if true { 1i } else { 2i }");
        assert!(!diags.has_errors());
        let ty = last_expr_type(&arena, root, &types, &ta);
        assert_eq!(ta.get(ty), &TypeKind::Int);
    }

    #[test]
    fn if_expr_with_else_if() {
        let (arena, _interner, diags, types, ta, root) =
            infer_types_map("if true { 1 } else if false { 2 } else { 3 }");
        assert!(!diags.has_errors());
        let ty = last_expr_type(&arena, root, &types, &ta);
        assert_eq!(ta.get(ty), &TypeKind::Num);
    }

    #[test]
    fn if_branches_mismatch_error() {
        let diags = infer_diags("if true { 1i } else { \"hello\" }");
        assert!(
            diags.has_errors(),
            "should produce type error: if branches mismatch"
        );
    }

    #[test]
    fn if_with_else_if_branches_mismatch_error() {
        let diags = infer_diags("if true { 1 } else if false { \"hello\" } else { 2 }");
        assert!(
            diags.has_errors(),
            "should produce type error: if branches mismatch"
        );
    }

    #[test]
    fn if_without_else() {
        let (arena, _interner, diags, types, ta, root) = infer_types_map("if true { 1 }");
        assert!(!diags.has_errors());
        let ty = last_expr_type(&arena, root, &types, &ta);
        assert_eq!(ta.get(ty), &TypeKind::Void);
    }

    #[test]
    fn if_with_else_if_without_else() {
        let (arena, _interner, diags, types, ta, root) =
            infer_types_map("if true { 1 } else if false { 2 }");
        assert!(!diags.has_errors());
        let ty = last_expr_type(&arena, root, &types, &ta);
        assert_eq!(ta.get(ty), &TypeKind::Void);
    }

    // ── Functions ──

    #[test]
    fn named_func_call() {
        let (arena, _interner, diags, types, ta, root) =
            infer_types_map("func add(x: Int, y: Int): Int { x + y }; add(1i, 2i)");
        assert!(
            !diags.has_errors(),
            "errors: {:?}",
            diags.format(&SourceMap::new())
        );
        let ty = last_expr_type(&arena, root, &types, &ta);
        assert_eq!(ta.get(ty), &TypeKind::Int);
    }

    #[test]
    fn function_definition() {
        let (arena, _interner, diags, types, ta, root) =
            infer_types_map("func add(x: Int, y: Int): Int { x + y }");
        assert!(
            !diags.has_errors(),
            "errors: {:?}",
            diags.format(&SourceMap::new())
        );
        let ty = last_expr_type(&arena, root, &types, &ta);
        assert_eq!(ta.get(ty), &TypeKind::Void);
    }

    #[test]
    fn function_body_type_error() {
        let diags = infer_diags("func add(x: Int, y: Int): Int { x + \"hello\" }");
        assert!(
            diags.has_errors(),
            "type error in function body should be caught"
        );
    }

    #[test]
    fn function_return_type_mismatch() {
        let diags = infer_diags("func add(x: Int, y: Int): Int { \"hello\" }");
        assert!(diags.has_errors(), "return type mismatch should be caught");
    }

    #[test]
    fn function_inferred_return_type_no_annotation() {
        // Without an explicit return type annotation, the return type
        // is inferred from the body.
        let (arena, _interner, diags, types, ta, root) =
            infer_types_map("func add(x: Int, y: Int) { x + y }");
        assert!(
            !diags.has_errors(),
            "inferred return type from body should not error: {:?}",
            diags.format(&SourceMap::new()),
        );
        let body_ty = func_body_type(&arena, root, &types, 0);
        assert_eq!(ta.get(body_ty), &TypeKind::Int, "body should be Int");
    }

    #[test]
    fn function_inferred_return_type_from_return_stmt() {
        // Return type can also be inferred from a return statement.
        let (_arena, _interner, diags, _types, _ta, _root) =
            infer_types_map("func five(): Int { 5i }");
        assert!(
            !diags.has_errors(),
            "explicit return type matching body should not error: {:?}",
            diags.format(&SourceMap::new()),
        );
    }

    #[test]
    fn call_inferred_return_type_no_annotation() {
        // Function without explicit return type — call site should
        // still see the inferred return type from the body.
        let (arena, _interner, diags, types, ta, root) =
            infer_types_map("func add(x: Int, y: Int) { x + y }; add(1i, 2i)");
        assert!(
            !diags.has_errors(),
            "errors: {:?}",
            diags.format(&SourceMap::new()),
        );
        let ty = last_expr_type(&arena, root, &types, &ta);
        assert_eq!(
            ta.get(ty),
            &TypeKind::Int,
            "call site should see inferred Int return type"
        );
    }

    #[test]
    fn function_inferred_return_type_with_shadowing_argument() {
        // Function arg takes precedence over variable with same name in
        // enclosing scope
        let (arena, _interner, diags, types, ta, root) =
            infer_types_map("mut x = 1i; func add(x: Num) { x }");
        assert!(
            !diags.has_errors(),
            "inferred return type from body should not error: {:?}",
            diags.format(&SourceMap::new()),
        );
        let body_ty = func_body_type(&arena, root, &types, 1);
        assert_eq!(ta.get(body_ty), &TypeKind::Num, "body should be Num");
    }

    #[test]
    fn function_captures_variable_from_outer_scope() {
        // Function arg takes precedence over variable with same name in
        // enclosing scope
        let (arena, _interner, diags, types, ta, root) =
            infer_types_map("x = 1; func addX(y: Num) { x + y }");
        assert!(
            !diags.has_errors(),
            "inferred return type from body should not error: {:?}",
            diags.format(&SourceMap::new()),
        );
        let body_ty = func_body_type(&arena, root, &types, 1);
        assert_eq!(ta.get(body_ty), &TypeKind::Num, "body should be Num");
    }

    // ── Arrays ──

    #[test]
    fn array_lit() {
        let (arena, _interner, diags, types, ta, root) = infer_types_map("[1i, 2i, 3i]");
        assert!(!diags.has_errors());
        let ty = last_expr_type(&arena, root, &types, &ta);
        match ta.get(ty) {
            TypeKind::Arr(inner) => assert_eq!(ta.get(*inner), &TypeKind::Int),
            other => panic!("expected Arr[Int], got {:?}", other),
        }
    }

    // ── Tuples ──

    #[test]
    fn tuple_lit() {
        let (arena, _interner, diags, types, ta, root) = infer_types_map("(1i, \"hello\", true)");
        assert!(!diags.has_errors());
        let ty = last_expr_type(&arena, root, &types, &ta);
        match ta.get(ty) {
            TypeKind::Tuple(elems) => {
                assert_eq!(elems.len(), 3);
                assert_eq!(ta.get(elems[0]), &TypeKind::Int);
                assert_eq!(ta.get(elems[1]), &TypeKind::Str);
                assert_eq!(ta.get(elems[2]), &TypeKind::Bool);
            }
            other => panic!("expected Tup[Int, Str, Bool], got {:?}", other),
        }
    }

    // ── Ranges ──

    // ── Enum variants ──

    #[test]
    fn enum_variant_with_explicit_type_args() {
        let src = "enum Option[T] { some: T, nothing }; Option[Int]::some(42i)";
        let (arena, _interner, diags, types, ta, root) = infer_types_map(src);
        assert!(
            !diags.has_errors(),
            "errors: {:?}",
            diags.format(&SourceMap::new())
        );
        let ty = last_expr_type(&arena, root, &types, &ta);
        match ta.get(ty) {
            TypeKind::Custom { args, .. } => {
                assert_eq!(args.len(), 1);
                assert_eq!(ta.get(args[0]), &TypeKind::Int);
            }
            other => panic!("expected Custom, got {:?}", other),
        }
    }

    #[test]
    fn enum_variant_plain_no_type_args() {
        let src = "enum Color { red, green, blue }; Color::red";
        let (_arena, _interner, diags, _types, _ta, _root) = infer_types_map(src);
        assert!(
            !diags.has_errors(),
            "errors: {:?}",
            diags.format(&SourceMap::new())
        );
    }

    #[test]
    fn enum_variant_inferred_type_args() {
        let src = "enum Option[T] { some: T, nothing }; Option::some(42i)";
        let (arena, _interner, diags, types, ta, root) = infer_types_map(src);
        assert!(
            !diags.has_errors(),
            "errors: {:?}",
            diags.format(&SourceMap::new())
        );
        let ty = last_expr_type(&arena, root, &types, &ta);
        match ta.get(ty) {
            TypeKind::Custom { args, .. } => {
                assert_eq!(args.len(), 1);
                assert_eq!(ta.get(args[0]), &TypeKind::Int);
            }
            other => panic!("expected Custom, got {:?}", other),
        }
    }

    #[test]
    fn enum_variant_multi_type_args() {
        let src = "enum Result[T, E] { ok: T, err: E }; Result::ok(42i)";
        let (arena, _interner, diags, types, ta, root) = infer_types_map(src);
        assert!(
            !diags.has_errors(),
            "errors: {:?}",
            diags.format(&SourceMap::new())
        );
        let ty = last_expr_type(&arena, root, &types, &ta);
        match ta.get(ty) {
            TypeKind::Custom { args, .. } => {
                assert_eq!(args.len(), 2, "Result should have 2 type args");
                assert_eq!(ta.get(args[0]), &TypeKind::Int);
            }
            other => panic!("expected Custom, got {:?}", other),
        }
    }

    #[test]
    fn enum_variant_multi_type_args_second() {
        let src = "enum Result[T, E] { ok: T, err: E }; Result::err(\"oops\")";
        let (arena, _interner, diags, types, ta, root) = infer_types_map(src);
        assert!(
            !diags.has_errors(),
            "errors: {:?}",
            diags.format(&SourceMap::new())
        );
        let ty = last_expr_type(&arena, root, &types, &ta);
        match ta.get(ty) {
            TypeKind::Custom { args, .. } => {
                assert_eq!(args.len(), 2);
                assert_eq!(ta.get(args[1]), &TypeKind::Str);
            }
            other => panic!("expected Custom, got {:?}", other),
        }
    }

    #[test]
    fn enum_variant_unknown_name_error() {
        let src = "enum Option[T] { some: T, nothing }; Option::missing(1)";
        let diags = infer_diags(src);
        assert!(
            diags.has_errors(),
            "unknown enum variant should produce an error"
        );
    }

    #[test]
    fn enum_variant_plain_called_with_args_error() {
        let src = "enum Color { red, green, blue }; Color::red(1)";
        let diags = infer_diags(src);
        assert!(
            diags.has_errors(),
            "plain variant called with args should produce an error"
        );
    }

    // ── Struct field access ──

    #[test]
    fn struct_field_access() {
        let src = "struct Point { x: Num, y: Num }; p = Point(1, 2); p.x";
        let (arena, _interner, diags, types, ta, root) = infer_types_map(src);
        assert!(
            !diags.has_errors(),
            "errors: {:?}",
            diags.format(&SourceMap::new())
        );
        let ty = last_expr_type(&arena, root, &types, &ta);
        assert_eq!(ta.get(ty), &TypeKind::Num);
    }

    #[test]
    fn struct_field_access_generic() {
        let src = "struct Pair[T] { a: T, b: T }; p = Pair(1i, 2i); p.a";
        let (arena, _interner, diags, types, ta, root) = infer_types_map(src);
        assert!(
            !diags.has_errors(),
            "errors: {:?}",
            diags.format(&SourceMap::new())
        );
        let ty = last_expr_type(&arena, root, &types, &ta);
        assert_eq!(ta.get(ty), &TypeKind::Int);
    }

    #[test]
    fn struct_field_access_unknown_field() {
        let src = "struct Point { x: Num, y: Num }; p = Point(1, 2); p.z";
        let diags = infer_diags(src);
        assert!(diags.has_errors(), "accessing unknown field should error");
    }

    #[test]
    fn struct_field_assign() {
        let src = "struct Point { mut x: Num, y: Num }; p = Point(1, 2); p.x = 5";
        let (_arena, _interner, diags, _types, _ta, _root) = infer_types_map(src);
        assert!(
            !diags.has_errors(),
            "errors: {:?}",
            diags.format(&SourceMap::new())
        );
    }

    #[test]
    fn range_iter() {
        let (arena, _interner, diags, types, ta, root) = infer_types_map("1i..10i");
        assert!(!diags.has_errors());
        let ty = last_expr_type(&arena, root, &types, &ta);
        match ta.get(ty) {
            TypeKind::Iter(inner) => assert_eq!(ta.get(*inner), &TypeKind::Int),
            other => panic!("expected Iter[Int], got {:?}", other),
        }
    }

    // ── Match ──

    #[test]
    fn match_expr() {
        let src = "x: Maybe[Int] = none: Int; match x { some(v) -> v, none -> 0i, else -> -1i }";
        let (arena, _interner, diags, types, ta, root) = infer_types_map(src);
        assert!(
            !diags.has_errors(),
            "errors: {:?}",
            diags.format(&SourceMap::new())
        );
        let ty = last_expr_type(&arena, root, &types, &ta);
        assert_eq!(ta.get(ty), &TypeKind::Int);
    }

    // ── Lambda ──

    #[test]
    fn variable_symbol_type_populated() {
        let src = SourceText::new("test.gema", "x = 42i; y = \"hello\"");
        let (tokens, sd) = scan::scan(&src, 0);
        assert!(!sd.has_errors());
        let mut arena = AstArena::new();
        let mut interner = Interner::new();
        let mut diagnostics = DiagnosticsBag::new();
        for d in sd.into_vec() {
            diagnostics.push(d);
        }
        let root = parse::parse(&tokens, &mut arena, &mut interner, &mut diagnostics, 0);
        assert!(!diagnostics.has_errors());
        let mut scope_tree = resolve_names(&arena, root, &mut interner, &mut diagnostics, 0);
        assert!(!diagnostics.has_errors());

        let mut type_arena = TypeArena::new();
        let _types = infer_types(
            &arena,
            &mut scope_tree,
            &mut type_arena,
            &interner,
            root,
            &mut diagnostics,
            0,
        );
        assert!(
            !diagnostics.has_errors(),
            "errors: {:?}",
            diagnostics.format(&SourceMap::new())
        );

        // Verify symbol types are populated.
        let mut found_x = false;
        let mut found_y = false;
        for (_, sym) in scope_tree.symbols.iter() {
            match &sym.kind {
                SymbolKind::Variable {
                    type_id: Some(tid), ..
                } => {
                    let name = interner.lookup(sym.name);
                    match name {
                        "x" => {
                            assert_eq!(type_arena.get(*tid), &TypeKind::Int, "x should be Int");
                            found_x = true;
                        }
                        "y" => {
                            assert_eq!(type_arena.get(*tid), &TypeKind::Str, "y should be Str");
                            found_y = true;
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
        assert!(found_x, "x symbol not found with populated type");
        assert!(found_y, "y symbol not found with populated type");
    }

    #[test]
    fn impl_block_type_check_members() {
        let src = "trait HasZero { zero: Func[Self: Self] }; impl Int: HasZero { func zero(): Int { 0i } }";
        let (_arena, _interner, diags, _types, _ta, _root) = infer_types_map(src);
        assert!(
            !diags.has_errors(),
            "impl block member should type-check: {:?}",
            diags.format(&SourceMap::new()),
        );
    }

    #[test]
    fn lambda_infers_param_type() {
        // When used in a call, lambda params are inferred from the
        // function signature.  Here we just test basic lambda inference.
        let (arena, _interner, diags, types, ta, root) = infer_types_map("\\x -> x + 1i");
        assert!(
            !diags.has_errors(),
            "errors: {:?}",
            diags.format(&SourceMap::new())
        );
        let ty = last_expr_type(&arena, root, &types, &ta);
        assert!(matches!(ta.get(ty), TypeKind::Func { .. }));
    }

    // ── For loop ──

    #[test]
    fn for_loop() {
        let src = "for x = 1i..10i { x }";
        let (arena, _interner, diags, types, ta, root) = infer_types_map(src);
        assert!(
            !diags.has_errors(),
            "errors: {:?}",
            diags.format(&SourceMap::new())
        );
        let ty = last_expr_type(&arena, root, &types, &ta);
        assert_eq!(ta.get(ty), &TypeKind::Void);
    }
}
