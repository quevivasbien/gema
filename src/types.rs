/// Interned type system for Gema.
///
/// Types are interned in a `TypeArena` using hash consing: every
/// structurally distinct `TypeKind` is stored exactly once and
/// identified by a `Copy` `TypeId`.  This makes type equality
/// O(1) (pointer equality via integer comparison) and keeps
/// memory layout flat.
use rustc_hash::FxHashMap;

use crate::ast::TypeNode;
use crate::interner::IdentId;

/// Opaque index into a `TypeArena`.  `Copy`, cheap to pass around.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct TypeId(u32);

/// Every kind of type the compiler knows about.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum TypeKind {
    // ── Primitives ──
    Int,
    Num,
    Str,
    Bool,
    Null,

    // ── Compound types ──
    Func {
        params: Vec<TypeId>,
        ret: TypeId,
    },
    Iter(TypeId),
    Arr(TypeId),
    MutArr(TypeId),
    Tuple(Vec<TypeId>),
    Dict {
        key: TypeId,
        val: TypeId,
    },
    MutDict {
        key: TypeId,
        val: TypeId,
    },
    Set(TypeId),
    MutSet(TypeId),
    Maybe(TypeId),

    // ── User-defined (structs, enums) ──
    Custom {
        name: IdentId,
        args: Vec<TypeId>,
    },

    // ── Generics ──
    Generic {
        name: IdentId,
        bounds: Vec<IdentId>,
    },

    // ── Inference sentinels ──
    InferVar {
        id: u32,
    },

    // ── Special ──
    SelfType,

    /// Error-recovery sentinel.  Produced when a type cannot be
    /// determined (e.g., an undefined type name).  Carries no
    /// information — it's a placeholder so subsequent passes can
    /// continue without cascading panics.
    Unknown,
}

/// Arena that owns all type values and deduplicates them via hash
/// consing.
pub struct TypeArena {
    types: Vec<TypeKind>,
    /// Hash-consing map: already-interned TypeKind → its TypeId.
    dedup: FxHashMap<TypeKind, TypeId>,
    /// Counter for generating unique inference varfiable IDs.
    infer_var_counter: u32,

    // Pre-interned primitive type IDs (set up in new()).
    int_id: TypeId,
    num_id: TypeId,
    str_id: TypeId,
    bool_id: TypeId,
    null_id: TypeId,
    self_id: TypeId,
    unknown_id: TypeId,
}

impl TypeArena {
    pub fn new() -> Self {
        let mut arena = Self {
            types: Vec::new(),
            dedup: FxHashMap::default(),
            infer_var_counter: 0,
            int_id: TypeId(0),
            num_id: TypeId(0),
            str_id: TypeId(0),
            bool_id: TypeId(0),
            null_id: TypeId(0),
            self_id: TypeId(0),
            unknown_id: TypeId(0),
        };

        // Pre-intern primitives so their IDs are stable.
        arena.int_id = arena.intern_raw(TypeKind::Int);
        arena.num_id = arena.intern_raw(TypeKind::Num);
        arena.str_id = arena.intern_raw(TypeKind::Str);
        arena.bool_id = arena.intern_raw(TypeKind::Bool);
        arena.null_id = arena.intern_raw(TypeKind::Null);
        arena.self_id = arena.intern_raw(TypeKind::SelfType);
        arena.unknown_id = arena.intern_raw(TypeKind::Unknown);

        arena
    }

    // ── Pre-interned primitive accessors ──

    pub fn int_id(&self) -> TypeId {
        self.int_id
    }
    pub fn num_id(&self) -> TypeId {
        self.num_id
    }
    pub fn str_id(&self) -> TypeId {
        self.str_id
    }
    pub fn bool_id(&self) -> TypeId {
        self.bool_id
    }
    pub fn null_id(&self) -> TypeId {
        self.null_id
    }
    pub fn self_id(&self) -> TypeId {
        self.self_id
    }
    pub fn unknown_id(&self) -> TypeId {
        self.unknown_id
    }

    // ── Interning ──

    /// Intern (or look up) a `TypeKind`.  If this exact kind has
    /// already been interned, returns the existing `TypeId`.
    /// Otherwise allocates a new slot.
    pub fn intern(&mut self, kind: TypeKind) -> TypeId {
        if let Some(&id) = self.dedup.get(&kind) {
            return id;
        }
        self.intern_raw(kind)
    }

    /// Internal: allocate without checking dedup.  Used during
    /// construction when we KNOW the type is unique (primitives)
    /// or when we've already checked dedup.
    fn intern_raw(&mut self, kind: TypeKind) -> TypeId {
        let id = TypeId(self.types.len() as u32);
        self.dedup.insert(kind.clone(), id);
        self.types.push(kind);
        id
    }

    /// Look up the `TypeKind` for a given `TypeId`.
    /// Panics if `id` is out of range (should never happen with
    /// valid IDs produced by this arena).
    pub fn get(&self, id: TypeId) -> &TypeKind {
        &self.types[id.0 as usize]
    }

    // ── Inference variables ──

    /// Create a fresh inference variable.  Each call returns a
    /// unique `InferVar` (NOT hash-consed).
    pub fn fresh_infer_var(&mut self) -> TypeId {
        let id = self.infer_var_counter;
        self.infer_var_counter += 1;
        let kind = TypeKind::InferVar { id };
        let tid = TypeId(self.types.len() as u32);
        // Deliberately skip dedup — every InferVar is unique.
        self.types.push(kind);
        tid
    }

    // ── Substitution ──

    /// Substitute generic type parameters with concrete types.
    ///
    /// `bindings` maps generic parameter names to their concrete
    /// `TypeId`s.  Returns a new (or existing) `TypeId`.
    pub fn substitute(&mut self, ty: TypeId, bindings: &FxHashMap<IdentId, TypeId>) -> TypeId {
        match self.get(ty).clone() {
            // Primitives and special — no substitution
            TypeKind::Int
            | TypeKind::Num
            | TypeKind::Str
            | TypeKind::Bool
            | TypeKind::Null
            | TypeKind::SelfType
            | TypeKind::Unknown => ty,

            // Inference variables — not substituted here
            TypeKind::InferVar { .. } => ty,

            // Generic param — look up in bindings
            TypeKind::Generic { name, .. } => bindings.get(&name).copied().unwrap_or(ty),

            // Compound: substitute children and re-intern
            TypeKind::Arr(inner) => {
                let new_inner = self.substitute(inner, bindings);
                self.intern(TypeKind::Arr(new_inner))
            }
            TypeKind::Iter(inner) => {
                let new_inner = self.substitute(inner, bindings);
                self.intern(TypeKind::Iter(new_inner))
            }
            TypeKind::MutArr(inner) => {
                let new_inner = self.substitute(inner, bindings);
                self.intern(TypeKind::MutArr(new_inner))
            }
            TypeKind::Set(inner) => {
                let new_inner = self.substitute(inner, bindings);
                self.intern(TypeKind::Set(new_inner))
            }
            TypeKind::MutSet(inner) => {
                let new_inner = self.substitute(inner, bindings);
                self.intern(TypeKind::MutSet(new_inner))
            }
            TypeKind::Maybe(inner) => {
                let new_inner = self.substitute(inner, bindings);
                self.intern(TypeKind::Maybe(new_inner))
            }
            TypeKind::Dict { key, val } => {
                let new_key = self.substitute(key, bindings);
                let new_val = self.substitute(val, bindings);
                self.intern(TypeKind::Dict {
                    key: new_key,
                    val: new_val,
                })
            }
            TypeKind::MutDict { key, val } => {
                let new_key = self.substitute(key, bindings);
                let new_val = self.substitute(val, bindings);
                self.intern(TypeKind::MutDict {
                    key: new_key,
                    val: new_val,
                })
            }
            TypeKind::Tuple(elems) => {
                let new_elems: Vec<_> = elems
                    .into_iter()
                    .map(|e| self.substitute(e, bindings))
                    .collect();
                self.intern(TypeKind::Tuple(new_elems))
            }
            TypeKind::Func { params, ret } => {
                let new_params: Vec<_> = params
                    .into_iter()
                    .map(|p| self.substitute(p, bindings))
                    .collect();
                let new_ret = self.substitute(ret, bindings);
                self.intern(TypeKind::Func {
                    params: new_params,
                    ret: new_ret,
                })
            }
            TypeKind::Custom { name, args } => {
                let new_args: Vec<_> = args
                    .into_iter()
                    .map(|a| self.substitute(a, bindings))
                    .collect();
                self.intern(TypeKind::Custom {
                    name,
                    args: new_args,
                })
            }
        }
    }

    // ── Concreteness checking ──

    /// Returns `true` if the type is fully concrete (contains no
    /// `Generic` or `InferVar`).
    pub fn is_concrete(&self, ty: TypeId) -> bool {
        match self.get(ty) {
            TypeKind::Int
            | TypeKind::Num
            | TypeKind::Str
            | TypeKind::Bool
            | TypeKind::Null
            | TypeKind::SelfType
            | TypeKind::Unknown => true,

            TypeKind::Generic { .. } | TypeKind::InferVar { .. } => false,

            TypeKind::Arr(inner) => self.is_concrete(*inner),
            TypeKind::Iter(inner) => self.is_concrete(*inner),
            TypeKind::MutArr(inner) => self.is_concrete(*inner),
            TypeKind::Set(inner) => self.is_concrete(*inner),
            TypeKind::MutSet(inner) => self.is_concrete(*inner),
            TypeKind::Maybe(inner) => self.is_concrete(*inner),
            TypeKind::Dict { key, val } => self.is_concrete(*key) && self.is_concrete(*val),
            TypeKind::MutDict { key, val } => self.is_concrete(*key) && self.is_concrete(*val),

            TypeKind::Tuple(elems) => elems.iter().all(|e| self.is_concrete(*e)),
            TypeKind::Func { params, ret, .. } => {
                params.iter().all(|p| self.is_concrete(*p)) && self.is_concrete(*ret)
            }
            TypeKind::Custom { args, .. } => args.iter().all(|a| self.is_concrete(*a)),
        }
    }
}

impl Default for TypeArena {
    fn default() -> Self {
        Self::new()
    }
}

// ── Lowering: TypeNode → TypeId ──

/// Lower a parser-produced `TypeNode` to an interned `TypeId`.
///
/// `generic_params` maps generic parameter `IdentId`s to their
/// interned `TypeId` (typically `TypeKind::Generic`).  When a
/// `TypeNode::TypeParamRef` is encountered, its name is looked up
/// in this map.
pub fn lower_type_node(
    type_node: &TypeNode,
    arena: &mut TypeArena,
    generic_params: &FxHashMap<IdentId, TypeId>,
) -> TypeId {
    match type_node {
        TypeNode::Int => arena.int_id(),
        TypeNode::Num => arena.num_id(),
        TypeNode::Str => arena.str_id(),
        TypeNode::Bool => arena.bool_id(),
        TypeNode::Null => arena.null_id(),
        TypeNode::SelfType => arena.self_id(),

        TypeNode::TypeParamRef { name, traits } => {
            // If this generic param is registered, return its TypeId.
            if let Some(&tid) = generic_params.get(name) {
                tid
            } else {
                // Not registered — create a new Generic TypeId.
                arena.intern(TypeKind::Generic {
                    name: *name,
                    bounds: traits.clone(),
                })
            }
        }

        TypeNode::Arr(inner) => {
            let inner_id = lower_type_node(inner, arena, generic_params);
            arena.intern(TypeKind::Arr(inner_id))
        }
        TypeNode::Iter(inner) => {
            let inner_id = lower_type_node(inner, arena, generic_params);
            arena.intern(TypeKind::Iter(inner_id))
        }
        TypeNode::MutArr(inner) => {
            let inner_id = lower_type_node(inner, arena, generic_params);
            arena.intern(TypeKind::MutArr(inner_id))
        }
        TypeNode::Set(inner) => {
            let inner_id = lower_type_node(inner, arena, generic_params);
            arena.intern(TypeKind::Set(inner_id))
        }
        TypeNode::MutSet(inner) => {
            let inner_id = lower_type_node(inner, arena, generic_params);
            arena.intern(TypeKind::MutSet(inner_id))
        }
        TypeNode::Maybe(inner) => {
            let inner_id = lower_type_node(inner, arena, generic_params);
            arena.intern(TypeKind::Maybe(inner_id))
        }

        TypeNode::Dict { key, val } => {
            let key_id = lower_type_node(key, arena, generic_params);
            let val_id = lower_type_node(val, arena, generic_params);
            arena.intern(TypeKind::Dict {
                key: key_id,
                val: val_id,
            })
        }
        TypeNode::MutDict { key, val } => {
            let key_id = lower_type_node(key, arena, generic_params);
            let val_id = lower_type_node(val, arena, generic_params);
            arena.intern(TypeKind::MutDict {
                key: key_id,
                val: val_id,
            })
        }

        TypeNode::Tup(elems) => {
            let elem_ids: Vec<_> = elems
                .iter()
                .map(|e| lower_type_node(e, arena, generic_params))
                .collect();
            arena.intern(TypeKind::Tuple(elem_ids))
        }

        TypeNode::Func { params, ret } => {
            let param_ids: Vec<_> = params
                .iter()
                .map(|p| lower_type_node(p, arena, generic_params))
                .collect();
            let ret_id = lower_type_node(ret, arena, generic_params);
            // TypeNode::Func comes from parser type annotations which
            // are never type-associated functions — only trait function
            // signatures carry that flag.
            arena.intern(TypeKind::Func {
                params: param_ids,
                ret: ret_id,
            })
        }

        TypeNode::Named { name, params } => {
            let arg_ids: Vec<_> = params
                .iter()
                .map(|p| lower_type_node(p, arena, generic_params))
                .collect();
            arena.intern(TypeKind::Custom {
                name: *name,
                args: arg_ids,
            })
        }
    }
}

// ════════════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use crate::interner::Interner;

    fn ident(interner: &mut Interner, s: &str) -> IdentId {
        interner.intern(s)
    }

    // ── Basic interning and hash consing ──

    #[test]
    fn intern_primitives() {
        let arena = TypeArena::new();
        assert_eq!(arena.get(arena.int_id()), &TypeKind::Int);
        assert_eq!(arena.get(arena.num_id()), &TypeKind::Num);
        assert_eq!(arena.get(arena.str_id()), &TypeKind::Str);
        assert_eq!(arena.get(arena.bool_id()), &TypeKind::Bool);
        assert_eq!(arena.get(arena.null_id()), &TypeKind::Null);
        assert_eq!(arena.get(arena.self_id()), &TypeKind::SelfType);
        assert_eq!(arena.get(arena.unknown_id()), &TypeKind::Unknown);
    }

    #[test]
    fn hash_consing_same_type_same_id() {
        let mut arena = TypeArena::new();
        let a = arena.intern(TypeKind::Int);
        let b = arena.intern(TypeKind::Int);
        assert_eq!(a, b);
    }

    #[test]
    fn hash_consing_compound() {
        let mut arena = TypeArena::new();
        let int = arena.intern(TypeKind::Int);
        let arr1 = arena.intern(TypeKind::Arr(int));
        let arr2 = arena.intern(TypeKind::Arr(int));
        assert_eq!(arr1, arr2);
    }

    #[test]
    fn different_types_different_ids() {
        let mut arena = TypeArena::new();
        let int = arena.intern(TypeKind::Int);
        let num = arena.intern(TypeKind::Num);
        assert_ne!(int, num);
    }

    // ── Inference variables ──

    #[test]
    fn infer_var_uniqueness() {
        let mut arena = TypeArena::new();
        let v1 = arena.fresh_infer_var();
        let v2 = arena.fresh_infer_var();
        assert_ne!(v1, v2, "each InferVar must be unique");
    }

    #[test]
    fn infer_var_kind() {
        let mut arena = TypeArena::new();
        let v = arena.fresh_infer_var();
        match arena.get(v) {
            TypeKind::InferVar { id } => assert_eq!(*id, 0),
            other => panic!("expected InferVar, got {:?}", other),
        }
    }

    // ── Substitution ──

    #[test]
    fn substitute_generic() {
        let mut arena = TypeArena::new();
        let mut interner = Interner::new();
        let t_name = ident(&mut interner, "T");
        let int = arena.intern(TypeKind::Int);
        let t_var = arena.intern(TypeKind::Generic {
            name: t_name,
            bounds: vec![],
        });

        let mut bindings = FxHashMap::default();
        bindings.insert(t_name, int);

        let result = arena.substitute(t_var, &bindings);
        assert_eq!(result, int);
    }

    #[test]
    fn substitute_unbound_generic_unchanged() {
        let mut arena = TypeArena::new();
        let mut interner = Interner::new();
        let t_name = ident(&mut interner, "T");
        let u_name = ident(&mut interner, "U");
        let t_var = arena.intern(TypeKind::Generic {
            name: t_name,
            bounds: vec![],
        });

        let mut bindings = FxHashMap::default();
        bindings.insert(u_name, arena.int_id());

        let result = arena.substitute(t_var, &bindings);
        assert_eq!(result, t_var);
    }

    #[test]
    fn substitute_array_of_generic() {
        let mut arena = TypeArena::new();
        let mut interner = Interner::new();
        let t_name = ident(&mut interner, "T");
        let int = arena.intern(TypeKind::Int);
        let t_var = arena.intern(TypeKind::Generic {
            name: t_name,
            bounds: vec![],
        });
        let arr_t = arena.intern(TypeKind::Arr(t_var));
        let arr_int = arena.intern(TypeKind::Arr(int));

        let mut bindings = FxHashMap::default();
        bindings.insert(t_name, int);

        let result = arena.substitute(arr_t, &bindings);
        assert_eq!(result, arr_int);
    }

    #[test]
    fn substitute_infer_var_unchanged() {
        let mut arena = TypeArena::new();
        let mut interner = Interner::new();
        let t_name = ident(&mut interner, "T");
        let infer = arena.fresh_infer_var();

        let mut bindings = FxHashMap::default();
        bindings.insert(t_name, arena.int_id());

        let result = arena.substitute(infer, &bindings);
        assert_eq!(result, infer);
    }

    #[test]
    fn substitute_self_unchanged() {
        let mut arena = TypeArena::new();
        let mut interner = Interner::new();
        let t_name = ident(&mut interner, "T");
        let self_ty = arena.self_id();

        let mut bindings = FxHashMap::default();
        bindings.insert(t_name, arena.int_id());

        let result = arena.substitute(self_ty, &bindings);
        assert_eq!(result, self_ty);
    }

    #[test]
    fn substitute_primitive_unchanged() {
        let mut arena = TypeArena::new();
        let mut interner = Interner::new();
        let t_name = ident(&mut interner, "T");
        let mut bindings = FxHashMap::default();
        bindings.insert(t_name, arena.int_id());

        assert_eq!(arena.substitute(arena.int_id(), &bindings), arena.int_id());
        assert_eq!(arena.substitute(arena.num_id(), &bindings), arena.num_id());
        assert_eq!(arena.substitute(arena.str_id(), &bindings), arena.str_id());
    }

    #[test]
    fn substitute_complex_nested() {
        let mut arena = TypeArena::new();
        let mut interner = Interner::new();
        let t_name = ident(&mut interner, "T");
        let int = arena.intern(TypeKind::Int);
        let t_var = arena.intern(TypeKind::Generic {
            name: t_name,
            bounds: vec![],
        });

        // Maybe[Array[T]] → Maybe[Array[Int]]
        let arr_t = arena.intern(TypeKind::Arr(t_var));
        let maybe_arr_t = arena.intern(TypeKind::Maybe(arr_t));
        let arr_int = arena.intern(TypeKind::Arr(int));
        let maybe_arr_int = arena.intern(TypeKind::Maybe(arr_int));

        let mut bindings = FxHashMap::default();
        bindings.insert(t_name, int);

        let result = arena.substitute(maybe_arr_t, &bindings);
        assert_eq!(result, maybe_arr_int);
    }

    #[test]
    fn substitute_func_type() {
        let mut arena = TypeArena::new();
        let mut interner = Interner::new();
        let t_name = ident(&mut interner, "T");
        let int = arena.intern(TypeKind::Int);
        let t_var = arena.intern(TypeKind::Generic {
            name: t_name,
            bounds: vec![],
        });

        // Func[T, T: Bool] → Func[Int, Int: Bool]
        let bool_id = arena.bool_id();
        let func_t = arena.intern(TypeKind::Func {
            params: vec![t_var, t_var],
            ret: bool_id,
        });
        let func_int = arena.intern(TypeKind::Func {
            params: vec![int, int],
            ret: bool_id,
        });

        let mut bindings = FxHashMap::default();
        bindings.insert(t_name, int);

        let result = arena.substitute(func_t, &bindings);
        assert_eq!(result, func_int);
    }

    // ── Concreteness ──

    #[test]
    fn is_concrete_true_for_primitives() {
        let arena = TypeArena::new();
        assert!(arena.is_concrete(arena.int_id()));
        assert!(arena.is_concrete(arena.num_id()));
        assert!(arena.is_concrete(arena.str_id()));
        assert!(arena.is_concrete(arena.bool_id()));
        assert!(arena.is_concrete(arena.null_id()));
        assert!(arena.is_concrete(arena.self_id()));
        assert!(arena.is_concrete(arena.unknown_id()));
    }

    #[test]
    fn unknown_is_hash_consed() {
        let mut arena = TypeArena::new();
        let a = arena.intern(TypeKind::Unknown);
        let b = arena.intern(TypeKind::Unknown);
        assert_eq!(a, b);
        assert_eq!(a, arena.unknown_id());
    }

    #[test]
    fn substitute_unknown_unchanged() {
        let mut arena = TypeArena::new();
        let mut interner = Interner::new();
        let t_name = ident(&mut interner, "T");
        let mut bindings = FxHashMap::default();
        bindings.insert(t_name, arena.int_id());
        assert_eq!(
            arena.substitute(arena.unknown_id(), &bindings),
            arena.unknown_id()
        );
    }

    #[test]
    fn is_concrete_false_for_generic() {
        let mut arena = TypeArena::new();
        let mut interner = Interner::new();
        let t_var = arena.intern(TypeKind::Generic {
            name: ident(&mut interner, "T"),
            bounds: vec![],
        });
        assert!(!arena.is_concrete(t_var));
    }

    #[test]
    fn is_concrete_false_for_infer_var() {
        let mut arena = TypeArena::new();
        let v = arena.fresh_infer_var();
        assert!(!arena.is_concrete(v));
    }

    #[test]
    fn is_concrete_false_for_array_of_generic() {
        let mut arena = TypeArena::new();
        let mut interner = Interner::new();
        let t_var = arena.intern(TypeKind::Generic {
            name: ident(&mut interner, "T"),
            bounds: vec![],
        });
        let arr_t = arena.intern(TypeKind::Arr(t_var));
        assert!(!arena.is_concrete(arr_t));
    }

    #[test]
    fn is_concrete_true_for_array_of_int() {
        let mut arena = TypeArena::new();
        let arr_int = arena.intern(TypeKind::Arr(arena.int_id()));
        assert!(arena.is_concrete(arr_int));
    }

    // ── Lowering TypeNode → TypeId ──

    #[test]
    fn lower_int() {
        let mut arena = TypeArena::new();
        let generic_params = FxHashMap::default();
        let result = lower_type_node(&TypeNode::Int, &mut arena, &generic_params);
        assert_eq!(result, arena.int_id());
    }

    #[test]
    fn lower_num() {
        let mut arena = TypeArena::new();
        let generic_params = FxHashMap::default();
        let result = lower_type_node(&TypeNode::Num, &mut arena, &generic_params);
        assert_eq!(result, arena.num_id());
    }

    #[test]
    fn lower_named_type() {
        let mut arena = TypeArena::new();
        let mut interner = Interner::new();
        let generic_params = FxHashMap::default();
        let name = ident(&mut interner, "Foo");

        let type_node = TypeNode::Named {
            name,
            params: vec![],
        };
        let result = lower_type_node(&type_node, &mut arena, &generic_params);
        let expected = arena.intern(TypeKind::Custom { name, args: vec![] });
        assert_eq!(result, expected);
    }

    #[test]
    fn lower_named_with_args() {
        let mut arena = TypeArena::new();
        let mut interner = Interner::new();
        let generic_params = FxHashMap::default();
        let name = ident(&mut interner, "Pair");

        let type_node = TypeNode::Named {
            name,
            params: vec![TypeNode::Int, TypeNode::Str],
        };
        let result = lower_type_node(&type_node, &mut arena, &generic_params);
        let expected = arena.intern(TypeKind::Custom {
            name,
            args: vec![arena.int_id(), arena.str_id()],
        });
        assert_eq!(result, expected);
    }

    #[test]
    fn lower_type_param_ref_resolved() {
        let mut arena = TypeArena::new();
        let mut interner = Interner::new();
        let t_name = ident(&mut interner, "T");
        let t_generic = arena.intern(TypeKind::Generic {
            name: t_name,
            bounds: vec![],
        });

        let mut generic_params = FxHashMap::default();
        generic_params.insert(t_name, t_generic);

        let type_node = TypeNode::TypeParamRef {
            name: t_name,
            traits: vec![],
        };
        let result = lower_type_node(&type_node, &mut arena, &generic_params);
        assert_eq!(result, t_generic);
    }

    #[test]
    fn lower_type_param_ref_unresolved_creates_new() {
        let mut arena = TypeArena::new();
        let mut interner = Interner::new();
        let t_name = ident(&mut interner, "T");
        let generic_params = FxHashMap::default();

        let type_node = TypeNode::TypeParamRef {
            name: t_name,
            traits: vec![],
        };
        let result = lower_type_node(&type_node, &mut arena, &generic_params);
        match arena.get(result) {
            TypeKind::Generic { name, .. } => assert_eq!(*name, t_name),
            other => panic!("expected Generic, got {:?}", other),
        }
    }

    #[test]
    fn lower_array() {
        let mut arena = TypeArena::new();
        let generic_params = FxHashMap::default();
        let result = lower_type_node(
            &TypeNode::Arr(Box::new(TypeNode::Int)),
            &mut arena,
            &generic_params,
        );
        let expected = arena.intern(TypeKind::Arr(arena.int_id()));
        assert_eq!(result, expected);
    }

    #[test]
    fn lower_maybe() {
        let mut arena = TypeArena::new();
        let generic_params = FxHashMap::default();
        let result = lower_type_node(
            &TypeNode::Maybe(Box::new(TypeNode::Num)),
            &mut arena,
            &generic_params,
        );
        let expected = arena.intern(TypeKind::Maybe(arena.num_id()));
        assert_eq!(result, expected);
    }

    #[test]
    fn lower_func_type() {
        let mut arena = TypeArena::new();
        let generic_params = FxHashMap::default();
        let result = lower_type_node(
            &TypeNode::Func {
                params: vec![TypeNode::Int, TypeNode::Num],
                ret: Box::new(TypeNode::Bool),
            },
            &mut arena,
            &generic_params,
        );
        let expected = arena.intern(TypeKind::Func {
            params: vec![arena.int_id(), arena.num_id()],
            ret: arena.bool_id(),
        });
        assert_eq!(result, expected);
    }

    #[test]
    fn lower_tuple() {
        let mut arena = TypeArena::new();
        let generic_params = FxHashMap::default();
        let result = lower_type_node(
            &TypeNode::Tup(vec![TypeNode::Int, TypeNode::Str]),
            &mut arena,
            &generic_params,
        );
        let expected = arena.intern(TypeKind::Tuple(vec![arena.int_id(), arena.str_id()]));
        assert_eq!(result, expected);
    }

    #[test]
    fn lower_self_type() {
        let mut arena = TypeArena::new();
        let generic_params = FxHashMap::default();
        let result = lower_type_node(&TypeNode::SelfType, &mut arena, &generic_params);
        assert_eq!(result, arena.self_id());
    }

    #[test]
    fn lower_with_generic_param_in_compound() {
        let mut arena = TypeArena::new();
        let mut interner = Interner::new();
        let t_name = ident(&mut interner, "T");
        let t_generic = arena.intern(TypeKind::Generic {
            name: t_name,
            bounds: vec![],
        });

        let mut generic_params = FxHashMap::default();
        generic_params.insert(t_name, t_generic);

        // Arr[T] → Array(Generic { name: T })
        let type_node = TypeNode::Arr(Box::new(TypeNode::TypeParamRef {
            name: t_name,
            traits: vec![],
        }));
        let result = lower_type_node(&type_node, &mut arena, &generic_params);
        let expected = arena.intern(TypeKind::Arr(t_generic));
        assert_eq!(result, expected);
    }

    #[test]
    fn lower_dict() {
        let mut arena = TypeArena::new();
        let generic_params = FxHashMap::default();
        let result = lower_type_node(
            &TypeNode::Dict {
                key: Box::new(TypeNode::Str),
                val: Box::new(TypeNode::Int),
            },
            &mut arena,
            &generic_params,
        );
        let expected = arena.intern(TypeKind::Dict {
            key: arena.str_id(),
            val: arena.int_id(),
        });
        assert_eq!(result, expected);
    }

    #[test]
    fn lower_null() {
        let mut arena = TypeArena::new();
        let generic_params = FxHashMap::default();
        let result = lower_type_node(&TypeNode::Null, &mut arena, &generic_params);
        assert_eq!(result, arena.null_id());
    }
}
