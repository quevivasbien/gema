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

/// A descriptor param for a single (type_param, trait) pair.
/// E.g., for `func [T: Foo + Bar] f(x: T)`, there are TWO descriptor params:
/// one for (T, Foo) and one for (T, Bar), named `$impl_T_Foo` and `$impl_T_Bar`.
struct DescriptorParam {
    /// The parameter name in the generated JS (e.g., `$impl_T_Foo`).
    param_name: IdentId,
    /// The type parameter this descriptor is for.
    type_param: IdentId,
    /// The trait this descriptor provides implementations for.
    trait_name: IdentId,
    /// The names of the trait's requirements (methods/variables).
    requirement_names: Vec<IdentId>,
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
            HirExpr::Null
            | HirExpr::IntLit(_)
            | HirExpr::NumLit(_)
            | HirExpr::StrLit(_)
            | HirExpr::BoolLit(_)
            | HirExpr::NoneLit(_)
            | HirExpr::Ident(_)
            | HirExpr::Break(_)
            | HirExpr::Continue(_)
            | HirExpr::TypeDescriptor(_)
            | HirExpr::ImplBlock(_) => expr,
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

        // Build ONE descriptor param per (type_param, trait) pair.
        let mut new_descriptors: Vec<DescriptorParam> = Vec::new();
        for tp in &f.type_params {
            for trait_name in &tp.trait_bounds {
                let req_names = self.get_trait_requirement_names(*trait_name);
                let desc_name = format!(
                    "$impl_{}_{}",
                    self.interner.lookup(tp.name),
                    self.interner.lookup(*trait_name)
                );
                let desc_param_id = self.interner.intern(&desc_name);
                new_descriptors.push(DescriptorParam {
                    param_name: desc_param_id,
                    type_param: tp.name,
                    trait_name: *trait_name,
                    requirement_names: req_names,
                });
                f.params.push(FuncParam {
                    name: desc_param_id,
                });
            }
        }

        f.type_params.clear();

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
        // which per-trait descriptor provides this method.
        for desc in descriptor_stack.iter().rev() {
            if desc.requirement_names.contains(&c.name) {
                // Route through descriptor: $impl_T_Foo.foo(x)
                let desc_ident = HirExpr::Ident(IdentNode {
                    span: c.span,
                    name: desc.param_name,
                    def_node: None,
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
        // Check if this call targets a generic function with trait bounds.
        let desc_count = self.descriptor_param_count(c.name);
        if desc_count > 0 {
            let desc_args = self.build_descriptor_args(c.name, desc_count, &c.args);
            c.args.extend(desc_args);
        }

        HirExpr::Call(c)
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
    /// Build descriptor arguments for a generic function call.
    /// Creates one descriptor per (type_param, trait) pair.
    fn build_descriptor_args(
        &mut self,
        func_name: IdentId,
        _descriptor_count: usize,
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
            Some(tp) => tp,
            None => return Vec::new(),
        };

        let mut results = Vec::new();
        for tp in &type_params {
            for trait_name in &tp.traits {
                results.push(self.build_descriptor_for_trait(tp, *trait_name, call_args));
            }
        }
        results
    }

    /// Build a descriptor reference for a single (type_param, trait) pair at a call site.
    /// Looks up the impl block's named constant (e.g., `$impl_Hash_Int`) and
    /// returns a reference to it, instead of inlining the dictionary.
    fn build_descriptor_for_trait(
        &mut self,
        _type_param: &ast::TypeParam,
        trait_name: IdentId,
        call_args: &[HirExpr],
    ) -> HirExpr {
        let type_name = self.concrete_type_from_arg(call_args);
        let type_name = match type_name {
            Some(t) => t,
            None => {
                // Can't determine concrete type — return an empty placeholder.
                return HirExpr::TypeDescriptor(TypeDescriptor {
                    span: Span::empty_at(0),
                    type_name: IdentId::from_u32(0),
                    methods: vec![],
                });
            }
        };

        // Look up the Impl symbol by matching (type_name, trait_name).
        for (_, sym) in self.scope_tree.symbols.iter() {
            if let SymbolKind::Impl {
                trait_name: tn,
                self_type,
                ..
            } = &sym.kind
            {
                if *tn != trait_name {
                    continue;
                }
                if !self.self_type_matches(self_type, type_name) {
                    continue;
                }
                // Found matching impl! Use its mangled name as the reference.
                return HirExpr::Ident(IdentNode {
                    span: Span::empty_at(0),
                    name: sym.name,
                    def_node: None,
                });
            }
        }

        // No impl found — return an empty descriptor placeholder.
        HirExpr::TypeDescriptor(TypeDescriptor {
            span: Span::empty_at(0),
            type_name,
            methods: vec![],
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
    ) -> Option<(IdentId, Option<crate::ast::NodeId>)> {
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
                // Find the first member function — return its name and def_node.
                for &member_node in member_nodes {
                    if let ast::Expr::FuncDef(f) = &self.arena[member_node] {
                        return Some((f.name, Some(member_node)));
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

    /// Count the total number of descriptor params needed for a function:
    /// the sum of trait bounds across all type params.
    fn descriptor_param_count(&self, name: IdentId) -> usize {
        let def_node = match self.find_func_def_node(name) {
            Some(n) => n,
            None => return 0,
        };
        match &self.arena[def_node] {
            ast::Expr::FuncDef(f) => f
                .type_params
                .iter()
                .map(|tp| tp.traits.len())
                .sum(),
            _ => 0,
        }
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
        let hir = lower(&arena, root, &scope_tree, &mut interner);
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
        // Unbound type params (no trait bounds) don't need descriptors.
        let hir = compile_ok("func [T] id(x: T): T { x }");
        match &hir {
            HirExpr::Block(b) => match &b.stmts[0] {
                HirExpr::FuncDef(f) => {
                    assert_eq!(
                        f.params.len(),
                        1,
                        "unbound generic should have only the value param (no descriptor)"
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
        // Trait-associated functions must be prefixed by `Type::` per the spec.
        let hir = compile_ok(
            "trait Hash { hash: Func[Self: Int] }; \
             impl Int: Hash { func hash(x: Int): Int { x } }; \
             func [T: Hash] id(x: T): T { T::hash(x) }",
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
    fn generic_func_with_separate_trait_descriptors() {
        // Generic function with multiple trait bounds should produce
        // separate descriptor params per (type_param, trait) pair,
        // to avoid ambiguity when different traits have same-named methods.
        let hir = compile_ok(
            "trait Foo { foo: Func[Self: Self] }; \
             trait Bar { bar: Func[Self: Self] }; \
             func [T: Foo + Bar] process(x: T) { T::foo(x); T::bar(x) }",
        );
        let block = match &hir {
            HirExpr::Block(b) => b,
            _ => panic!("expected Block"),
        };
        // stmts: [TraitDef(Error), TraitDef(Error), FuncDef]
        let func_def = match &block.stmts[2] {
            HirExpr::FuncDef(f) => f,
            _ => panic!("expected FuncDef"),
        };
        // With 2 trait bounds on one type param, should have 2 descriptor params (one per trait)
        // Plus 1 value param (x) = 3 total params
        assert_eq!(
            func_def.params.len(),
            3,
            "should have value param + 2 descriptor params (one per trait)"
        );
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
        // Unbound type params don't need descriptor args.
        let hir = compile_ok("func [T] id(x: T): T { x }; id(42i)");
        match &hir {
            HirExpr::Block(b) => {
                // stmts[1] should be the call to id(42i).
                match &b.stmts[1] {
                    HirExpr::Call(c) => {
                        // No descriptor args for unbound type params.
                        assert_eq!(c.args.len(), 1, "unbound generic call should have 1 arg");
                    }
                    _ => panic!("expected Call"),
                }
            }
            _ => panic!("expected Block"),
        }
    }

    #[test]
    fn trait_method_resolves_inside_generic_body() {
        // Ensure the pipeline doesn't error on proper `T::method()` syntax
        // for trait-associated functions inside generic function bodies.
        // Per the spec, the `T::` prefix is required.
        let (_hir, diags) = compile_to_hir(
            "trait Hash { hash: Func[Self: Int] }; \
             func [T: Hash] id(x: T): T { T::hash(x) }",
        );
        assert!(
            !diags.has_errors(),
            "trait method should resolve: {}",
            diags.format(&SourceMap::new())
        );
    }

    fn generic_with_nested_type_param() {
        // Generic type params can appear inside nested types like Arr[T].
        let hir = compile_ok("func [T] identity(arr: Arr[T]): Arr[T] { arr }");
        let block = match &hir {
            HirExpr::Block(b) => b,
            _ => panic!("expected Block"),
        };
        let func_def = match &block.stmts[0] {
            HirExpr::FuncDef(f) => f,
            _ => panic!("expected FuncDef"),
        };
        // Should have 2 params: `arr` + descriptor
        assert_eq!(func_def.params.len(), 2);
        assert!(func_def.type_params.is_empty());
    }

    #[test]
    fn generic_with_multiple_args_same_type_param() {
        // Multiple arguments can share the same type param.
        let hir = compile_ok("func [T] firstOrDefault(arr: Arr[T], default: T): T { default }");
        let block = match &hir {
            HirExpr::Block(b) => b,
            _ => panic!("expected Block"),
        };
        let func_def = match &block.stmts[0] {
            HirExpr::FuncDef(f) => f,
            _ => panic!("expected FuncDef"),
        };
        // Should have 2 params: `arr` + `default` (no descriptor for unbound T)
        assert_eq!(func_def.params.len(), 2);
    }

    #[test]
    fn generic_type_param_unused_in_args_is_error() {
        // Generic type params MUST be used by at least one argument.
        let (_hir, diags) = compile_to_hir("func [T] foo(x: Int): Int { x }");
        assert!(
            diags.has_errors(),
            "unused generic type param should be an error"
        );
    }

    #[test]
    fn generic_with_trait_variable_routed_through_descriptor() {
        // Trait variables (e.g., `T::bar` where `bar: Self` in a trait)
        // should be routed through the descriptor, similar to trait method calls.
        let hir = compile_ok(
            "trait Bar { bar: Self }; \
             func [T: Bar] get(x: T): T { T::bar }",
        );
        let block = match &hir {
            HirExpr::Block(b) => b,
            _ => panic!("expected Block"),
        };
        // stmts: [TraitDef(Error), FuncDef]
        let body = match &block.stmts[1] {
            HirExpr::FuncDef(f) => &f.body,
            _ => panic!("expected FuncDef"),
        };
        match &**body {
            HirExpr::Block(b) => match &b.stmts[0] {
                HirExpr::FieldAccess(fa) => {
                    assert!(
                        matches!(&*fa.obj, HirExpr::Ident(_)),
                        "descriptor should be an Ident"
                    );
                }
                other => panic!("expected FieldAccess for trait variable, got: {:?}", other),
            },
            _ => panic!("expected Block body"),
        }
    }

    #[test]
    fn generic_with_trait_method_and_variable() {
        // Full example from the docs: T::foo(x, T::bar)
        let hir = compile_ok(
            "trait Foo { foo: Func[Self, Self: Self] }; \
             trait Bar { bar: Self }; \
             func [T: Foo + Bar] process(x: T) { T::foo(x, T::bar) }",
        );
        let block = match &hir {
            HirExpr::Block(b) => b,
            _ => panic!("expected Block"),
        };
        // stmts: [TraitDef(Error), TraitDef(Error), FuncDef]
        let func_def = match &block.stmts[2] {
            HirExpr::FuncDef(f) => f,
            _ => panic!("expected FuncDef"),
        };
        // Should have 3 params: x + Foo descriptor + Bar descriptor
        assert_eq!(func_def.params.len(), 3);
    }
}
