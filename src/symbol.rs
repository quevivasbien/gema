/// Symbol table and scope tree for Gema.
///
/// Provides the data structures for representing named entities
/// (variables, functions, structs, enums, traits, type parameters)
/// and the lexical scope tree that organizes them.
use id_arena::{Arena, Id};
use rustc_hash::FxHashMap;

use crate::ast::{EnumVariant, NodeId, TraitRequirement, TypeNode};
use crate::interner::IdentId;
use crate::types::TypeId;

/// Opaque index into the symbol arena.
pub type SymbolId = Id<Symbol>;

/// Opaque index into the scope arena.
pub type ScopeId = Id<ScopeData>;

/// A single named entity in the program.
#[derive(Clone, Debug)]
pub struct Symbol {
    pub name: IdentId,
    pub kind: SymbolKind,
    /// The AST node where this symbol was defined.
    pub def_node: NodeId,
    /// The file_idx of the module that exported this symbol,
    /// or `None` for local symbols.
    pub source_module: Option<usize>,
}

/// What kind of thing a symbol represents.
#[derive(Clone, Debug)]
pub enum SymbolKind {
    /// A variable or immutable binding.
    Variable {
        /// Set during type inference (unknown during resolution).
        type_id: Option<TypeId>,
        is_mut: bool,
    },
    /// A named function.
    Function {
        /// Fully-qualified name including parameter types, set during
        /// type inference for overload resolution.
        full_name: Option<IdentId>,
        is_generic: bool,
        /// Number of value parameters.
        param_count: usize,
        /// Number of generic type parameters.
        type_param_count: usize,
        /// Pre-computed function type signature (TypeNode form), set by
        /// the linker for imported functions so inference can use it
        /// without accessing the dependency's AST arena.
        cached_signature: Option<Box<crate::ast::TypeNode>>,
        /// Pre-computed type parameter list, set by the linker so
        /// monomorphization can build descriptor args without
        /// accessing the dependency's AST arena.
        cached_type_params: Option<Vec<crate::ast::TypeParam>>,
    },
    /// A struct definition.
    Struct {
        type_params: Vec<IdentId>,
        /// Cached field definitions for imported structs, set by the
        /// linker so the lowerer and inferrer can access field info
        /// without dereferencing a cross-arena def_node.
        cached_fields: Option<Vec<crate::ast::StructField>>,
    },
    /// An enum definition.
    Enum {
        type_params: Vec<IdentId>,
        variants: Vec<EnumVariant>,
    },
    /// A trait definition.
    Trait { requirements: Vec<TraitRequirement> },
    /// An impl block connecting a type to a trait.
    Impl {
        trait_name: IdentId,
        self_type: TypeNode,
        member_nodes: Vec<NodeId>,
    },
    /// A generic type parameter (e.g. `T` in `func [T: Hash]`).
    TypeParam { bounds: Vec<IdentId> },
    /// A trait method callable inside a generic function body.
    /// The resolver registers these so the call can be resolved,
    /// and the monomorphizer routes them through the type descriptor.
    TraitMethod {
        /// The trait this method belongs to.
        trait_name: IdentId,
        /// The type parameter this method is associated with.
        type_param: IdentId,
        /// The type signature from the trait requirement.
        signature: Box<crate::ast::TypeNode>,
    },
}

// ── Scope tree ──

/// A single lexical scope in the program.
#[derive(Clone, Debug)]
pub struct ScopeData {
    pub parent: Option<ScopeId>,
    /// Symbols defined in this scope, keyed by name.
    /// For overloaded functions, multiple symbols may share the same
    /// name.  The vec is kept in insertion order.
    pub symbols: FxHashMap<IdentId, Vec<SymbolId>>,
    pub children: Vec<ScopeId>,
}

/// The complete scope tree for a compilation unit.
#[derive(Clone, Debug)]
pub struct ScopeTree {
    pub scopes: Arena<ScopeData>,
    pub symbols: Arena<Symbol>,
    pub root_scope: ScopeId,
    /// Maps AST nodes to the scope they belong to.
    pub node_scope: FxHashMap<NodeId, ScopeId>,
    /// Maps AST nodes (Var, Call) to their resolved SymbolId.
    pub resolved_refs: FxHashMap<NodeId, SymbolId>,
    /// Maps AST Call/TypeAssociated nodes to the `def_node` of the
    /// overload selected by type inference. Populated during inference,
    /// consumed during lowering.
    pub inferred_defs: FxHashMap<NodeId, NodeId>,
    /// Maps TypeAssociated call nodes to (type_param_id, trait_id) when the
    /// call is a trait method call (e.g., `T::foo(x)` maps to the specific
    /// trait that provides `foo` for `T`). Populated during name resolution,
    /// consumed during monomorphization.
    pub trait_method_refs: FxHashMap<NodeId, (IdentId, IdentId)>,
}

impl ScopeTree {
    /// Create a new empty scope tree with just a root scope.
    pub fn new() -> Self {
        let mut scopes = Arena::new();
        let root = scopes.alloc(ScopeData {
            parent: None,
            symbols: FxHashMap::default(),
            children: Vec::new(),
        });
        Self {
            scopes,
            symbols: Arena::new(),
            root_scope: root,
            node_scope: FxHashMap::default(),
            resolved_refs: FxHashMap::default(),
            inferred_defs: FxHashMap::default(),
            trait_method_refs: FxHashMap::default(),
        }
    }

    /// Allocate a new child scope of `parent` and return its id.
    pub fn alloc_scope(&mut self, parent: ScopeId) -> ScopeId {
        let id = self.scopes.alloc(ScopeData {
            parent: Some(parent),
            symbols: FxHashMap::default(),
            children: Vec::new(),
        });
        self.scopes[parent].children.push(id);
        id
    }

    /// Define a new symbol in the given scope.
    ///
    /// Returns the new `SymbolId`.  Does NOT check for duplicates —
    /// the caller (`resolve.rs`) is responsible for that.
    pub fn define(
        &mut self,
        scope: ScopeId,
        name: IdentId,
        kind: SymbolKind,
        def_node: NodeId,
    ) -> SymbolId {
        let id = self.symbols.alloc(Symbol {
            name,
            kind,
            def_node,
            source_module: None,
        });
        self.scopes[scope].symbols.entry(name).or_default().push(id);
        id
    }

    /// Look up a name in the scope chain.
    ///
    /// Searches `from` first, then walks parent scopes.  Returns the
    /// scope where the name was found and the list of symbol IDs for
    /// that name (multiple entries = function overloading).
    pub fn lookup(&self, from: ScopeId, name: IdentId) -> Option<(ScopeId, &[SymbolId])> {
        let mut current = from;
        loop {
            if let Some(ids) = self.scopes[current].symbols.get(&name)
                && !ids.is_empty()
            {
                return Some((current, ids.as_slice()));
            }
            match self.scopes[current].parent {
                Some(parent) => current = parent,
                None => return None,
            }
        }
    }

    /// Look up all function symbols with `name` in the scope chain.
    ///
    /// Returns only entries where `SymbolKind::Function`.
    pub fn lookup_functions(&self, from: ScopeId, name: IdentId) -> Vec<&Symbol> {
        let mut result = Vec::new();
        let mut current = from;
        loop {
            if let Some(ids) = self.scopes[current].symbols.get(&name) {
                for &sid in ids {
                    let sym = &self.symbols[sid];
                    if matches!(sym.kind, SymbolKind::Function { .. }) {
                        result.push(sym);
                    }
                }
                if !result.is_empty() {
                    return result;
                }
            }
            match self.scopes[current].parent {
                Some(parent) => current = parent,
                None => return result,
            }
        }
    }

    /// Populate symbol `type_id` fields from the inference results.
    /// Called after type inference completes.
    pub fn populate_from_types(&mut self, types: &FxHashMap<NodeId, TypeId>) {
        for (_, symbol) in self.symbols.iter_mut() {
            if let SymbolKind::Variable { type_id, .. } = &mut symbol.kind
                && let Some(&tid) = types.get(&symbol.def_node)
            {
                *type_id = Some(tid);
            }
        }
    }
}

impl Default for ScopeTree {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::{AstArena, Expr};
    use crate::interner::Interner;

    fn ident(interner: &mut Interner, s: &str) -> IdentId {
        interner.intern(s)
    }

    // Helper: create a dummy NodeId for tests by allocating an
    // ErrorExpr sentinel into a throwaway arena.
    fn dummy_node(arena: &mut AstArena) -> NodeId {
        arena.alloc(Expr::ErrorExpr)
    }

    #[test]
    fn new_scope_tree_has_root() {
        let tree = ScopeTree::new();
        assert_eq!(tree.scopes[tree.root_scope].parent, None);
        assert!(tree.scopes[tree.root_scope].symbols.is_empty());
    }

    #[test]
    fn alloc_scope_creates_child() {
        let mut tree = ScopeTree::new();
        let child = tree.alloc_scope(tree.root_scope);
        assert_eq!(tree.scopes[child].parent, Some(tree.root_scope));
        assert!(tree.scopes[tree.root_scope].children.contains(&child));
    }

    #[test]
    fn define_and_lookup_variable() {
        let mut arena = AstArena::new();
        let mut tree = ScopeTree::new();
        let mut interner = Interner::new();
        let name = ident(&mut interner, "x");

        tree.define(
            tree.root_scope,
            name,
            SymbolKind::Variable {
                type_id: None,
                is_mut: false,
            },
            dummy_node(&mut arena),
        );

        let result = tree.lookup(tree.root_scope, name);
        assert!(result.is_some());
        let (found_scope, ids) = result.unwrap();
        assert_eq!(found_scope, tree.root_scope);
        assert_eq!(ids.len(), 1);
        assert!(matches!(
            tree.symbols[ids[0]].kind,
            SymbolKind::Variable { is_mut: false, .. }
        ));
    }

    #[test]
    fn scoped_shadowing() {
        let mut arena = AstArena::new();
        let mut tree = ScopeTree::new();
        let mut interner = Interner::new();
        let name = ident(&mut interner, "x");

        tree.define(
            tree.root_scope,
            name,
            SymbolKind::Variable {
                type_id: None,
                is_mut: false,
            },
            dummy_node(&mut arena),
        );

        let inner = tree.alloc_scope(tree.root_scope);
        tree.define(
            inner,
            name,
            SymbolKind::Variable {
                type_id: None,
                is_mut: true,
            },
            dummy_node(&mut arena),
        );

        let result = tree.lookup(inner, name);
        assert!(result.is_some());
        let (found_scope, ids) = result.unwrap();
        assert_eq!(found_scope, inner);
        assert!(matches!(
            tree.symbols[ids[0]].kind,
            SymbolKind::Variable { is_mut: true, .. }
        ));

        let result = tree.lookup(tree.root_scope, name);
        assert!(result.is_some());
        let (found_scope, _) = result.unwrap();
        assert_eq!(found_scope, tree.root_scope);
    }

    #[test]
    fn lookup_walks_parent_chain() {
        let mut arena = AstArena::new();
        let mut tree = ScopeTree::new();
        let mut interner = Interner::new();
        let name = ident(&mut interner, "x");

        tree.define(
            tree.root_scope,
            name,
            SymbolKind::Variable {
                type_id: None,
                is_mut: false,
            },
            dummy_node(&mut arena),
        );

        let inner = tree.alloc_scope(tree.root_scope);
        let inner2 = tree.alloc_scope(inner);

        let result = tree.lookup(inner2, name);
        assert!(result.is_some());
        let (found_scope, _) = result.unwrap();
        assert_eq!(found_scope, tree.root_scope);
    }

    #[test]
    fn undefined_name_returns_none() {
        let tree = ScopeTree::new();
        let mut interner = Interner::new();
        assert!(
            tree.lookup(tree.root_scope, ident(&mut interner, "x"))
                .is_none()
        );
    }

    #[test]
    fn function_overloading_allowed() {
        let mut arena = AstArena::new();
        let mut tree = ScopeTree::new();
        let mut interner = Interner::new();
        let name = ident(&mut interner, "foo");

        tree.define(
            tree.root_scope,
            name,
            SymbolKind::Function {
                full_name: Some(ident(&mut interner, "foo$Int")),
                is_generic: false,
                param_count: 1,
                type_param_count: 0,
                cached_signature: None,
                cached_type_params: None,
            },
            dummy_node(&mut arena),
        );
        tree.define(
            tree.root_scope,
            name,
            SymbolKind::Function {
                full_name: Some(ident(&mut interner, "foo$Str")),
                is_generic: false,
                param_count: 1,
                type_param_count: 0,
                cached_signature: None,
                cached_type_params: None,
            },
            dummy_node(&mut arena),
        );

        let result = tree.lookup(tree.root_scope, name);
        assert!(result.is_some());
        let (_, ids) = result.unwrap();
        assert_eq!(ids.len(), 2);
    }

    #[test]
    fn lookup_functions_returns_only_functions() {
        let mut arena = AstArena::new();
        let mut tree = ScopeTree::new();
        let mut interner = Interner::new();
        let name = ident(&mut interner, "bar");

        tree.define(
            tree.root_scope,
            name,
            SymbolKind::Variable {
                type_id: None,
                is_mut: false,
            },
            dummy_node(&mut arena),
        );
        tree.define(
            tree.root_scope,
            name,
            SymbolKind::Function {
                full_name: None,
                is_generic: false,
                param_count: 0,
                type_param_count: 0,
                cached_signature: None,
                cached_type_params: None,
            },
            dummy_node(&mut arena),
        );

        let funcs = tree.lookup_functions(tree.root_scope, name);
        assert_eq!(funcs.len(), 1);
        assert!(matches!(funcs[0].kind, SymbolKind::Function { .. }));
    }

    #[test]
    fn define_in_child_does_not_affect_parent() {
        let mut arena = AstArena::new();
        let mut tree = ScopeTree::new();
        let mut interner = Interner::new();
        let name = ident(&mut interner, "x");
        let child = tree.alloc_scope(tree.root_scope);

        tree.define(
            child,
            name,
            SymbolKind::Variable {
                type_id: None,
                is_mut: false,
            },
            dummy_node(&mut arena),
        );

        assert!(tree.lookup(child, name).is_some());
        assert!(tree.lookup(tree.root_scope, name).is_none());
    }

    #[test]
    fn define_twice_same_name_both_stored() {
        let mut arena = AstArena::new();
        let mut tree = ScopeTree::new();
        let mut interner = Interner::new();
        let name = ident(&mut interner, "x");

        tree.define(
            tree.root_scope,
            name,
            SymbolKind::Variable {
                type_id: None,
                is_mut: false,
            },
            dummy_node(&mut arena),
        );
        tree.define(
            tree.root_scope,
            name,
            SymbolKind::Variable {
                type_id: None,
                is_mut: true,
            },
            dummy_node(&mut arena),
        );

        let (_, ids) = tree.lookup(tree.root_scope, name).unwrap();
        assert_eq!(ids.len(), 2);
    }
}
