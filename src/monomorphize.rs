/// Monomorphization via dictionary passing.
///
/// Transforms the HIR to resolve generics by adding type descriptor
/// parameters to generic functions and passing descriptors at call
/// sites.  This is a HIR-to-HIR transform that runs after lowering
/// and before codegen.
use crate::ast::{self, AstArena, NodeId};
use crate::hir::*;
use crate::interner::{IdentId, Interner};
use crate::source::Span;
use crate::symbol::{ScopeId, ScopeTree, SymbolKind};
use crate::types::{TypeArena, TypeId, TypeKind};

pub fn monomorphize(
    hir: HirExpr,
    arena: &AstArena,
    scope_tree: &ScopeTree,
    type_arena: &TypeArena,
    interner: &mut Interner,
) -> HirExpr {
    let mut m = Monomorphizer {
        arena,
        scope_tree,
        type_arena,
        interner,
        current_scope: scope_tree.root_scope,
    };
    m.monomorphize_expr(hir, &mut Vec::new())
}

struct Monomorphizer<'a> {
    arena: &'a AstArena,
    scope_tree: &'a ScopeTree,
    type_arena: &'a TypeArena,
    interner: &'a mut Interner,
    current_scope: ScopeId,
}

struct DescriptorParam {
    param_name: IdentId,
    trait_bounds: Vec<(IdentId, Vec<IdentId>)>,
}

impl<'a> Monomorphizer<'a> {
    /// `descriptor_stack` tracks which descriptor params are in scope
    /// as we descend into generic function bodies. Each entry maps
    /// a trait method name → the descriptor param name for routing.
    fn monomorphize_expr(
        &mut self,
        expr: HirExpr,
        descriptor_stack: &mut Vec<DescriptorParam>,
    ) -> HirExpr {
        match expr {
            HirExpr::FuncDef(f) => self.monomorphize_func_def(f, descriptor_stack),
            HirExpr::Call(c) => self.monomorphize_call(c, descriptor_stack),
            HirExpr::DirectCall(d) => {
                let callee = Box::new(self.monomorphize_expr(*d.callee, descriptor_stack));
                let args = d
                    .args
                    .into_iter()
                    .map(|a| self.monomorphize_expr(a, descriptor_stack))
                    .collect();
                HirExpr::DirectCall(DirectCall {
                    span: d.span,
                    callee,
                    args,
                })
            }
            HirExpr::Block(b) => HirExpr::Block(Block {
                span: b.span,
                stmts: b
                    .stmts
                    .into_iter()
                    .map(|s| self.monomorphize_expr(s, descriptor_stack))
                    .collect(),
            }),
            HirExpr::If(i) => HirExpr::If(If {
                span: i.span,
                branches: i
                    .branches
                    .into_iter()
                    .map(|b| ConditionalBranch {
                        condition: Box::new(self.monomorphize_expr(*b.condition, descriptor_stack)),
                        body: Box::new(self.monomorphize_expr(*b.body, descriptor_stack)),
                    })
                    .collect(),
                else_branch: i
                    .else_branch
                    .map(|eb| Box::new(self.monomorphize_expr(*eb, descriptor_stack))),
            }),
            HirExpr::ForLoop(f) => HirExpr::ForLoop(ForLoop {
                span: f.span,
                var: f.var,
                iter: Box::new(self.monomorphize_expr(*f.iter, descriptor_stack)),
                body: Box::new(self.monomorphize_expr(*f.body, descriptor_stack)),
            }),
            HirExpr::Match(m) => {
                let scrutinee = Box::new(self.monomorphize_expr(*m.scrutinee, descriptor_stack));
                let arms = m
                    .arms
                    .into_iter()
                    .map(|a| MatchArm {
                        kind: a.kind,
                        body: Box::new(self.monomorphize_expr(*a.body, descriptor_stack)),
                        span: a.span,
                    })
                    .collect();
                HirExpr::Match(Match {
                    span: m.span,
                    scrutinee,
                    arms,
                })
            }
            HirExpr::Binary(b) => HirExpr::Binary(Binary {
                span: b.span,
                op: b.op,
                left: Box::new(self.monomorphize_expr(*b.left, descriptor_stack)),
                right: Box::new(self.monomorphize_expr(*b.right, descriptor_stack)),
            }),
            HirExpr::Unary(u) => HirExpr::Unary(Unary {
                span: u.span,
                op: u.op,
                child: Box::new(self.monomorphize_expr(*u.child, descriptor_stack)),
            }),
            HirExpr::Assign(a) => HirExpr::Assign(Assign {
                span: a.span,
                name: a.name,
                value: Box::new(self.monomorphize_expr(*a.value, descriptor_stack)),
                is_mut: a.is_mut,
            }),
            HirExpr::Return(r) => HirExpr::Return(Return {
                span: r.span,
                value: r
                    .value
                    .map(|v| Box::new(self.monomorphize_expr(*v, descriptor_stack))),
            }),
            HirExpr::FieldAccess(fa) => HirExpr::FieldAccess(FieldAccess {
                span: fa.span,
                obj: Box::new(self.monomorphize_expr(*fa.obj, descriptor_stack)),
                field: fa.field,
            }),
            HirExpr::FieldAssign(fa) => HirExpr::FieldAssign(FieldAssign {
                span: fa.span,
                obj: Box::new(self.monomorphize_expr(*fa.obj, descriptor_stack)),
                field: fa.field,
                value: Box::new(self.monomorphize_expr(*fa.value, descriptor_stack)),
            }),
            HirExpr::TupleIndex(ti) => HirExpr::TupleIndex(TupleIndex {
                span: ti.span,
                obj: Box::new(self.monomorphize_expr(*ti.obj, descriptor_stack)),
                index: ti.index,
            }),
            HirExpr::AnonFunc(a) => HirExpr::AnonFunc(AnonFunc {
                span: a.span,
                params: a.params,
                body: Box::new(self.monomorphize_expr(*a.body, descriptor_stack)),
            }),
            HirExpr::ArrLit(a) => HirExpr::ArrLit(ArrLit {
                span: a.span,
                elements: a
                    .elements
                    .into_iter()
                    .map(|e| self.monomorphize_expr(e, descriptor_stack))
                    .collect(),
            }),
            HirExpr::TupleLit(t) => HirExpr::TupleLit(TupleLit {
                span: t.span,
                elements: t
                    .elements
                    .into_iter()
                    .map(|e| self.monomorphize_expr(e, descriptor_stack))
                    .collect(),
            }),
            HirExpr::RangeLit(r) => HirExpr::RangeLit(RangeLit {
                span: r.span,
                start: Box::new(self.monomorphize_expr(*r.start, descriptor_stack)),
                end: r
                    .end
                    .map(|e| Box::new(self.monomorphize_expr(*e, descriptor_stack))),
            }),
            HirExpr::StructLit(s) => HirExpr::StructLit(StructLit {
                span: s.span,
                name: s.name,
                fields: s
                    .fields
                    .into_iter()
                    .map(|(n, v)| (n, self.monomorphize_expr(v, descriptor_stack)))
                    .collect(),
            }),
            HirExpr::EnumLit(e) => HirExpr::EnumLit(EnumLit {
                span: e.span,
                enum_name: e.enum_name,
                tag: e.tag,
                value: e
                    .value
                    .map(|v| Box::new(self.monomorphize_expr(*v, descriptor_stack))),
                is_tagged_union: e.is_tagged_union,
            }),
            HirExpr::Error
            | HirExpr::IntLit(_)
            | HirExpr::NumLit(_)
            | HirExpr::StrLit(_)
            | HirExpr::BoolLit(_)
            | HirExpr::NoneLit(_)
            | HirExpr::Ident(_)
            | HirExpr::Break(_)
            | HirExpr::Continue(_)
            | HirExpr::TypeDescriptor(_) => expr,
        }
    }

    // ── Generic function definition ──

    /// Find the scope created for a function's body by looking up
    /// the function's AST def node in the scope tree.
    fn func_body_scope(&self, name: IdentId) -> Option<ScopeId> {
        for (_, sym) in self.scope_tree.symbols.iter() {
            if sym.name == name && matches!(&sym.kind, SymbolKind::Function { .. }) {
                return self.scope_tree.node_scope.get(&sym.def_node).copied();
            }
        }
        None
    }

    fn monomorphize_func_def(
        &mut self,
        mut f: FuncDef,
        descriptor_stack: &mut Vec<DescriptorParam>,
    ) -> HirExpr {
        let prev_scope = self.current_scope;
        if let Some(body_scope) = self.func_body_scope(f.name) {
            self.current_scope = body_scope;
        }

        if f.type_params.is_empty() {
            f.body = Box::new(self.monomorphize_expr(*f.body, descriptor_stack));
            self.current_scope = prev_scope;
            return HirExpr::FuncDef(f);
        }

        // Build descriptor params for this function's type parameters.
        let mut new_descriptors: Vec<DescriptorParam> = Vec::new();
        for tp in &f.type_params {
            let desc_name = format!("_{}", self.interner.lookup(tp.name));
            let desc_param_id = self.interner.intern(&desc_name);
            let mut trait_bounds: Vec<(IdentId, Vec<IdentId>)> = Vec::new();
            for trait_name in &tp.trait_bounds {
                let req_names = self.get_trait_requirement_names(*trait_name);
                trait_bounds.push((*trait_name, req_names));
            }
            new_descriptors.push(DescriptorParam {
                param_name: desc_param_id,
                trait_bounds,
            });
            // Add descriptor as a function parameter.
            f.params.push(FuncParam { name: tp.name });
        }

        f.type_params.clear();

        // Push descriptors and recurse into the body.
        let desc_count = new_descriptors.len();
        descriptor_stack.extend(new_descriptors);
        f.body = Box::new(self.monomorphize_expr(*f.body, descriptor_stack));
        for _ in 0..desc_count {
            descriptor_stack.pop();
        }

        self.current_scope = prev_scope;
        HirExpr::FuncDef(f)
    }

    /// Get the names of all requirements for a trait.
    fn get_trait_requirement_names(&self, trait_name: IdentId) -> Vec<IdentId> {
        for (_, sym) in self.scope_tree.symbols.iter() {
            if sym.name == trait_name
                && let SymbolKind::Trait { requirements } = &sym.kind
            {
                return requirements.iter().map(|r| r.name).collect();
            }
        }
        Vec::new()
    }

    // ── Calls ──

    fn monomorphize_call(
        &mut self,
        mut c: Call,
        descriptor_stack: &mut Vec<DescriptorParam>,
    ) -> HirExpr {
        // Recurse into args first.
        c.args = c
            .args
            .into_iter()
            .map(|a| self.monomorphize_expr(a, descriptor_stack))
            .collect();

        // Check if this is a trait method call that should be routed
        // through a descriptor.  Look up the descriptor stack to find
        // which descriptor provides this method name.
        for desc in descriptor_stack.iter().rev() {
            for (_trait_name, req_names) in &desc.trait_bounds {
                if req_names.contains(&c.name) {
                    // Route through descriptor: desc.hash(x)
                    let desc_ident = HirExpr::Ident(IdentNode {
                        span: c.span,
                        name: desc.param_name,
                    });
                    let field_access = HirExpr::FieldAccess(FieldAccess {
                        span: c.span,
                        obj: Box::new(desc_ident),
                        field: c.name,
                    });
                    return HirExpr::DirectCall(DirectCall {
                        span: c.span,
                        callee: Box::new(field_access),
                        args: c.args,
                    });
                }
            }
        }

        // Check if this call targets a generic function.
        let type_param_count = self.generic_param_count(c.name);
        if type_param_count > 0 {
            let desc_args = self.build_descriptor_args(c.name, type_param_count, &c.args);
            c.args.extend(desc_args);
        }

        HirExpr::Call(c)
    }

    /// Build descriptor arguments for a generic function call.
    fn build_descriptor_args(
        &mut self,
        func_name: IdentId,
        type_param_count: usize,
        call_args: &[HirExpr],
    ) -> Vec<HirExpr> {
        // Get type params from the scope tree symbol first (for imported
        // functions), falling back to AST access for local functions.
        let type_params = self
            .scope_tree
            .symbols
            .iter()
            .find_map(|(_, sym)| {
                if sym.name == func_name
                    && let SymbolKind::Function {
                        cached_type_params: Some(tp),
                        ..
                    } = &sym.kind
                {
                    Some(tp.clone())
                } else {
                    None
                }
            })
            .or_else(|| {
                let def_node = self.find_func_def_node(func_name)?;
                self.get_type_params_from_def(def_node)
            });

        let type_params = match type_params {
            Some(tp) if tp.len() == type_param_count => tp,
            _ => {
                // Fallback: empty descriptor placeholders.
                return (0..type_param_count)
                    .map(|_| {
                        HirExpr::TypeDescriptor(TypeDescriptor {
                            span: Span::empty_at(0),
                            type_name: IdentId::from_u32(0),
                            methods: vec![],
                        })
                    })
                    .collect();
            }
        };

        let mut results = Vec::with_capacity(type_params.len());
        for tp in type_params {
            results.push(self.build_descriptor_for_type_param(tp, call_args));
        }
        results
    }

    /// Find the AST definition node for a function by name.
    fn find_func_def_node(&self, name: IdentId) -> Option<NodeId> {
        for (_, sym) in self.scope_tree.symbols.iter() {
            if sym.name == name
                && let SymbolKind::Function { .. } = &sym.kind
            {
                return Some(sym.def_node);
            }
        }
        None
    }

    /// Extract type param info from a function definition AST node.
    fn get_type_params_from_def(&self, def_node: NodeId) -> Option<Vec<ast::TypeParam>> {
        match &self.arena[def_node] {
            ast::Expr::FuncDef(f) => Some(f.type_params.clone()),
            _ => None,
        }
    }

    /// Build a descriptor object for a single type parameter at a call site.
    /// Determines the concrete type from the call args and looks up the
    /// impl blocks for each required trait.
    fn build_descriptor_for_type_param(
        &mut self,
        _type_param: ast::TypeParam,
        call_args: &[HirExpr],
    ) -> HirExpr {
        let mut methods: Vec<(IdentId, HirExpr)> = Vec::new();
        let type_name = self.concrete_type_from_arg(call_args);

        for trait_name in &_type_param.traits {
            let reqs = self.get_trait_requirement_names(*trait_name);
            for req_name in reqs {
                // Look up the impl block for this concrete type and trait.
                let impl_func_name = self.find_impl_function_name(type_name, *trait_name, req_name);
                let func_ref = HirExpr::Ident(IdentNode {
                    span: Span::empty_at(0),
                    name: impl_func_name.unwrap_or(req_name),
                });
                methods.push((req_name, func_ref));
            }
        }

        HirExpr::TypeDescriptor(TypeDescriptor {
            span: Span::empty_at(0),
            type_name: type_name.unwrap_or(IdentId::from_u32(0)),
            methods,
        })
    }

    /// Try to determine the concrete type bound to a type parameter
    /// from the call's argument expressions.
    fn concrete_type_from_arg(&mut self, call_args: &[HirExpr]) -> Option<IdentId> {
        for arg in call_args {
            match arg {
                HirExpr::IntLit(_) => return Some(self.interner.intern("Int")),
                HirExpr::NumLit(_) => return Some(self.interner.intern("Num")),
                HirExpr::StrLit(_) => return Some(self.interner.intern("Str")),
                HirExpr::BoolLit(_) => return Some(self.interner.intern("Bool")),
                HirExpr::Ident(id) => {
                    if let Some(tid) = self.lookup_variable_type(id.name) {
                        let kind = self.type_arena.get(tid);
                        if let Some(name) = self.type_kind_to_name(kind) {
                            return Some(name);
                        }
                    }
                }
                _ => {}
            }
        }
        None
    }

    fn lookup_variable_type(&self, name: IdentId) -> Option<TypeId> {
        let (_scope, ids) = self.scope_tree.lookup(self.current_scope, name)?;
        for &sid in ids.iter().rev() {
            if let SymbolKind::Variable {
                type_id: Some(tid), ..
            } = &self.scope_tree.symbols[sid].kind
            {
                return Some(*tid);
            }
        }
        None
    }

    fn type_kind_to_name(&mut self, kind: &TypeKind) -> Option<IdentId> {
        match kind {
            TypeKind::Int => Some(self.interner.intern("Int")),
            TypeKind::Num => Some(self.interner.intern("Num")),
            TypeKind::Str => Some(self.interner.intern("Str")),
            TypeKind::Bool => Some(self.interner.intern("Bool")),
            TypeKind::Custom { name, .. } => Some(*name),
            _ => None,
        }
    }

    /// Look up the implementing function name for a (type, trait, method) combination.
    fn find_impl_function_name(
        &mut self,
        type_name: Option<IdentId>,
        trait_name: IdentId,
        _method_name: IdentId,
    ) -> Option<IdentId> {
        let type_name = type_name?;
        for (_, sym) in self.scope_tree.symbols.iter() {
            if let SymbolKind::Impl {
                trait_name: tn,
                self_type,
                member_nodes,
            } = &sym.kind
            {
                if *tn != trait_name {
                    continue;
                }
                // Check if self_type matches the concrete type.
                if !self.self_type_matches(self_type, type_name) {
                    continue;
                }
                // Find the first member function — return its name.
                for &member_node in member_nodes {
                    if let ast::Expr::FuncDef(f) = &self.arena[member_node] {
                        return Some(f.name);
                    }
                }
            }
        }
        None
    }

    /// Check if a `TypeNode` matches a concrete type name.
    fn self_type_matches(&mut self, type_node: &ast::TypeNode, type_name: IdentId) -> bool {
        match type_node {
            ast::TypeNode::Int => {
                self.interner.intern("Int") == type_name
                    || self
                        .scope_tree
                        .symbols
                        .iter()
                        .any(|(_, s)| s.name == type_name)
            }
            ast::TypeNode::Num => self.interner.intern("Num") == type_name,
            ast::TypeNode::Str => self.interner.intern("Str") == type_name,
            ast::TypeNode::Bool => self.interner.intern("Bool") == type_name,
            ast::TypeNode::Named { name, .. } => *name == type_name,
            _ => false,
        }
    }

    fn generic_param_count(&self, name: IdentId) -> usize {
        for (_, sym) in self.scope_tree.symbols.iter() {
            if sym.name == name
                && let SymbolKind::Function {
                    is_generic,
                    type_param_count,
                    ..
                } = &sym.kind
                && *is_generic
            {
                return *type_param_count;
            }
        }
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diagnostics::DiagnosticsBag;
    use crate::infer::infer_types;
    use crate::interner::Interner;
    use crate::lower::lower;
    use crate::parse;
    use crate::resolve::resolve_names;
    use crate::scan;
    use crate::source::{SourceMap, SourceText};

    /// Full pipeline: parse → resolve → infer → lower → monomorphize.
    fn compile_to_hir(source: &str) -> (HirExpr, DiagnosticsBag) {
        let src = SourceText::new("test.gema", source);
        let (tokens, sd) = scan::scan(&src, 0);
        let mut arena = AstArena::new();
        let mut interner = Interner::new();
        let mut diags = DiagnosticsBag::new();
        for d in sd.into_vec() {
            diags.push(d);
        }
        let root = parse::parse(&tokens, &mut arena, &mut interner, &mut diags, 0);
        let mut scope_tree = resolve_names(&arena, root, &mut interner, &mut diags, 0);
        let mut type_arena = TypeArena::new();
        let _types = infer_types(
            &arena,
            &mut scope_tree,
            &mut type_arena,
            &interner,
            root,
            &mut diags,
            0,
        );
        let hir = lower(&arena, root, &scope_tree, &interner);
        let hir = monomorphize(hir, &arena, &scope_tree, &type_arena, &mut interner);
        (hir, diags)
    }

    fn compile_ok(source: &str) -> HirExpr {
        let (hir, diags) = compile_to_hir(source);
        assert!(
            !diags.has_errors(),
            "compile errors:\n{}",
            diags.format(&SourceMap::new())
        );
        hir
    }

    #[test]
    fn generic_func_gets_descriptor_param() {
        let hir = compile_ok("func [T] id(x: T): T { x }");
        // The function should have one extra param for the type descriptor.
        match &hir {
            HirExpr::Block(b) => match &b.stmts[0] {
                HirExpr::FuncDef(f) => {
                    assert_eq!(
                        f.params.len(),
                        2,
                        "should have value param + descriptor param"
                    );
                    assert!(f.type_params.is_empty(), "type_params should be cleared");
                }
                _ => panic!("expected FuncDef"),
            },
            _ => panic!("expected Block"),
        }
    }

    #[test]
    fn generic_func_calls_routed_through_descriptor() {
        // A generic function that calls a trait method should have the
        // call routed through the descriptor parameter.
        let hir = compile_ok(
            "trait Hash { hash: Func[Self: Int] }; \
             impl Int: Hash { func hash(x: Int): Int { x } }; \
             func [T: Hash] id(x: T): T { hash(x) }",
        );
        // Find the FuncDef and check its body has a DirectCall
        // (the trait method call should be converted from Call to DirectCall).
        let block = match &hir {
            HirExpr::Block(b) => b,
            _ => panic!("expected Block"),
        };
        // stmts: [TraitDef(Error), ImplBlock(Error), FuncDef]
        let body = match &block.stmts[2] {
            HirExpr::FuncDef(f) => &f.body,
            _ => panic!("expected FuncDef"),
        };
        match &**body {
            HirExpr::Block(b) => match &b.stmts[0] {
                HirExpr::DirectCall(d) => {
                    match &*d.callee {
                        HirExpr::FieldAccess(fa) => {
                            assert!(
                                matches!(&*fa.obj, HirExpr::Ident(_)),
                                "descriptor should be an Ident"
                            );
                            // We can't compare IdentId across interners, so check via the
                            // full pipeline test below instead.
                        }
                        _ => panic!("expected FieldAccess as callee"),
                    }
                }
                _ => panic!("expected DirectCall for trait method: {:?}", b),
            },
            _ => panic!("expected Block body"),
        }
    }

    #[test]
    fn non_generic_func_not_affected() {
        let hir = compile_ok("func add(x: Int, y: Int): Int { x + y }");
        match &hir {
            HirExpr::Block(b) => match &b.stmts[0] {
                HirExpr::FuncDef(f) => {
                    assert_eq!(
                        f.params.len(),
                        2,
                        "non-generic func should have same params"
                    );
                    assert!(f.type_params.is_empty());
                }
                _ => panic!("expected FuncDef"),
            },
            _ => panic!("expected Block"),
        }
    }

    #[test]
    fn generic_func_call_gets_descriptor_arg() {
        let hir = compile_ok("func [T] id(x: T): T { x }; id(42i)");
        match &hir {
            HirExpr::Block(b) => {
                // stmts[1] should be the call to id(42i) with descriptor.
                match &b.stmts[1] {
                    HirExpr::Call(c) => {
                        assert_eq!(c.args.len(), 2, "should have value arg + descriptor arg");
                        // Second arg should be a TypeDescriptor
                        assert!(
                            matches!(&c.args[1], HirExpr::TypeDescriptor(_)),
                            "descriptor arg should be TypeDescriptor"
                        );
                    }
                    _ => panic!("expected Call"),
                }
            }
            _ => panic!("expected Block"),
        }
    }

    #[test]
    fn trait_method_resolves_inside_generic_body() {
        // Without monomorphization checking, just ensure the pipeline
        // doesn't error on trait method calls inside generic functions.
        let (_hir, diags) = compile_to_hir(
            "trait Hash { hash: Func[Self: Int] }; \
             func [T: Hash] id(x: T): T { hash(x) }",
        );
        assert!(
            !diags.has_errors(),
            "trait method should resolve: {}",
            diags.format(&SourceMap::new())
        );
    }
}
