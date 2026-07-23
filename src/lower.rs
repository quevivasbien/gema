/// AST → HIR lowering pass.
///
/// Walks the resolved and inferred AST and produces a `HirExpr` tree.
/// Desugarings performed:
///   - `DropValue` → implicit (just emit the child)
///   - `TypeAssociated` → `EnumLit` (when the type is an enum)
///   - `Call` which resolves to a struct constructor → `StructLit`
use crate::ast::{self, AstArena, NodeId};
use crate::builtins::BuiltinFunc;
use crate::hir;
use crate::hir::{HirBinaryOp, HirExpr, HirUnaryOp};
use crate::interner::{IdentId, Interner};
use crate::source::Span;
use crate::symbol::{ScopeId, ScopeTree, SymbolKind};

/// Lower a resolved and inferred AST to a HIR tree.
pub fn lower(
    arena: &AstArena,
    root: NodeId,
    scope_tree: &ScopeTree,
    interner: &mut Interner,
) -> HirExpr {
    let mut lowerer = Lowerer {
        arena,
        scope_tree,
        interner,
    };
    lowerer.lower_expr(root)
}

struct Lowerer<'a> {
    arena: &'a AstArena,
    scope_tree: &'a ScopeTree,
    interner: &'a mut Interner,
}

impl<'a> Lowerer<'a> {
    // ── Main dispatch ──

    fn lower_expr(&mut self, node: NodeId) -> HirExpr {
        match &self.arena[node] {
            // ── Literals ──
            ast::Expr::IntLit(e) => HirExpr::IntLit(hir::IntLit {
                span: e.span,
                value: e.value.clone(),
            }),
            ast::Expr::NumLit(e) => HirExpr::NumLit(hir::NumLit {
                span: e.span,
                value: e.value.clone(),
            }),
            ast::Expr::StrLit(e) => HirExpr::StrLit(hir::StrLit {
                span: e.span,
                value: e.value.clone(),
            }),
            ast::Expr::BoolLit(e) => HirExpr::BoolLit(hir::BoolLit {
                span: e.span,
                value: e.value,
            }),
            ast::Expr::NoneLit(e) => HirExpr::NoneLit(hir::NoneLit { span: e.span }),

            ast::Expr::Var(v) => {
                let def_node = if !v.template_types.is_empty() {
                    self.scope_tree.inferred_defs.get(&node).copied()
                } else {
                    None
                };
                HirExpr::Ident(hir::IdentNode {
                    span: v.span,
                    name: v.name,
                    def_node,
                })
            }
            // ── Collections ──
            ast::Expr::ArrLit(a) => self.lower_array(a),
            ast::Expr::TupleLit(t) => self.lower_tuple(t),
            ast::Expr::RangeIter(r) => self.lower_range(r),

            // ── Definitions ──
            ast::Expr::StructDef(_)
            | ast::Expr::EnumDef(_)
            | ast::Expr::TraitDef(_)
            | ast::Expr::Use(_)
            | ast::Expr::UseJs(_) => HirExpr::Null,

            // ImplBlock: produce an ImplBlock HIR node that will be emitted
            ast::Expr::ImplBlock(i) => self.lower_impl_block(i),

            // ── Calls ──
            ast::Expr::Call(c) => self.lower_call(node, c),
            // ── Operators ──
            ast::Expr::Binary(b) => HirExpr::Binary(hir::Binary {
                span: b.span,
                op: self.lower_binary_op(b.op),
                left: Box::new(self.lower_expr(b.left)),
                right: Box::new(self.lower_expr(b.right)),
            }),
            ast::Expr::Unary(u) => HirExpr::Unary(hir::Unary {
                span: u.span,
                op: self.lower_unary_op(u.op),
                child: Box::new(self.lower_expr(u.child)),
            }),

            // ── Assignment and field access ──
            ast::Expr::Assign(a) => self.lower_assign(a),
            ast::Expr::TupleUnpack(t) => self.lower_tuple_unpack(t),
            ast::Expr::FieldAccess(f) => HirExpr::FieldAccess(hir::FieldAccess {
                span: f.span,
                obj: Box::new(self.lower_expr(f.obj)),
                field: f.field,
            }),
            ast::Expr::FieldAssign(f) => HirExpr::FieldAssign(hir::FieldAssign {
                span: f.span,
                obj: Box::new(self.lower_expr(f.obj)),
                field: f.field,
                value: Box::new(self.lower_expr(f.value)),
            }),

            // ── Control flow ──
            ast::Expr::Block(b) => self.lower_block(b),
            ast::Expr::If(i) => self.lower_if(i),
            ast::Expr::ForLoop(f) => HirExpr::ForLoop(hir::ForLoop {
                span: f.span,
                var: f.var_name,
                iter: Box::new(self.lower_expr(f.iter)),
                body: Box::new(self.lower_expr(f.body)),
            }),
            ast::Expr::Break(b) => HirExpr::Break(hir::Break { span: b.span }),
            ast::Expr::Continue(c) => HirExpr::Continue(hir::Continue { span: c.span }),
            ast::Expr::Return(r) => HirExpr::Return(hir::Return {
                span: r.span,
                value: r.value.map(|v| Box::new(self.lower_expr(v))),
            }),

            // ── Functions ──
            ast::Expr::FuncDef(f) => self.lower_func_def(f, node),
            ast::Expr::AnonFunc(a) => self.lower_anon_func(a),

            // ── Pattern matching ──
            ast::Expr::Match(m) => self.lower_match(m),

            // ── Type-associated expressions (Foo::bar) ──
            ast::Expr::TypeAssociated(t) => self.lower_type_associated(node, t),

            // ── DropValue — strip the wrapper ──
            ast::Expr::DropValue(d) => self.lower_expr(d.child),

            // ── Error recovery sentinel ──
            ast::Expr::ErrorExpr => HirExpr::Null,
        }
    }

    // ── Collections ──

    fn lower_array(&mut self, a: &ast::ArrLit) -> HirExpr {
        HirExpr::ArrLit(hir::ArrLit {
            span: a.span,
            elements: a.elements.iter().map(|&e| self.lower_expr(e)).collect(),
        })
    }

    fn lower_tuple(&mut self, t: &ast::TupleLit) -> HirExpr {
        HirExpr::TupleLit(hir::TupleLit {
            span: t.span,
            elements: t.elements.iter().map(|&e| self.lower_expr(e)).collect(),
        })
    }

    fn lower_range(&mut self, r: &ast::RangeIter) -> HirExpr {
        HirExpr::RangeLit(hir::RangeLit {
            span: r.span,
            start: Box::new(self.lower_expr(r.start)),
            end: r.end.map(|e| Box::new(self.lower_expr(e))),
        })
    }

    // ── Calls ──

    fn lower_call(&mut self, node: NodeId, c: &ast::Call) -> HirExpr {
        // Check if callee is a named variable — name-based resolution path.
        if let ast::Expr::Var(v) = &self.arena[c.callee] {
            let name = v.name;

            // Check if this call is a struct constructor.
            if self.is_struct_constructor(node, name) {
                return self.lower_struct_constructor(node, c, name);
            }

            // Check if the callee resolves to a Function symbol.
            let is_function_sym = self
                .scope_tree
                .resolved_refs
                .get(&c.callee)
                .and_then(|&sid| self.scope_tree.symbols.get(sid))
                .is_some_and(|sym| matches!(sym.kind, SymbolKind::Function { .. }));

            if is_function_sym {
                // Named function path — resolve def_node and is_generic.
                let name_str = self.interner.lookup(name);
                let is_builtin = BuiltinFunc::try_from_name(name_str).is_some();

                let def_node = self
                    .scope_tree
                    .inferred_defs
                    .get(&node)
                    .copied()
                    .or_else(|| {
                        self.scope_tree
                            .resolved_refs
                            .get(&c.callee)
                            .and_then(|&sid| self.scope_tree.symbols.get(sid))
                            .map(|sym| sym.def_node)
                    })
                    .unwrap_or(node);

                let is_generic = self.scope_tree.symbols.iter().any(|(_, sym)| {
                    sym.def_node == def_node
                        && matches!(
                            &sym.kind,
                            SymbolKind::Function {
                                is_generic: true,
                                ..
                            }
                        )
                });

                let callee = self.lower_expr(c.callee);
                return HirExpr::Call(hir::Call {
                    span: c.span,
                    callee: Box::new(callee),
                    args: c.args.iter().map(|&a| self.lower_expr(a)).collect(),
                    is_builtin,
                    def_node,
                    is_generic,
                });
            }

            // Not a Function symbol — check if it's a builtin (only if no
            // user symbol shadows the name, since builtins are defaults).
            if self.scope_tree.resolved_refs.contains_key(&c.callee) {
                // Name resolves to a user symbol (variable, etc.) — skip
                // builtin path. Fall through to expression callee.
            } else {
                let name_str = self.interner.lookup(name);
                if !BuiltinFunc::try_from_name(name_str).is_some()
                {
                    // Name doesn't resolve to anything and isn't a builtin —
                    // let the expression callee path handle the error.
                } else {
                    let callee = self.lower_expr(c.callee);
                    return HirExpr::Call(hir::Call {
                        span: c.span,
                        callee: Box::new(callee),
                        args: c.args.iter().map(|&a| self.lower_expr(a)).collect(),
                        is_builtin: true,
                        def_node: node,
                        is_generic: false,
                    });
                }
            }
        }

        // Expression callee — just lower callee and args, no metadata.
        HirExpr::Call(hir::Call {
            span: c.span,
            callee: Box::new(self.lower_expr(c.callee)),
            args: c.args.iter().map(|&a| self.lower_expr(a)).collect(),
            is_builtin: false,
            def_node: c.callee,
            is_generic: false,
        })
    }
    // ── Struct constructor ──

    /// Check whether `name` at `node` resolves to a struct definition.
    fn is_struct_constructor(&self, node: NodeId, name: IdentId) -> bool {
        let scope = self
            .scope_tree
            .node_scope
            .get(&node)
            .copied()
            .unwrap_or(self.scope_tree.root_scope);
        self.find_struct(scope, name).is_some()
    }

    /// Find a `Struct` symbol by name in the scope chain.
    fn find_struct(&self, from: ScopeId, name: IdentId) -> Option<crate::symbol::SymbolId> {
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

    /// Convert a struct-constructor `Call` into a `StructLit`.
    fn lower_struct_constructor(&mut self, node: NodeId, c: &ast::Call, name: IdentId) -> HirExpr {
        let scope = self
            .scope_tree
            .node_scope
            .get(&node)
            .copied()
            .unwrap_or(self.scope_tree.root_scope);

        let field_names: Vec<IdentId> = if let Some(sid) = self.find_struct(scope, name) {
            let sym = &self.scope_tree.symbols[sid];
            match &sym.kind {
                SymbolKind::Struct {
                    cached_fields: Some(fields),
                    ..
                } => fields.iter().map(|f| f.name).collect(),
                _ => {
                    // Local struct — access via own arena.
                    match &self.arena[sym.def_node] {
                        ast::Expr::StructDef(s) => s.fields.iter().map(|f| f.name).collect(),
                        _ => Vec::new(),
                    }
                }
            }
        } else {
            Vec::new()
        };

        let args: Vec<HirExpr> = c.args.iter().map(|&a| self.lower_expr(a)).collect();

        let fields: Vec<(IdentId, HirExpr)> = if field_names.len() == args.len() {
            field_names.into_iter().zip(args).collect()
        } else {
            Vec::new()
        };

        HirExpr::StructLit(hir::StructLit {
            span: c.span,
            name,
            fields,
        })
    }

    // ── Assignments ──

    fn lower_assign(&mut self, a: &ast::Assign) -> HirExpr {
        HirExpr::Assign(hir::Assign {
            span: a.span,
            name: a.name,
            value: Box::new(self.lower_expr(a.value)),
            is_mut: a.is_mut,
        })
    }

    fn lower_tuple_unpack(&mut self, t: &ast::TupleUnpack) -> HirExpr {
        let source = self.lower_expr(t.source);
        let mut stmts: Vec<HirExpr> = Vec::new();

        for (index, binding) in t.bindings.iter().enumerate() {
            let index_access = HirExpr::TupleIndex(hir::TupleIndex {
                span: t.span,
                obj: Box::new(source.clone()),
                index,
            });
            let assign = HirExpr::Assign(hir::Assign {
                span: t.span,
                name: binding.name,
                value: Box::new(index_access),
                is_mut: binding.is_mut,
            });
            stmts.push(assign);
        }

        stmts.push(source);
        HirExpr::Block(hir::Block {
            span: t.span,
            stmts,
        })
    }

    // ── Control flow ──

    fn lower_block(&mut self, b: &ast::Block) -> HirExpr {
        HirExpr::Block(hir::Block {
            span: b.span,
            stmts: b.stmts.iter().map(|&s| self.lower_expr(s)).collect(),
        })
    }

    fn lower_if(&mut self, i: &ast::If) -> HirExpr {
        let branches: Vec<hir::ConditionalBranch> = i
            .branches
            .iter()
            .map(|b| hir::ConditionalBranch {
                condition: Box::new(self.lower_expr(b.condition)),
                body: Box::new(self.lower_expr(b.body)),
            })
            .collect();

        HirExpr::If(hir::If {
            span: i.span,
            branches,
            else_branch: i.else_branch.map(|eb| Box::new(self.lower_expr(eb))),
        })
    }

    // ── Functions ──

    fn lower_func_def(&mut self, f: &ast::FuncDef, node: NodeId) -> HirExpr {
        let type_params: Vec<hir::TypeParam> = f
            .type_params
            .iter()
            .map(|tp| hir::TypeParam {
                name: tp.name,
                trait_bounds: tp.traits.clone(),
            })
            .collect();
        let is_generic = !type_params.is_empty();
        HirExpr::FuncDef(hir::FuncDef {
            span: f.span,
            name: f.name,
            params: f
                .params
                .iter()
                .map(|p| hir::FuncParam { name: p.name })
                .collect(),
            body: Box::new(self.lower_expr(f.body)),
            type_params,
            node_id: node,
            is_generic,
        })
    }

    fn lower_anon_func(&mut self, a: &ast::AnonFunc) -> HirExpr {
        HirExpr::AnonFunc(hir::AnonFunc {
            span: a.span,
            params: a
                .params
                .iter()
                .map(|p| hir::FuncParam { name: p.name })
                .collect(),
            body: Box::new(self.lower_expr(a.body)),
        })
    }

    fn lower_impl_block(&mut self, i: &ast::ImplBlock) -> HirExpr {
        let name = self.mangle_impl_name(i);
        let name_id = self.interner.intern(&name);

        // Lower each member definition.
        let members: Vec<HirExpr> = i.members.iter().map(|&m| self.lower_expr(m)).collect();

        // Build the method name mapping: for each trait requirement, find the
        // corresponding member function name in the impl block.
        let method_names = self.build_impl_method_names(i);

        HirExpr::ImplBlock(hir::ImplBlock {
            span: i.span,
            name: name_id,
            members,
            method_names,
        })
    }

    /// Generate a unique mangled name for an impl block.
    fn mangle_impl_name(&self, i: &ast::ImplBlock) -> String {
        let trait_name = self.interner.lookup(i.trait_name);
        let type_desc = self.type_node_desc(&i.self_type);
        format!("$impl_{type_desc}_{trait_name}")
    }

    /// Produce a short type descriptor string from a TypeNode.
    fn type_node_desc(&self, ty: &ast::TypeNode) -> String {
        match ty {
            ast::TypeNode::Int => "Int".to_string(),
            ast::TypeNode::Num => "Num".to_string(),
            ast::TypeNode::Str => "Str".to_string(),
            ast::TypeNode::Bool => "Bool".to_string(),
            ast::TypeNode::Void => "Void".to_string(),
            ast::TypeNode::SelfType => "Self".to_string(),
            ast::TypeNode::Named { name, params } => {
                let base = self.interner.lookup(*name);
                if params.is_empty() {
                    base.to_string()
                } else {
                    let params_str: Vec<String> =
                        params.iter().map(|p| self.type_node_desc(p)).collect();
                    format!("{base}_{}", params_str.join("_"))
                }
            }
            ast::TypeNode::Func { .. } => "Func".to_string(),
            ast::TypeNode::Arr(..) => "Arr".to_string(),
            ast::TypeNode::Iter(..) => "Iter".to_string(),
            ast::TypeNode::MutArr(..) => "MutArr".to_string(),
            ast::TypeNode::Tup(..) => "Tup".to_string(),
            ast::TypeNode::Dict { .. } => "Dict".to_string(),
            ast::TypeNode::MutDict { .. } => "MutDict".to_string(),
            ast::TypeNode::Set(..) => "Set".to_string(),
            ast::TypeNode::MutSet(..) => "MutSet".to_string(),
            ast::TypeNode::Maybe(..) => "Maybe".to_string(),
            ast::TypeNode::TypeParamRef { name, .. } => self.interner.lookup(*name).to_string(),
        }
    }

    /// Build the (requirement_name, function_ref) mapping for an impl block's
    /// dictionary return. Each function reference carries the def_node so
    /// codegen can emit the correct machine name (with overload suffix).
    fn build_impl_method_names(&self, i: &ast::ImplBlock) -> Vec<(IdentId, HirExpr)> {
        let mut result = Vec::new();
        // Look up the trait definition to get requirement names.
        let trait_reqs: Vec<(IdentId, ast::TypeNode)> = self
            .scope_tree
            .symbols
            .iter()
            .find_map(|(_, sym)| {
                if sym.name == i.trait_name
                    && let SymbolKind::Trait { requirements } = &sym.kind
                {
                    Some(
                        requirements
                            .iter()
                            .map(|r| (r.name, r.type_node.clone()))
                            .collect::<Vec<_>>(),
                    )
                } else {
                    None
                }
            })
            .unwrap_or_default();

        for (req_name, _req_type) in &trait_reqs {
            // Find the member function that provides this requirement,
            // and create an Ident with the proper def_node for machine name resolution.
            let member_info =
                i.members
                    .iter()
                    .find_map(|&member_node| match &self.arena[member_node] {
                        ast::Expr::FuncDef(f) if f.name == *req_name => {
                            Some((f.name, Some(member_node)))
                        }
                        ast::Expr::Assign(a) if a.name == *req_name => Some((a.name, None)),
                        _ => None,
                    });
            if let Some((func_name, def_node)) = member_info {
                let func_ref = HirExpr::Ident(hir::IdentNode {
                    span: Span::empty_at(0),
                    name: func_name,
                    def_node,
                });
                result.push((*req_name, func_ref));
            }
        }
        result
    }

    // ── Match ──

    fn lower_match(&mut self, m: &ast::Match) -> HirExpr {
        HirExpr::Match(hir::Match {
            span: m.span,
            scrutinee: Box::new(self.lower_expr(m.scrutinee)),
            arms: m
                .arms
                .iter()
                .map(|arm| hir::MatchArm {
                    kind: match &arm.kind {
                        ast::MatchArmKind::Some { binding } => {
                            hir::HirMatchArmKind::Some { binding: *binding }
                        }
                        ast::MatchArmKind::None => hir::HirMatchArmKind::None,
                        ast::MatchArmKind::Variant { name, binding } => {
                            hir::HirMatchArmKind::Variant {
                                name: *name,
                                binding: *binding,
                            }
                        }
                        ast::MatchArmKind::Else => hir::HirMatchArmKind::Else,
                    },
                    body: Box::new(self.lower_expr(arm.body)),
                    span: arm.span,
                })
                .collect(),
        })
    }

    // ── Type-associated (Foo::bar / Foo::bar(x)) ──

    fn lower_type_associated(&mut self, node: NodeId, t: &ast::TypeAssociated) -> HirExpr {
        // Check if the type is an enum by looking it up in the scope tree.
        let (enum_name, _explicit_args) = match &t.type_node {
            ast::TypeNode::Named { name, .. } => (*name, Vec::<ast::TypeNode>::new()),
            _ => return self.lower_expr(t.inner),
        };

        let scope = self
            .scope_tree
            .node_scope
            .get(&node)
            .copied()
            .unwrap_or(self.scope_tree.root_scope);

        let enum_info = self.find_enum(scope, enum_name);

        match enum_info {
            Some((variants, _type_params)) => {
                let is_tagged_union = variants.iter().any(|v| v.type_node.is_some());

                // Determine which variant is being referenced.
                let (tag, value) = match &self.arena[t.inner] {
                    ast::Expr::Call(c) => {
                        let call_name = match &self.arena[c.callee] {
                            ast::Expr::Var(v) => v.name,
                            _ => return self.lower_expr(t.inner),
                        };
                        let lowered_args: Vec<HirExpr> =
                            c.args.iter().map(|&a| self.lower_expr(a)).collect();
                        let val = if lowered_args.len() == 1 {
                            Some(Box::new(lowered_args.into_iter().next().unwrap()))
                        } else if lowered_args.is_empty() {
                            None
                        } else {
                            Some(Box::new(HirExpr::TupleLit(hir::TupleLit {
                                span: c.span,
                                elements: lowered_args,
                            })))
                        };
                        (call_name, val)
                    }
                    ast::Expr::Var(v) => (v.name, None),
                    _ => return self.lower_expr(t.inner),
                };

                HirExpr::EnumLit(hir::EnumLit {
                    span: t.span,
                    enum_name,
                    tag,
                    value,
                    is_tagged_union,
                })
            }
            None => {
                // Not an enum. Check if this is a function reference with
                // a type annotation (e.g. `foo[Num]`), and if so, resolve
                // to the machine name via inferred_defs.
                match &self.arena[t.inner] {
                    ast::Expr::Var(v) => {
                        let def_node = self.scope_tree.inferred_defs.get(&node).copied();
                        HirExpr::Ident(hir::IdentNode {
                            span: v.span,
                            name: v.name,
                            def_node,
                        })
                    }
                    _ => self.lower_expr(t.inner),
                }
            }
        }
    }

    /// Find an `Enum` symbol by name in the scope chain.
    fn find_enum(
        &self,
        from: ScopeId,
        name: IdentId,
    ) -> Option<(Vec<ast::EnumVariant>, Vec<IdentId>)> {
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
                Some(p) => current = p,
                None => return None,
            }
        }
    }

    // ── Operator conversion helpers ──

    fn lower_binary_op(&self, op: ast::BinaryOp) -> HirBinaryOp {
        match op {
            ast::BinaryOp::Add => HirBinaryOp::Add,
            ast::BinaryOp::Sub => HirBinaryOp::Sub,
            ast::BinaryOp::Mul => HirBinaryOp::Mul,
            ast::BinaryOp::Div => HirBinaryOp::Div,
            ast::BinaryOp::IntDiv => HirBinaryOp::IntDiv,
            ast::BinaryOp::Mod => HirBinaryOp::Mod,
            ast::BinaryOp::EucMod => HirBinaryOp::EucMod,
            ast::BinaryOp::Pow => HirBinaryOp::Pow,
            ast::BinaryOp::Eq => HirBinaryOp::Eq,
            ast::BinaryOp::Ne => HirBinaryOp::Ne,
            ast::BinaryOp::Lt => HirBinaryOp::Lt,
            ast::BinaryOp::Le => HirBinaryOp::Le,
            ast::BinaryOp::Gt => HirBinaryOp::Gt,
            ast::BinaryOp::Ge => HirBinaryOp::Ge,
            ast::BinaryOp::And => HirBinaryOp::And,
            ast::BinaryOp::Or => HirBinaryOp::Or,
        }
    }

    fn lower_unary_op(&self, op: ast::UnaryOp) -> HirUnaryOp {
        match op {
            ast::UnaryOp::Neg => HirUnaryOp::Neg,
            ast::UnaryOp::Not => HirUnaryOp::Not,
        }
    }
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diagnostics::DiagnosticsBag;
    use crate::interner::Interner;
    use crate::parse;
    use crate::resolve::resolve_names;
    use crate::scan;
    use crate::source::{SourceMap, SourceText};

    /// Parse, resolve, and lower a source string.
    fn lower_one(source: &str) -> (HirExpr, DiagnosticsBag) {
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
        let hir = lower(&arena, root, &scope_tree, &mut interner);
        (hir, diagnostics)
    }

    /// Lower and assert no diagnostics.
    fn lower_ok(source: &str) -> HirExpr {
        let (hir, diags) = lower_one(source);
        assert!(
            !diags.has_errors(),
            "lowering produced errors:\n{}",
            diags.format(&SourceMap::new())
        );
        hir
    }

    /// Extract the last statement from the top-level block.
    fn last_in_block(hir: &HirExpr) -> &HirExpr {
        match hir {
            HirExpr::Block(b) => b.stmts.last().expect("block should have statements"),
            _ => panic!("expected Block at root"),
        }
    }

    // ── Literals ──

    #[test]
    fn lower_int_lit() {
        let hir = lower_ok("42i");
        assert!(matches!(last_in_block(&hir), HirExpr::IntLit(_)));
    }

    #[test]
    fn lower_num_lit() {
        let hir = lower_ok("3.14");
        assert!(matches!(last_in_block(&hir), HirExpr::NumLit(_)));
    }

    #[test]
    fn lower_str_lit() {
        let hir = lower_ok("\"hello\"");
        assert!(matches!(last_in_block(&hir), HirExpr::StrLit(_)));
    }

    #[test]
    fn lower_bool_lit() {
        let hir = lower_ok("true");
        assert!(matches!(last_in_block(&hir), HirExpr::BoolLit(_)));
    }

    #[test]
    fn lower_none_lit() {
        let hir = lower_ok("none");
        assert!(matches!(last_in_block(&hir), HirExpr::NoneLit(_)));
    }

    // ── Variable references ──

    #[test]
    fn lower_variable() {
        let hir = lower_ok("x = 42i; x");
        let last = last_in_block(&hir);
        assert!(matches!(last, HirExpr::Ident(_)));
    }

    // ── Binary and unary ──

    #[test]
    fn lower_binary_add() {
        let hir = lower_ok("1i + 2i");
        let last = last_in_block(&hir);
        match last {
            HirExpr::Binary(hir::Binary { op, .. }) => assert_eq!(*op, HirBinaryOp::Add),
            other => panic!("expected Binary, got {:?}", other),
        }
    }

    #[test]
    fn lower_unary_neg() {
        let hir = lower_ok("-42i");
        let last = last_in_block(&hir);
        match last {
            HirExpr::Unary(hir::Unary { op, .. }) => assert_eq!(*op, HirUnaryOp::Neg),
            other => panic!("expected Unary, got {:?}", other),
        }
    }

    // ── Assignment ──

    #[test]
    fn lower_assign() {
        let hir = lower_ok("x = 42i");
        let last = last_in_block(&hir);
        match last {
            HirExpr::Assign(hir::Assign {
                name: _, is_mut: _, ..
            }) => {
                // The last expression in a block is the Assign itself
                // (the value is not dropped since it's the last statement).
            }
            other => panic!("expected Assign, got {:?}", other),
        }
    }

    // ── Block ──

    #[test]
    fn lower_block() {
        let hir = lower_ok("{ 1i; 2i }");
        match &hir {
            HirExpr::Block(b) => {
                // The top-level file block wraps the inner block.
                // The inner block is the last statement.
                let inner = &b.stmts[b.stmts.len() - 1];
                match inner {
                    HirExpr::Block(hir::Block { stmts, .. }) => assert_eq!(stmts.len(), 2),
                    other => panic!("expected inner Block, got {:?}", other),
                }
            }
            other => panic!("expected outer Block, got {:?}", other),
        }
    }

    // ── If ──

    #[test]
    fn lower_if() {
        let hir = lower_ok("if true { 1i } else { 2i }");
        let last = last_in_block(&hir);
        match last {
            HirExpr::If(hir::If {
                branches,
                else_branch: Some(_),
                ..
            }) => {
                assert_eq!(branches.len(), 1);
            }
            other => panic!("expected If, got {:?}", other),
        }
    }

    // ── For loop ──

    #[test]
    fn lower_for_loop() {
        let hir = lower_ok("for x = 1i..10i { x }");
        let last = last_in_block(&hir);
        match last {
            HirExpr::ForLoop(hir::ForLoop { var: _, .. }) => {
                // var is IdentId; we just check it's present
                assert!(true);
            }
            other => panic!("expected ForLoop, got {:?}", other),
        }
    }

    // ── Break / Continue / Return ──

    #[test]
    fn lower_break_continue_return() {
        let hir = lower_ok(
            "func f() { for x = 1i..10i { if x == 5i { break }; if x == 8i { continue } } }; f()",
        );
        // Should lower without errors — control flow nodes are preserved.
        let _ = hir;
    }

    // ── Function definition ──

    #[test]
    fn lower_func_def() {
        let hir = lower_ok("func add(x: Int, y: Int): Int { x + y }");
        let block = match &hir {
            HirExpr::Block(b) => b,
            _ => panic!("expected Block"),
        };
        match &block.stmts[0] {
            HirExpr::FuncDef(hir::FuncDef {
                params,
                type_params,
                ..
            }) => {
                assert_eq!(params.len(), 2);
                assert!(type_params.is_empty());
            }
            other => panic!("expected FuncDef, got {:?}", other),
        }
    }

    #[test]
    fn lower_generic_func_def() {
        let hir = lower_ok("func [T: Hash] id(x: T): T { x }");
        let block = match &hir {
            HirExpr::Block(b) => b,
            _ => panic!("expected Block"),
        };
        match &block.stmts[0] {
            HirExpr::FuncDef(hir::FuncDef { type_params, .. }) => {
                assert_eq!(type_params.len(), 1);
                assert_eq!(type_params[0].trait_bounds.len(), 1);
            }
            other => panic!("expected FuncDef, got {:?}", other),
        }
    }

    // ── Anonymous function ──

    #[test]
    fn lower_anon_func() {
        let hir = lower_ok("\\x -> x + 1i");
        let last = last_in_block(&hir);
        match last {
            HirExpr::AnonFunc(hir::AnonFunc { params, .. }) => {
                assert_eq!(params.len(), 1);
            }
            other => panic!("expected AnonFunc, got {:?}", other),
        }
    }

    // ── Call ──

    #[test]
    fn lower_call() {
        let hir = lower_ok("func foo(x: Int): Int { x }; foo(1i)");
        let block = match &hir {
            HirExpr::Block(b) => b,
            _ => panic!("expected Block"),
        };
        match &block.stmts[1] {
            HirExpr::Call(hir::Call {
                is_builtin, args, ..
            }) => {
                assert!(!is_builtin);
                assert_eq!(args.len(), 1);
            }
            other => panic!("expected Call, got {:?}", other),
        }
    }

    // ── Array / Tuple / Range ──

    #[test]
    fn lower_array() {
        let hir = lower_ok("[1i, 2i, 3i]");
        let last = last_in_block(&hir);
        match last {
            HirExpr::ArrLit(hir::ArrLit { elements, .. }) => assert_eq!(elements.len(), 3),
            other => panic!("expected ArrLit, got {:?}", other),
        }
    }

    #[test]
    fn lower_tuple() {
        let hir = lower_ok("(1i, \"hello\", true)");
        let last = last_in_block(&hir);
        match last {
            HirExpr::TupleLit(hir::TupleLit { elements, .. }) => assert_eq!(elements.len(), 3),
            other => panic!("expected TupleLit, got {:?}", other),
        }
    }

    #[test]
    fn lower_range() {
        let hir = lower_ok("1i..10i");
        let last = last_in_block(&hir);
        match last {
            HirExpr::RangeLit(hir::RangeLit { end: Some(_), .. }) => {}
            other => panic!("expected RangeLit, got {:?}", other),
        }
    }

    // ── Struct construction and field access ──

    #[test]
    fn lower_struct_constructor() {
        let hir = lower_ok("struct Point { x: Num, y: Num }; p = Point(1, 2); p.x");
        // Should not produce errors — struct constructor is recognized.
        let block = match &hir {
            HirExpr::Block(b) => b,
            _ => panic!("expected Block"),
        };
        // The struct definition is dropped (Error), assign stays, field access stays.
        // block.stmts[0] is Error (the StructDef)
        // block.stmts[1] is Assign("p", StructLit(...)) or similar
        match &block.stmts[1] {
            HirExpr::Assign(hir::Assign { value, .. }) => match &**value {
                HirExpr::StructLit(hir::StructLit { fields, .. }) => {
                    assert_eq!(fields.len(), 2);
                }
                other => panic!("expected StructLit, got {:?}", other),
            },
            _ => {}
        }
    }

    #[test]
    fn lower_struct_field_access() {
        let hir = lower_ok("struct Point { x: Num, y: Num }; p = Point(1, 2); p.x");
        let block = match &hir {
            HirExpr::Block(b) => b,
            _ => panic!("expected Block"),
        };
        match &block.stmts[2] {
            HirExpr::FieldAccess(_) => {}
            other => panic!("expected FieldAccess, got {:?}", other),
        }
    }

    // ── Enum variant ──

    #[test]
    fn lower_enum_variant() {
        let hir = lower_ok("enum Option[T] { some: T, nothing }; Option::some(42i)");
        let block = match &hir {
            HirExpr::Block(b) => b,
            _ => panic!("expected Block"),
        };
        match &block.stmts[1] {
            HirExpr::EnumLit(hir::EnumLit {
                is_tagged_union,
                value,
                ..
            }) => {
                assert!(is_tagged_union);
                assert!(value.is_some());
            }
            other => panic!("expected EnumLit, got {:?}", other),
        }
    }

    // ── Match ──

    #[test]
    fn lower_match() {
        let hir = lower_ok(
            "x: Maybe[Int] = none: Int; match x { some(v) -> v, none -> 0i, else -> -1i }",
        );
        let block = match &hir {
            HirExpr::Block(b) => b,
            _ => panic!("expected Block"),
        };
        match &block.stmts[1] {
            HirExpr::Match(hir::Match { arms, .. }) => {
                assert_eq!(arms.len(), 3);
            }
            other => panic!("expected Match, got {:?}", other),
        }
    }

    // ── DropValue (implicit) ──

    #[test]
    fn lower_drop_value() {
        let hir = lower_ok("{ 1i; }");
        // The inner block should have one statement (the int lit).
        match &hir {
            HirExpr::Block(hir::Block {
                stmts: outer_stmts, ..
            }) => {
                let inner = &outer_stmts[outer_stmts.len() - 1];
                match inner {
                    HirExpr::Block(hir::Block {
                        stmts: inner_stmts, ..
                    }) => {
                        assert_eq!(inner_stmts.len(), 1);
                        assert!(matches!(inner_stmts[0], HirExpr::IntLit(_)));
                    }
                    other => panic!("expected inner Block, got {:?}", other),
                }
            }
            other => panic!("expected outer Block, got {:?}", other),
        }
    }

    // ── Field access and field assign ──

    #[test]
    fn lower_field_assign() {
        let hir = lower_ok("struct Point { mut x: Num, y: Num }; p = Point(1, 2); p.x = 5");
        let block = match &hir {
            HirExpr::Block(b) => b,
            _ => panic!("expected Block"),
        };
        match &block.stmts[2] {
            HirExpr::FieldAssign(_) => {}
            other => panic!("expected FieldAssign, got {:?}", other),
        }
    }

    // ── Calls with expression callee ──

    #[test]
    fn lower_direct_call() {
        let hir = lower_ok("(\\x -> x)(1i)");
        // The last expression should be a Call with a non-Ident callee (the lambda).
        let last = last_in_block(&hir);
        match last {
            HirExpr::Call(_) => {}
            other => panic!("expected Call, got {:?}", other),
        }
    }

    // ── Builtin call ──

    #[test]
    fn lower_non_builtin_call() {
        let hir = lower_ok("func len(x: Str): Num { 0 }; len(\"hi\")");
        let block = match &hir {
            HirExpr::Block(b) => b,
            _ => panic!("expected Block"),
        };
        // User-defined "len" shadows the builtin — is_builtin should be false.
        match &block.stmts[1] {
            HirExpr::Call(hir::Call { is_builtin, .. }) => {
                assert!(!is_builtin, "user function takes precedence over builtin");
            }
            other => panic!("expected Call, got {:?}", other),
        }
    }

    // ── Type-associated non-enum (Int::zero) ──

    #[test]
    fn lower_type_associated_plain_call() {
        // A TypeAssociated call inside another function body should
        // lower without errors — the inner call expression is preserved.
        let hir =
            lower_ok("enum Option[T] { some: T, nothing }; func test() { Option::some(42i) }");
        let _ = hir;
    }
}
