/// Name resolution pass for Gema.
///
/// Walks the AST, builds a scope tree, registers every definition,
/// and resolves every name reference to the `SymbolId` it refers to.
/// This pass operates solely on names — no type information is used.
use crate::ast::*;
use crate::builtins::BuiltinFunc;
use crate::diagnostics::DiagnosticsBag;
use crate::interner::{IdentId, Interner};
use crate::source::Span;
use crate::symbol::{ScopeId, ScopeTree, SymbolId, SymbolKind};

/// Perform name resolution on a parsed AST.
///
/// Every identifier is resolved to a `SymbolId` in the returned
/// `ScopeTree`.  Errors (undefined names, break/continue outside
/// loops) are pushed to `diagnostics`.
/// Perform name resolution on a parsed AST, starting from a
/// pre-populated scope tree (used by the module linker).
///
/// The `scope_tree` already contains imported symbols from dependency
/// modules.  This function resolves the module's own definitions and
/// name references against both imports and local definitions.
pub fn resolve_names_in_context(
    arena: &AstArena,
    root: NodeId,
    interner: &mut Interner,
    diagnostics: &mut DiagnosticsBag,
    file_idx: usize,
    scope_tree: ScopeTree,
) -> ScopeTree {
    let mut resolver = Resolver::new_with_scope(arena, interner, diagnostics, file_idx, scope_tree);
    resolver.current_scope = resolver.scope_tree.root_scope;
    resolver.resolve_node(root);
    resolver.finish()
}

/// Perform name resolution on a parsed AST.
///
/// Every identifier is resolved to a `SymbolId` in the returned
/// `ScopeTree`.  Errors (undefined names, break/continue outside
/// loops) are pushed to `diagnostics`.
pub fn resolve_names(
    arena: &AstArena,
    root: NodeId,
    interner: &mut Interner,
    diagnostics: &mut DiagnosticsBag,
    file_idx: usize,
) -> ScopeTree {
    let mut resolver = Resolver::new(arena, interner, diagnostics, file_idx);
    resolver.current_scope = resolver.scope_tree.root_scope;
    resolver.resolve_node(root);
    resolver.finish()
}

struct Resolver<'a> {
    arena: &'a AstArena,
    interner: &'a mut Interner,
    diagnostics: &'a mut DiagnosticsBag,
    file_idx: usize,
    scope_tree: ScopeTree,
    current_scope: ScopeId,
    /// Stack of loop scopes (for break/continue validation).
    loop_stack: Vec<ScopeId>,
}

impl<'a> Resolver<'a> {
    fn new(
        arena: &'a AstArena,
        interner: &'a mut Interner,
        diagnostics: &'a mut DiagnosticsBag,
        file_idx: usize,
    ) -> Self {
        let scope_tree = ScopeTree::new();
        let root_scope = scope_tree.root_scope;
        Self {
            arena,
            interner,
            diagnostics,
            file_idx,
            scope_tree,
            current_scope: root_scope,
            loop_stack: Vec::new(),
        }
    }

    /// Create a resolver with an existing (pre-populated) scope tree.
    /// Used by the module linker to start resolution with imports
    /// already injected into the root scope.
    fn new_with_scope(
        arena: &'a AstArena,
        interner: &'a mut Interner,
        diagnostics: &'a mut DiagnosticsBag,
        file_idx: usize,
        scope_tree: ScopeTree,
    ) -> Self {
        let current_scope = scope_tree.root_scope;
        Self {
            arena,
            interner,
            diagnostics,
            file_idx,
            scope_tree,
            current_scope,
            loop_stack: Vec::new(),
        }
    }

    fn finish(self) -> ScopeTree {
        self.scope_tree
    }

    // ── Scope management ──

    /// Run `f` in a new child scope of `self.current_scope`.
    fn with_child_scope<F>(&mut self, f: F)
    where
        F: FnOnce(&mut Self),
    {
        let child = self.scope_tree.alloc_scope(self.current_scope);
        let parent = self.current_scope;
        self.current_scope = child;
        f(self);
        self.current_scope = parent;
    }

    /// Record that `node` belongs to the current scope.
    fn record_scope(&mut self, node: NodeId) {
        self.scope_tree.node_scope.insert(node, self.current_scope);
    }

    /// Define a symbol in the current scope.
    fn define(&mut self, name: IdentId, kind: SymbolKind, def_node: NodeId) -> SymbolId {
        // Only check for duplicates in the CURRENT scope, not parents
        // (parent scopes may have the same name — that's shadowing, not
        // a duplicate).
        if self.scope_tree.scopes[self.current_scope]
            .symbols
            .contains_key(&name)
        {
            let span = self.arena[def_node].span();
            self.diagnostics.error(
                self.file_idx,
                span,
                format!("duplicate definition of '{}'", self.interner.lookup(name)),
            );
        }

        self.scope_tree
            .define(self.current_scope, name, kind, def_node)
    }

    // ── Dispatch ──

    fn resolve_node(&mut self, node: NodeId) {
        match &self.arena[node] {
            Expr::Block(b) => self.resolve_block(node, b),
            Expr::FuncDef(f) => self.resolve_func_def(node, f),
            Expr::AnonFunc(a) => self.resolve_anon_func(node, a),
            Expr::StructDef(s) => self.resolve_struct_def(node, s),
            Expr::EnumDef(e) => self.resolve_enum_def(node, e),
            Expr::TraitDef(t) => self.resolve_trait_def(node, t),
            Expr::ImplBlock(i) => self.resolve_impl_block(node, i),
            Expr::Assign(a) => self.resolve_assign(node, a),
            Expr::TupleUnpack(t) => self.resolve_tuple_unpack(node, t),
            Expr::ForLoop(f) => self.resolve_for_loop(node, f),
            Expr::Var(v) => self.resolve_var(node, v),
            Expr::Call(c) => self.resolve_call(node, c),
            Expr::Match(m) => self.resolve_match(node, m),
            Expr::Break(b) => self.resolve_break(node, b),
            Expr::Continue(c) => self.resolve_continue(node, c),
            Expr::Return(r) => self.resolve_return(node, r),
            Expr::FieldAccess(f) => self.resolve_field_access(node, f),
            Expr::FieldAssign(f) => self.resolve_field_assign(node, f),
            Expr::If(i) => self.resolve_if(node, i),
            Expr::Binary(b) => self.resolve_binary(node, b),
            Expr::Unary(u) => self.resolve_unary(node, u),
            Expr::TypeAssociated(t) => self.resolve_type_associated(node, t),
            Expr::DropValue(d) => self.resolve_node(d.child),
            Expr::ArrLit(a) => self.resolve_array(node, a),
            Expr::TupleLit(t) => self.resolve_tuple_lit(node, t),
            Expr::RangeIter(r) => self.resolve_range(node, r),
            Expr::Use(_) | Expr::UseJs(_) | Expr::NoneLit(_) | Expr::ErrorExpr => {
                self.record_scope(node);
            }
            // Literals — just record scope
            Expr::IntLit(_) | Expr::NumLit(_) | Expr::StrLit(_) | Expr::BoolLit(_) => {
                self.record_scope(node);
            }
        }
    }

    // ── Block ──

    fn resolve_block(&mut self, node: NodeId, block: &Block) {
        self.with_child_scope(|resolver| {
            resolver.record_scope(node);
            for &stmt in &block.stmts {
                resolver.resolve_node(stmt);
            }
        });
    }

    // ── Function definitions ──

    fn resolve_func_def(&mut self, node: NodeId, f: &FuncDef) {
        self.record_scope(node);

        // Register the function name in the enclosing scope BEFORE resolving
        // the body, enabling recursion.
        self.define(
            f.name,
            SymbolKind::Function {
                full_name: None,
                is_generic: !f.type_params.is_empty(),
                param_count: f.params.len(),
                type_param_count: f.type_params.len(),
                cached_signature: None,
                cached_type_params: None,
            },
            node,
        );

        // Pre-compute trait method registrations while we have
        // access to the enclosing scope, before entering the child scope.
        let mut trait_methods: Vec<(IdentId, SymbolKind)> = Vec::new();
        for tp in &f.type_params {
            for trait_name in &tp.traits {
                // Look up the trait definition in the current scope.
                if let Some((_, sid)) = self.scope_tree.lookup(self.current_scope, *trait_name) {
                    let sym = &self.scope_tree.symbols[sid];
                    if let SymbolKind::Trait { requirements } = &sym.kind {
                        for req in requirements {
                            trait_methods.push((
                                req.name,
                                SymbolKind::TraitMethod {
                                    trait_name: *trait_name,
                                    type_param: tp.name,
                                    signature: Box::new(req.type_node.clone()),
                                },
                            ));
                        }
                    }
                }
            }
        }

        // Create a scope for the function body.
        self.with_child_scope(|resolver| {
            // Register type parameters as TypeParam symbols.
            for tp in &f.type_params {
                resolver.define(
                    tp.name,
                    SymbolKind::TypeParam {
                        bounds: tp.traits.clone(),
                    },
                    node,
                );
            }

            // Register pre-computed trait methods as callable symbols.
            for (name, kind) in &trait_methods {
                resolver.define(*name, kind.clone(), node);
            }

            // Register parameters as Variable symbols.
            for param in &f.params {
                resolver.define(
                    param.name,
                    SymbolKind::Variable {
                        type_id: None,
                        is_mut: false,
                    },
                    node,
                );
            }

            // Resolve the body.
            resolver.resolve_node(f.body);
        });

        // Check that all type parameters are used in at least one function argument.
        for tp in &f.type_params {
            let used = f.params.iter().any(|p| {
                p.type_node
                    .as_ref()
                    .is_some_and(|tn| self.type_node_refers_to_name(tn, tp.name))
            });
            if !used {
                self.diagnostics.error(
                    self.file_idx,
                    self.arena[node].span(),
                    format!(
                        "type parameter '{}' is not used in any function argument",
                        self.interner.lookup(tp.name)
                    ),
                );
            }
        }
    }

    fn resolve_anon_func(&mut self, node: NodeId, a: &AnonFunc) {
        self.record_scope(node);

        self.with_child_scope(|resolver| {
            for param in &a.params {
                resolver.define(
                    param.name,
                    SymbolKind::Variable {
                        type_id: None,
                        is_mut: false,
                    },
                    node,
                );
            }
            resolver.resolve_node(a.body);
        });
    }

    // ── Type definitions ──

    fn resolve_struct_def(&mut self, node: NodeId, s: &StructDef) {
        self.record_scope(node);
        self.define(
            s.name,
            SymbolKind::Struct {
                type_params: s.type_params.iter().map(|tp| tp.name).collect(),
                cached_fields: None,
            },
            node,
        );
    }

    fn resolve_enum_def(&mut self, node: NodeId, e: &EnumDef) {
        self.record_scope(node);
        self.define(
            e.name,
            SymbolKind::Enum {
                type_params: e.type_params.iter().map(|tp| tp.name).collect(),
                variants: e.variants.clone(),
            },
            node,
        );
    }

    fn resolve_trait_def(&mut self, node: NodeId, t: &TraitDef) {
        self.record_scope(node);
        self.define(
            t.name,
            SymbolKind::Trait {
                requirements: t.requirements.clone(),
            },
            node,
        );
    }

    // ── Impl block ──

    fn resolve_impl_block(&mut self, node: NodeId, i: &ImplBlock) {
        self.record_scope(node);

        // Register an `Impl` symbol so the monomorphizer can find it
        // via scope-tree iteration.
        let impl_name = self.mangle_impl_name(i);
        let impl_name_id = self.interner.intern(&impl_name);
        self.define(
            impl_name_id,
            SymbolKind::Impl {
                trait_name: i.trait_name,
                self_type: i.self_type.clone(),
                member_nodes: i.members.clone(),
            },
            node,
        );

        // Create a scope for the impl's members where `Self` is bound
        // to the implementing type.
        self.with_child_scope(|resolver| {
            // Register `Self` as a special symbol so it can be referenced
            // in function bodies inside the impl block.
            let self_name = resolver.interner.intern("Self");
            resolver.define(
                self_name,
                SymbolKind::TypeParam { bounds: Vec::new() },
                node,
            );

            for &member in &i.members {
                resolver.resolve_node(member);
            }
        });
    }

    /// Generate a unique mangled name for an impl block to avoid
    /// collision with the corresponding trait symbol.
    fn mangle_impl_name(&self, i: &ImplBlock) -> String {
        let trait_name = self.interner.lookup(i.trait_name);
        let type_desc = self.type_node_desc(&i.self_type);
        format!("$impl_{type_desc}_{trait_name}")
    }

    /// Produce a short type descriptor string from a TypeNode for
    /// impl name mangling.
    fn type_node_desc(&self, ty: &TypeNode) -> String {
        match ty {
            TypeNode::Int => "Int".to_string(),
            TypeNode::Num => "Num".to_string(),
            TypeNode::Str => "Str".to_string(),
            TypeNode::Bool => "Bool".to_string(),
            TypeNode::Void => "Void".to_string(),
            TypeNode::SelfType => "Self".to_string(),
            TypeNode::Named { name, params } => {
                let base = self.interner.lookup(*name);
                if params.is_empty() {
                    base.to_string()
                } else {
                    let params_str: Vec<String> =
                        params.iter().map(|p| self.type_node_desc(p)).collect();
                    format!("{base}_{}", params_str.join("_"))
                }
            }
            TypeNode::Func { .. } => "Func".to_string(),
            TypeNode::Arr(..) => "Arr".to_string(),
            TypeNode::Iter(..) => "Iter".to_string(),
            TypeNode::MutArr(..) => "MutArr".to_string(),
            TypeNode::Tup(..) => "Tup".to_string(),
            TypeNode::Dict { .. } => "Dict".to_string(),
            TypeNode::MutDict { .. } => "MutDict".to_string(),
            TypeNode::Set(..) => "Set".to_string(),
            TypeNode::MutSet(..) => "MutSet".to_string(),
            TypeNode::Maybe(..) => "Maybe".to_string(),
            TypeNode::TypeParamRef { name, .. } => self.interner.lookup(*name).to_string(),
        }
    }

    // ── Variable definitions and assignments ──

    fn resolve_assign(&mut self, node: NodeId, a: &Assign) {
        self.record_scope(node);
        self.resolve_node(a.value);

        let name = a.name;
        let is_mut = a.is_mut;

        // Helper: produce an error when assigning to a non-variable name.
        let error_not_variable = |resolver: &mut Self, span: Span, name: IdentId| {
            let name_str = resolver.interner.lookup(name);
            resolver.diagnostics.error(
                resolver.file_idx,
                span,
                format!("cannot assign to '{name_str}' — it is not a variable"),
            );
        };

        // 1. Name in current scope → reassignment.
        if let Some(&sid) = self
            .scope_tree
            .scopes
            .get(self.current_scope)
            .and_then(|s| s.symbols.get(&name))
        {
            // If existing symbol with this name is NOT a Variable, error.
            if !matches!(
                self.scope_tree.symbols[sid].kind,
                SymbolKind::Variable { .. }
            ) {
                let span = self.arena[node].span();
                error_not_variable(self, span, name);
                return;
            }

            if is_mut {
                let span = self.arena[node].span();
                self.diagnostics.error(
                    self.file_idx,
                    span,
                    format!(
                        "cannot use 'mut' on reassignment of '{}'",
                        self.interner.lookup(name),
                    ),
                );
            }
            return;
        }

        // 2. Name in an ancestor scope.
        if let Some((_ancestor_scope, sym_id)) = self.lookup_ancestor(name) {
            let ancestor_is_variable = matches!(
                self.scope_tree.symbols[sym_id].kind,
                SymbolKind::Variable { .. }
            );
            if !ancestor_is_variable {
                let span = self.arena[node].span();
                error_not_variable(self, span, name);
                return;
            }

            if is_mut {
                // mut always means explicit shadow, even if ancestor is mutable.
                self.define(
                    name,
                    SymbolKind::Variable {
                        type_id: None,
                        is_mut: true,
                    },
                    node,
                );
            } else {
                let sym = &self.scope_tree.symbols[sym_id];
                let ancestor_is_mut = matches!(sym.kind, SymbolKind::Variable { is_mut: true, .. });
                if ancestor_is_mut {
                    // Reassignment of ancestor's mutable variable — skip.
                } else {
                    // Immutable ancestor → shadow.
                    self.define(
                        name,
                        SymbolKind::Variable {
                            type_id: None,
                            is_mut: false,
                        },
                        node,
                    );
                }
            }
            return;
        }

        // 3. Not found anywhere → new declaration.
        self.define(
            name,
            SymbolKind::Variable {
                type_id: None,
                is_mut,
            },
            node,
        );
    }

    /// Walk the parent chain starting from the current scope's parent
    /// upwards, looking for `name`.  Returns the nearest ancestor scope
    /// and the last SymbolId for that name.
    fn lookup_ancestor(&self, name: IdentId) -> Option<(ScopeId, SymbolId)> {
        let mut current = self.current_scope;
        loop {
            let parent = self.scope_tree.scopes[current].parent?;
            if let Some(&sid) = self.scope_tree.scopes[parent].symbols.get(&name) {
                return Some((parent, sid));
            }
            current = parent;
        }
    }

    fn resolve_tuple_unpack(&mut self, node: NodeId, t: &TupleUnpack) {
        self.record_scope(node);
        // Resolve the source expression.
        self.resolve_node(t.source);
        // Register each binding as a variable.
        for binding in &t.bindings {
            self.define(
                binding.name,
                SymbolKind::Variable {
                    type_id: None,
                    is_mut: binding.is_mut,
                },
                node,
            );
        }
    }

    // ── For loop ──

    fn resolve_for_loop(&mut self, node: NodeId, f: &ForLoop) {
        self.record_scope(node);

        // Resolve the iterator expression BEFORE entering the loop scope,
        // so loop vars don't shadow names used in the iter expression.
        self.resolve_node(f.iter);

        self.with_child_scope(|resolver| {
            resolver.loop_stack.push(resolver.current_scope);

            // Register the loop variable.
            resolver.define(
                f.var_name,
                SymbolKind::Variable {
                    type_id: None,
                    is_mut: false,
                },
                node,
            );

            // Resolve the body.
            resolver.resolve_node(f.body);

            resolver.loop_stack.pop();
        });
    }

    // ── Name references ──

    fn resolve_var(&mut self, node: NodeId, v: &Var) {
        self.record_scope(node);
        self.resolve_name(node, v.name);
    }

    fn resolve_call(&mut self, node: NodeId, c: &Call) {
        self.record_scope(node);
        // Resolve the callee expression first (handles Var, FieldAccess, etc.)
        self.resolve_node(c.callee);
        // Also mirror the resolution from the callee to the call node itself,
        // so that downstream passes (and tests) can find the resolution
        // keyed by either node ID.
        if let Expr::Var(_) = &self.arena[c.callee]
            && let Some(&sid) = self.scope_tree.resolved_refs.get(&c.callee)
        {
            self.scope_tree.resolved_refs.insert(node, sid);
        }
        // Resolve argument expressions.
        for &arg in &c.args {
            self.resolve_node(arg);
        }
    }

    /// Look up a name in the scope chain and record the result in
    /// `resolved_refs`.
    fn resolve_name(&mut self, node: NodeId, name: IdentId) {
        if let Some((_scope, sid)) = self.scope_tree.lookup(self.current_scope, name) {
            self.scope_tree.resolved_refs.insert(node, sid);
        } else {
            let name_str = self.interner.lookup(name);
            // Skip "undefined name" for builtins — they are resolved by name
            // during inference and codegen, not by symbol table lookup.
            if BuiltinFunc::try_from_name(name_str).is_some() {
                return;
            }
            let span = self.arena[node].span();
            self.diagnostics.error(
                self.file_idx,
                span,
                format!("undefined name '{}'", name_str),
            );
        }
    }

    // ── Field access ──

    fn resolve_field_access(&mut self, node: NodeId, f: &FieldAccess) {
        self.record_scope(node);
        // Only resolve the object — the field is resolved by the type
        // system during inference.
        self.resolve_node(f.obj);
    }

    fn resolve_field_assign(&mut self, node: NodeId, f: &FieldAssign) {
        self.record_scope(node);
        self.resolve_node(f.obj);
        self.resolve_node(f.value);
    }

    // ── Control flow ──

    fn resolve_return(&mut self, node: NodeId, r: &Return) {
        self.record_scope(node);
        if let Some(val) = r.value {
            self.resolve_node(val);
        }
    }

    fn resolve_break(&mut self, node: NodeId, _b: &Break) {
        self.record_scope(node);
        if self.loop_stack.is_empty() {
            let span = self.arena[node].span();
            self.diagnostics
                .error(self.file_idx, span, "'break' outside of a loop");
        }
    }

    fn resolve_continue(&mut self, node: NodeId, _c: &Continue) {
        self.record_scope(node);
        if self.loop_stack.is_empty() {
            let span = self.arena[node].span();
            self.diagnostics
                .error(self.file_idx, span, "'continue' outside of a loop");
        }
    }

    // ── Match ──

    fn resolve_match(&mut self, node: NodeId, m: &Match) {
        self.record_scope(node);
        // Resolve the scrutinee.
        self.resolve_node(m.scrutinee);

        // Each arm with a binding creates a new scope so the binding
        // doesn't leak between arms.
        for arm in &m.arms {
            self.with_child_scope(|resolver| {
                match &arm.kind {
                    MatchArmKind::Some { binding } => {
                        resolver.define(
                            *binding,
                            SymbolKind::Variable {
                                type_id: None,
                                is_mut: false,
                            },
                            node,
                        );
                    }
                    MatchArmKind::Variant {
                        binding: Some(b), ..
                    } => {
                        resolver.define(
                            *b,
                            SymbolKind::Variable {
                                type_id: None,
                                is_mut: false,
                            },
                            node,
                        );
                    }
                    MatchArmKind::Variant { binding: None, .. }
                    | MatchArmKind::None
                    | MatchArmKind::Else => {}
                }
                resolver.resolve_node(arm.body);
            });
        }
    }

    // ── If ──

    fn resolve_if(&mut self, node: NodeId, i: &If) {
        self.record_scope(node);
        for branch in &i.branches {
            self.resolve_node(branch.condition);
            self.resolve_node(branch.body);
        }
        if let Some(else_body) = i.else_branch {
            self.resolve_node(else_body);
        }
    }

    // ── Binary / Unary ──

    fn resolve_binary(&mut self, node: NodeId, b: &Binary) {
        self.record_scope(node);
        self.resolve_node(b.left);
        self.resolve_node(b.right);
    }

    fn resolve_unary(&mut self, node: NodeId, u: &Unary) {
        self.record_scope(node);
        self.resolve_node(u.child);
    }

    /// Check whether a `TypeNode` contains a reference to a given name,
    /// recursively (e.g., finds `T` in `Arr[T]` or `Func[Int: T]`).
    fn type_node_refers_to_name(&self, tn: &TypeNode, name: IdentId) -> bool {
        match tn {
            TypeNode::Named { name: n, params } => {
                *n == name
                    || params
                        .iter()
                        .any(|p| self.type_node_refers_to_name(p, name))
            }
            TypeNode::Arr(inner)
            | TypeNode::Iter(inner)
            | TypeNode::MutArr(inner)
            | TypeNode::Set(inner)
            | TypeNode::MutSet(inner)
            | TypeNode::Maybe(inner) => self.type_node_refers_to_name(inner, name),
            TypeNode::Tup(elems) => elems.iter().any(|e| self.type_node_refers_to_name(e, name)),
            TypeNode::Func { params, ret } => {
                params
                    .iter()
                    .any(|p| self.type_node_refers_to_name(p, name))
                    || self.type_node_refers_to_name(ret, name)
            }
            TypeNode::Dict { key, val } | TypeNode::MutDict { key, val } => {
                self.type_node_refers_to_name(key, name) || self.type_node_refers_to_name(val, name)
            }
            TypeNode::TypeParamRef { name: n, .. } => *n == name,
            _ => false,
        }
    }

    // ── Type-associated expressions ──

    fn resolve_type_associated(&mut self, node: NodeId, t: &TypeAssociated) {
        self.record_scope(node);
        match &self.arena[t.inner] {
            Expr::Call(c) => {
                // Resolve argument expressions.
                for &arg in &c.args {
                    self.resolve_node(arg);
                }
                // Record a scope for the Call node so inference can find it.
                self.record_scope(t.inner);

                // Resolve the call target through the type on the left of `::`.
                // For trait method calls (e.g., `T::foo(x)`), look up the type param
                // and find which trait provides the method.
                // For enum variant access (e.g., `Option::some(42i)`), the name is
                // resolved through the enum type — handled later by inference.
                self.resolve_trait_associated_call(node, t, c);
            }
            Expr::Var(_) => {
                // For Var inner (e.g., `T::bar` or `Option::some`), the type
                // system will resolve it — no symbol resolution needed here.
            }
            _ => {}
        }
    }

    /// Try to resolve `T::foo(x)` as a trait method call.
    /// Looks up the type on the left of `::` as a type parameter, finds its
    /// trait bounds, and checks if exactly one trait provides the method.
    fn resolve_trait_associated_call(&mut self, node: NodeId, t: &TypeAssociated, c: &Call) {
        let type_name = match &t.type_node {
            TypeNode::Named { name, .. } => *name,
            _ => return, // Not a named type — can't be a trait method call
        };

        // Extract the method name from the call's callee.
        let call_name = match &self.arena[c.callee] {
            Expr::Var(v) => v.name,
            _ => return, // Callee is not a simple name — not a trait method call
        };

        // Look up the type as a generic type parameter.
        let bounds = match self.scope_tree.lookup(self.current_scope, type_name) {
            Some((_scope, sid)) => {
                if let SymbolKind::TypeParam { bounds } = &self.scope_tree.symbols[sid].kind {
                    Some(bounds)
                } else {
                    None
                }
            }
            None => None,
        };

        let bounds = match bounds {
            Some(b) => b,
            None => return, // Not a type parameter — could be an enum, handled by inference
        };

        // Find which trait among the bounds has a requirement with the call's name.
        let mut found_trait: Option<IdentId> = None;
        for trait_name in bounds {
            if let Some((_scope, sid)) = self.scope_tree.lookup(self.current_scope, *trait_name)
                && let SymbolKind::Trait { requirements } = &self.scope_tree.symbols[sid].kind
                && requirements.iter().any(|r| r.name == call_name)
            {
                if found_trait.is_some() {
                    // Multiple traits provide the same method name — ambiguous.
                    self.diagnostics.error(
                                    self.file_idx,
                                self.arena[node].span(),
                                    format!(
                                        "ambiguous trait method '{}': multiple traits bound to '{}' provide this method",
                                        self.interner.lookup(call_name),
                                        self.interner.lookup(type_name),
                                    ),
                                );
                    return;
                }
                found_trait = Some(*trait_name);
            }
        }

        if let Some(trait_name) = found_trait {
            // Record the trait method ref so monomorphization can route the
            // call to the correct per-trait descriptor.
            self.scope_tree
                .trait_method_refs
                .insert(node, (type_name, trait_name));

            // Also look up the method name as a regular symbol (for
            // resolved_refs), since the name is registered as a TraitMethod
            // in the function body scope.
            if let Some((_scope, sid)) = self.scope_tree.lookup(self.current_scope, call_name) {
                self.scope_tree.resolved_refs.insert(t.inner, sid);
            }
        } else {
            self.diagnostics.error(
                self.file_idx,
                self.arena[node].span(),
                format!(
                    "trait method '{}' not found in traits bound to '{}'",
                    self.interner.lookup(call_name),
                    self.interner.lookup(type_name),
                ),
            );
        }
    }

    // ── Array / Tuple / Range ──

    fn resolve_array(&mut self, node: NodeId, a: &ArrLit) {
        self.record_scope(node);
        for &elem in &a.elements {
            self.resolve_node(elem);
        }
    }

    fn resolve_tuple_lit(&mut self, node: NodeId, t: &TupleLit) {
        self.record_scope(node);
        for &elem in &t.elements {
            self.resolve_node(elem);
        }
    }

    fn resolve_range(&mut self, node: NodeId, r: &RangeIter) {
        self.record_scope(node);
        self.resolve_node(r.start);
        if let Some(end) = r.end {
            self.resolve_node(end);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse;
    use crate::scan;
    use crate::source::{SourceMap, SourceText};

    /// Parse and resolve a source string, returning the full state.
    fn resolve(source: &str) -> (AstArena, Interner, DiagnosticsBag, ScopeTree, NodeId) {
        let src = SourceText::new("test.gema", source);
        let (tokens, sd) = scan::scan(&src, 0);
        let mut arena = AstArena::new();
        let mut interner = Interner::new();
        let mut diagnostics = DiagnosticsBag::new();
        for d in sd.into_vec() {
            diagnostics.push(d);
        }
        let root = parse::parse(&tokens, &mut arena, &mut interner, &mut diagnostics, 0);
        let scope_tree = resolve_names(&arena, root, &mut interner, &mut diagnostics, 0);
        (arena, interner, diagnostics, scope_tree, root)
    }

    #[test]
    fn resolve_variable() {
        let (arena, _, diags, tree, root) = resolve("x = 42i; x");
        assert!(!diags.has_errors(), "errors: {:?}", diags);
        let block = match &arena[root] {
            Expr::Block(b) => b,
            _ => panic!("expected Block"),
        };
        let last = block.stmts[block.stmts.len() - 1];
        let var_node = if let Expr::DropValue(dv) = &arena[last] {
            dv.child
        } else {
            last
        };
        assert!(tree.resolved_refs.contains_key(&var_node));
    }

    #[test]
    fn resolve_function() {
        let (arena, _, diags, tree, root) = resolve("func foo() { 1i }; foo()");
        assert!(!diags.has_errors(), "errors: {:?}", diags);
        // The `Call("foo")` should resolve.
        let block = match &arena[root] {
            Expr::Block(b) => b,
            _ => panic!("expected Block"),
        };
        let last = block.stmts[block.stmts.len() - 1];
        let call_node = if let Expr::DropValue(dv) = &arena[last] {
            dv.child
        } else {
            last
        };
        assert!(
            tree.resolved_refs.contains_key(&call_node),
            "call to foo should be resolved"
        );
    }

    #[test]
    fn resolve_recursive_function() {
        let (_, _, diags, _, _) = resolve(
            "func factorial(n: Num): Num { if n == 0 { 1i } else { n * factorial(n - 1i) } }",
        );
        assert!(!diags.has_errors(), "errors: {:?}", diags);
        // factorial should be resolvable from inside its own body.
        // We just check no errors — a recursive call would fail otherwise.
    }

    #[test]
    fn resolve_scoped_shadowing() {
        let (_, _, diags, _, _) = resolve("x = 1; { x = 2; x }; x");
        assert!(!diags.has_errors(), "errors: {:?}", diags);
    }

    #[test]
    fn undefined_variable_error() {
        let (_, _, diags, _, _) = resolve("nonexistent");
        assert!(diags.has_errors());
        let formatted = diags.format(&SourceMap::new());
        assert!(
            formatted.contains("undefined"),
            "expected 'undefined' in error message, got: {}",
            formatted
        );
    }

    #[test]
    fn break_outside_loop_error() {
        let (_, _, diags, _, _) = resolve("break");
        assert!(diags.has_errors());
    }

    #[test]
    fn continue_outside_loop_error() {
        let (_, _, diags, _, _) = resolve("continue");
        assert!(diags.has_errors());
    }

    #[test]
    fn break_inside_loop_is_ok() {
        let (_, _, diags, _, _) = resolve("for x = 0..10 { if x == 5 { break } }");
        assert!(!diags.has_errors(), "errors: {:?}", diags);
    }

    #[test]
    fn function_creates_new_scope() {
        let (_, _, diags, _, _) = resolve("func foo() { x = 1 }; x");
        assert!(diags.has_errors(), "x should not be visible outside foo");
    }

    #[test]
    fn anon_func_creates_new_scope() {
        let (_, _, diags, _, _) = resolve("\\x { x }");
        assert!(!diags.has_errors(), "errors: {:?}", diags);
    }

    #[test]
    fn for_loop_variable_resolved() {
        let (_, _, diags, _, _) = resolve("for x = 0..10 { x }");
        assert!(!diags.has_errors(), "errors: {:?}", diags);
    }

    #[test]
    fn struct_definition_registered() {
        let (_, _, diags, tree, _) = resolve("struct Point { x: Num, y: Num }");
        assert!(!diags.has_errors(), "errors: {:?}", diags);
        // Verify Point is registered as a Struct symbol.
        let name = tree
            .symbols
            .iter()
            .find(|(_, s)| matches!(&s.kind, SymbolKind::Struct { .. }));
        assert!(
            name.is_some(),
            "Point should be registered as a Struct symbol"
        );
    }

    #[test]
    fn enum_definition_registered() {
        let (_, _, diags, tree, _) = resolve("enum Option[T] { some: T, nothing }");
        assert!(!diags.has_errors(), "errors: {:?}", diags);
        let found = tree
            .symbols
            .iter()
            .any(|(_, s)| matches!(&s.kind, SymbolKind::Enum { .. }));
        assert!(found, "Option should be registered as an Enum symbol");
    }

    #[test]
    fn trait_definition_registered() {
        let (_, _, diags, tree, _) = resolve("trait Eq { equal: Func[Self, Self: Bool] }");
        assert!(!diags.has_errors(), "errors: {:?}", diags);
        let found = tree
            .symbols
            .iter()
            .any(|(_, s)| matches!(&s.kind, SymbolKind::Trait { .. }));
        assert!(found, "Eq should be registered as a Trait symbol");
    }

    #[test]
    fn duplicate_struct_error() {
        // Two struct definitions with the same name IS a duplicate.
        let (_, _, diags, _, _) = resolve("struct Foo {}; struct Foo {}");
        assert!(diags.has_errors());
        let formatted = diags.format(&SourceMap::new());
        assert!(
            formatted.contains("duplicate"),
            "expected 'duplicate' in error message, got: {}",
            formatted
        );
    }

    #[test]
    fn mutable_reassignment_chained() {
        let (_, _, diags, _, _) = resolve("mut x = 1; x = 2; x = x + 1");
        assert!(
            !diags.has_errors(),
            "mutable reassignment should work: {:?}",
            diags
        );
    }

    #[test]
    fn reassign_parent_mutable_from_child() {
        // `x` is mutable in outer scope, so `{ x = 2 }` reassigns, not shadows.
        let (_, _, diags, _, _) = resolve("mut x = 1; { x = 2 }; x");
        assert!(!diags.has_errors(), "errors: {:?}", diags);
    }

    #[test]
    fn explicit_mut_shadows_outer_mutable() {
        // `mut x = 2` inside block creates a new variable even though
        // the outer `x` is mutable.
        let (_, _, diags, _, _) = resolve("mut x = 1; { mut x = 2 }");
        assert!(
            !diags.has_errors(),
            "explicit mut should shadow: {:?}",
            diags
        );
    }

    #[test]
    fn explicit_mut_shadows_outer_immutable() {
        let (_, _, diags, _, _) = resolve("x = 1; { mut x = 2 }");
        assert!(
            !diags.has_errors(),
            "explicit mut should shadow immutable: {:?}",
            diags
        );
    }

    #[test]
    fn mut_on_reassignment_is_error() {
        let (_, _, diags, _, _) = resolve("mut x = 1; mut x = 2");
        assert!(diags.has_errors(), "mut on reassignment should be an error");
        let formatted = diags.format(&SourceMap::new());
        assert!(
            formatted.contains("cannot use 'mut' on reassignment"),
            "expected mut-on-reassignment error, got: {}",
            formatted
        );
    }

    #[test]
    fn reassignment_of_immutable_is_accepted_by_resolver() {
        // Type checker will catch this; resolver should not error.
        let (_, _, diags, _, _) = resolve("x = 1; x = 2");
        assert!(
            !diags.has_errors(),
            "resolver should accept immutable reassignment: {:?}",
            diags
        );
    }

    #[test]
    fn function_overloading_not_allowed() {
        let (_, _, diags, _, _) =
            resolve("func foo(x: Int): Int { x }; func foo(s: Str): Str { s }");
        assert!(diags.has_errors(), "overloading is not allowed");
    }

    #[test]
    fn match_arm_binding_resolved() {
        let (_, _, diags, _, _) = resolve("x = none; match x { some(v) -> { v }, none -> { 0i } }");
        assert!(!diags.has_errors(), "errors: {:?}", diags);
    }

    #[test]
    fn type_associated_enum_variant() {
        let (_, _, diags, _, _) = resolve("enum Option[T] { some: T, nothing }; Option::some(42i)");
        assert!(!diags.has_errors(), "errors: {:?}", diags);
    }

    #[test]
    fn impl_block_self_resolved() {
        let (_, _, diags, _, _) = resolve(
            "trait Foo { bar: Func[Self: Self] }; impl Num: Foo { func bar(x: Num): Num { x } }",
        );
        assert!(!diags.has_errors(), "errors: {:?}", diags);
    }

    // ── Assigning to non-variable names ──

    #[test]
    fn assign_to_function_name_error() {
        let (_, _, diags, _, _) = resolve("func f() { 1 }; f = 2");
        assert!(
            diags.has_errors(),
            "assigning to function name should error"
        );
        let formatted = diags.format(&SourceMap::new());
        assert!(
            formatted.contains("not a variable"),
            "expected 'not a variable' error, got: {}",
            formatted
        );
    }

    #[test]
    fn assign_to_struct_name_error() {
        let (_, _, diags, _, _) = resolve("struct Foo {}; Foo = 3");
        assert!(diags.has_errors(), "assigning to struct name should error");
        let formatted = diags.format(&SourceMap::new());
        assert!(
            formatted.contains("not a variable"),
            "expected 'not a variable' error, got: {}",
            formatted
        );
    }

    #[test]
    fn cannot_shadow_function_with_assignment() {
        // Assigning to a name that shadows a function in an ancestor should also error.
        let (_, _, diags, _, _) = resolve("func f() { 1 }; { f = 2 }");
        assert!(
            diags.has_errors(),
            "should not be able to shadow a function with assignment: {:?}",
            diags.format(&SourceMap::new()),
        );
    }

    #[test]
    fn struct_enum_same_name_error() {
        // Cross-kind name conflicts (struct + enum, etc.) are illegal
        let (_, _, diags, _, _) = resolve("struct Foo { x: Num }; enum Foo { A, B }");
        assert!(diags.has_errors());

        let (_, _, diags2, _, _) = resolve("enum Foo { A, B }; struct Foo { x: Num }");
        assert!(diags2.has_errors());
    }

    #[test]
    fn struct_func_same_name_error() {
        let (_, _, diags, _, _) = resolve("struct Foo { x: Num }; func Foo() { 1 }");
        assert!(diags.has_errors());

        let (_, _, diags2, _, _) = resolve("func Foo() { 1 }; struct Foo { x: Num }");
        assert!(diags2.has_errors());
    }
}
