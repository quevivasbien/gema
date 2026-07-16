/// Builtin function signatures and JS emission for Gema.
///
/// Builtins are functions known to the compiler — they have no user-
/// defined body.  Their type signatures are hard-coded so inference
/// can resolve call types, and their JS emission is generated directly
/// (often involving inline code or reference to shared helper classes).
use crate::hir::HirExpr;
use crate::types::{TypeArena, TypeId, TypeKind};

/// A builtin function recognised by the compiler.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BuiltinFunc {
    // ── Type conversions ──
    ToStr,
    ToInt,
    ToNum,
    ToBool,
    TypeOf,

    // ── Maybe / None operations ──
    Unwrap,
    IsNone,
    Some,

    // ── Iterator constructors ──
    Range,
    Iterate,
    ToIter,
    ToArr,

    // ── Iterator transformations ──
    Map,
    Filter,
    Take,
    TakeWhile,
    Drop,
    DropWhile,
    Repeat,
    RepeatInner,
    Step,
    Zip,
    Collect,

    // ── Iterator terminal operations ──
    Reduce,
    Last,
    Length,
    Head,
    Contains,
    Find,

    // ── Mutable collection ops ──
    Push,
    Put,
    Pop,
    Remove,

    // ── Mut / immut conversion ──
    Trans,
    Detrans,
    UnsafeTrans,

    // ── String operations ──
    Split,
    Replace,

    // ── Set operations ──
    Union,
    Intersect,

    // ── Constructor-like ──
    Dict,
    Set,

    // ── Combinatorics ──
    Cartesian,
    Permutations,
    Combinations,

    // ── Math helpers ──
    Mod,
    ArrayEq,
}

impl BuiltinFunc {
    /// Try to match a function name (and optionally the arg-count) to
    /// a builtin.  Returns `None` if the name is not a builtin.
    pub fn try_from_name(name: &str) -> Option<BuiltinFunc> {
        match name {
            // Type conversions
            "toStr" => Some(BuiltinFunc::ToStr),
            "toInt" => Some(BuiltinFunc::ToInt),
            "toNum" => Some(BuiltinFunc::ToNum),
            "toBool" => Some(BuiltinFunc::ToBool),
            "typeof" => Some(BuiltinFunc::TypeOf),

            // Maybe / None
            "unwrap" => Some(BuiltinFunc::Unwrap),
            "isnone" => Some(BuiltinFunc::IsNone),
            "some" => Some(BuiltinFunc::Some),

            // Iterator constructors
            "range" => Some(BuiltinFunc::Range),
            "iterate" => Some(BuiltinFunc::Iterate),
            "toIter" => Some(BuiltinFunc::ToIter),
            "toArr" => Some(BuiltinFunc::ToArr),

            // Iterator transformations
            "map" => Some(BuiltinFunc::Map),
            "filter" => Some(BuiltinFunc::Filter),
            "take" => Some(BuiltinFunc::Take),
            "takeWhile" => Some(BuiltinFunc::TakeWhile),
            "drop" => Some(BuiltinFunc::Drop),
            "dropWhile" => Some(BuiltinFunc::DropWhile),
            "repeat" => Some(BuiltinFunc::Repeat),
            "repeatInner" => Some(BuiltinFunc::RepeatInner),
            "step" => Some(BuiltinFunc::Step),
            "zip" => Some(BuiltinFunc::Zip),
            "collect" => Some(BuiltinFunc::Collect),

            // Iterator terminal ops
            "reduce" => Some(BuiltinFunc::Reduce),
            "last" => Some(BuiltinFunc::Last),
            "length" => Some(BuiltinFunc::Length),
            "head" => Some(BuiltinFunc::Head),
            "contains" => Some(BuiltinFunc::Contains),
            "find" => Some(BuiltinFunc::Find),

            // Mutable collection ops
            "push" => Some(BuiltinFunc::Push),
            "put" => Some(BuiltinFunc::Put),
            "pop" => Some(BuiltinFunc::Pop),
            "remove" => Some(BuiltinFunc::Remove),

            // Mut / immut conversion
            "trans" => Some(BuiltinFunc::Trans),
            "detrans" => Some(BuiltinFunc::Detrans),
            "unsafeTrans" => Some(BuiltinFunc::UnsafeTrans),

            // String ops
            "split" => Some(BuiltinFunc::Split),
            "replace" => Some(BuiltinFunc::Replace),

            // Set ops
            "union" => Some(BuiltinFunc::Union),
            "intersect" => Some(BuiltinFunc::Intersect),

            // Constructor-like
            "Dict" => Some(BuiltinFunc::Dict),
            "Set" => Some(BuiltinFunc::Set),

            // Combinatorics
            "cartesian" => Some(BuiltinFunc::Cartesian),
            "permutations" => Some(BuiltinFunc::Permutations),
            "combinations" => Some(BuiltinFunc::Combinations),

            _ => None,
        }
    }

    /// Minimum and maximum number of arguments this builtin accepts.
    pub fn arity(&self) -> (usize, Option<usize>) {
        match self {
            // 1 arg
            BuiltinFunc::ToStr
            | BuiltinFunc::ToInt
            | BuiltinFunc::ToNum
            | BuiltinFunc::ToBool
            | BuiltinFunc::TypeOf
            | BuiltinFunc::IsNone
            | BuiltinFunc::Some
            | BuiltinFunc::Collect
            | BuiltinFunc::Last
            | BuiltinFunc::Length
            | BuiltinFunc::Head
            | BuiltinFunc::Pop
            | BuiltinFunc::ToIter
            | BuiltinFunc::ToArr
            | BuiltinFunc::Trans
            | BuiltinFunc::Detrans
            | BuiltinFunc::UnsafeTrans
            | BuiltinFunc::Permutations
            | BuiltinFunc::Dict
            | BuiltinFunc::Set => (1, Some(1)),

            // 2 args
            BuiltinFunc::Map
            | BuiltinFunc::Filter
            | BuiltinFunc::Take
            | BuiltinFunc::TakeWhile
            | BuiltinFunc::Drop
            | BuiltinFunc::DropWhile
            | BuiltinFunc::Repeat
            | BuiltinFunc::RepeatInner
            | BuiltinFunc::Step
            | BuiltinFunc::Contains
            | BuiltinFunc::Find
            | BuiltinFunc::Push
            | BuiltinFunc::Remove
            | BuiltinFunc::Split
            | BuiltinFunc::Union
            | BuiltinFunc::Intersect
            | BuiltinFunc::Iterate
            | BuiltinFunc::Combinations
            | BuiltinFunc::Mod
            | BuiltinFunc::ArrayEq => (2, Some(2)),

            // 3 args
            BuiltinFunc::Reduce | BuiltinFunc::Put | BuiltinFunc::Replace => (3, Some(3)),

            // // Variable arity (minimum 2, no upper bound)
            BuiltinFunc::Zip | BuiltinFunc::Cartesian => (2, None),
            // Variable arity (1-3)
            BuiltinFunc::Range => (2, Some(3)),
            // Variable arity (1 or 2)
            BuiltinFunc::Unwrap => (1, Some(2)),
        }
    }

    /// Check whether a type is a numeric type (Int or Num).
    fn is_numeric(kind: &TypeKind) -> bool {
        matches!(kind, TypeKind::Int | TypeKind::Num)
    }

    /// Infers the return type of this builtin given the argument types.
    ///
    /// Returns `None` if the argument types are incompatible with this
    /// builtin's signature.
    pub fn infer_return_type(
        &self,
        arg_types: &[TypeId],
        type_arena: &mut TypeArena,
    ) -> Option<TypeId> {
        let (min, max) = self.arity();
        if arg_types.len() < min || max.is_some_and(|m| arg_types.len() > m) {
            return None;
        }

        match self {
            // ── Type conversions ──
            BuiltinFunc::ToStr => Some(type_arena.str_id()),
            BuiltinFunc::ToInt => Some(type_arena.int_id()),
            BuiltinFunc::ToNum => Some(type_arena.num_id()),
            BuiltinFunc::ToBool => Some(type_arena.bool_id()),
            BuiltinFunc::TypeOf => Some(type_arena.str_id()),

            // ── Maybe / None ──
            BuiltinFunc::Some => {
                let inner = arg_types[0];
                Some(type_arena.intern(TypeKind::Maybe(inner)))
            }
            BuiltinFunc::IsNone => Some(type_arena.bool_id()),
            BuiltinFunc::Unwrap => {
                // Only one arg: unwrap(maybe) — return inner type
                if arg_types.len() == 1 {
                    match type_arena.get(arg_types[0]) {
                        TypeKind::Maybe(inner) => Some(*inner),
                        _ => None,
                    }
                } else if arg_types.len() == 2 {
                    // Two args: unwrap(fallback, maybe) — return inner type
                    match type_arena.get(arg_types[1]) {
                        TypeKind::Maybe(inner) => Some(*inner),
                        _ => None,
                    }
                } else {
                    None
                }
            }

            // ── Iterator constructors ──
            BuiltinFunc::Range => {
                if arg_types.len() >= 2
                    && Self::is_numeric(type_arena.get(arg_types[0]))
                    && Self::is_numeric(type_arena.get(arg_types[1]))
                {
                    Some(type_arena.intern(TypeKind::Iter(arg_types[0])))
                } else {
                    None
                }
            }
            BuiltinFunc::Iterate => {
                if arg_types.len() == 2 {
                    match type_arena.get(arg_types[0]) {
                        TypeKind::Func { params, ret } if params.len() == 1 => {
                            if *ret == params[0] {
                                Some(type_arena.intern(TypeKind::Iter(*ret)))
                            } else {
                                None
                            }
                        }
                        _ => None,
                    }
                } else {
                    None
                }
            }
            BuiltinFunc::ToIter => {
                let inner = match type_arena.get(arg_types[0]) {
                    TypeKind::Arr(inner) | TypeKind::MutArr(inner) => Some(*inner),
                    TypeKind::Iter(inner) => Some(*inner),
                    TypeKind::Set(inner) | TypeKind::MutSet(inner) => Some(*inner),
                    TypeKind::Dict { val, .. } | TypeKind::MutDict { val, .. } => Some(*val),
                    TypeKind::Str => Some(type_arena.str_id()),
                    _ => None,
                };
                inner.map(|i| type_arena.intern(TypeKind::Iter(i)))
            }
            BuiltinFunc::ToArr => {
                let inner = match type_arena.get(arg_types[0]) {
                    TypeKind::Str => Some(type_arena.str_id()),
                    TypeKind::Set(inner) | TypeKind::MutSet(inner) => Some(*inner),
                    TypeKind::Dict { key, val } | TypeKind::MutDict { key, val } => {
                        Some(type_arena.intern(TypeKind::Tuple(vec![*key, *val])))
                    }
                    _ => None,
                };
                inner.map(|i| type_arena.intern(TypeKind::Arr(i)))
            }

            // ── Iterator transformations ──
            BuiltinFunc::Map => {
                if arg_types.len() == 2 {
                    match (type_arena.get(arg_types[0]), type_arena.get(arg_types[1])) {
                        (TypeKind::Func { params, ret }, TypeKind::Iter(inner))
                        | (TypeKind::Func { params, ret }, TypeKind::Arr(inner))
                        | (TypeKind::Func { params, ret }, TypeKind::MutArr(inner))
                            if params.len() == 1 =>
                        {
                            Some(type_arena.intern(TypeKind::Iter(*ret)))
                        }
                        _ => None,
                    }
                } else {
                    None
                }
            }
            BuiltinFunc::Filter => {
                if arg_types.len() == 2 {
                    match (type_arena.get(arg_types[0]), type_arena.get(arg_types[1])) {
                        (TypeKind::Func { params, ret }, TypeKind::Iter(inner))
                        | (TypeKind::Func { params, ret }, TypeKind::Arr(inner))
                        | (TypeKind::Func { params, ret }, TypeKind::MutArr(inner))
                            if params.len() == 1 && *ret == type_arena.bool_id() =>
                        {
                            Some(type_arena.intern(TypeKind::Iter(*inner)))
                        }
                        _ => None,
                    }
                } else {
                    None
                }
            }
            BuiltinFunc::Collect => {
                let inner = match type_arena.get(arg_types[0]) {
                    TypeKind::Iter(inner) => Some(*inner),
                    TypeKind::Arr(inner) | TypeKind::MutArr(inner) => Some(*inner),
                    TypeKind::Str => Some(type_arena.str_id()),
                    _ => None,
                };
                inner.map(|i| type_arena.intern(TypeKind::Arr(i)))
            }
            BuiltinFunc::Reduce => {
                if arg_types.len() == 3 {
                    let init_ty = arg_types[1];
                    match type_arena.get(arg_types[0]) {
                        TypeKind::Func { params, ret } if params.len() == 2 && *ret == init_ty => {
                            Some(init_ty)
                        }
                        _ => None,
                    }
                } else {
                    None
                }
            }
            BuiltinFunc::Take | BuiltinFunc::Drop => {
                if arg_types.len() == 2 {
                    let inner = match type_arena.get(arg_types[1]) {
                        TypeKind::Iter(inner) => Some(*inner),
                        TypeKind::Arr(inner) | TypeKind::MutArr(inner) => Some(*inner),
                        TypeKind::Str => Some(type_arena.str_id()),
                        _ => None,
                    };
                    inner.map(|i| type_arena.intern(TypeKind::Iter(i)))
                } else {
                    None
                }
            }
            BuiltinFunc::TakeWhile | BuiltinFunc::DropWhile => {
                if arg_types.len() == 2 {
                    match (type_arena.get(arg_types[0]), type_arena.get(arg_types[1])) {
                        (TypeKind::Func { params, ret }, TypeKind::Iter(inner))
                        | (TypeKind::Func { params, ret }, TypeKind::Arr(inner))
                        | (TypeKind::Func { params, ret }, TypeKind::MutArr(inner))
                            if params.len() == 1 && *ret == type_arena.bool_id() =>
                        {
                            Some(type_arena.intern(TypeKind::Iter(*inner)))
                        }
                        _ => None,
                    }
                } else {
                    None
                }
            }
            BuiltinFunc::Repeat | BuiltinFunc::RepeatInner | BuiltinFunc::Step => {
                if arg_types.len() == 2 {
                    let inner = match type_arena.get(arg_types[1]) {
                        TypeKind::Iter(inner) => Some(*inner),
                        TypeKind::Arr(inner) | TypeKind::MutArr(inner) => Some(*inner),
                        TypeKind::Str => Some(type_arena.str_id()),
                        _ => None,
                    };
                    inner.map(|i| type_arena.intern(TypeKind::Iter(i)))
                } else {
                    None
                }
            }
            BuiltinFunc::Zip => {
                if arg_types.len() >= 2 {
                    let mut inner_types = Vec::new();
                    for arg in arg_types {
                        let inner = match type_arena.get(*arg) {
                            TypeKind::Iter(inner)
                            | TypeKind::Arr(inner)
                            | TypeKind::MutArr(inner) => *inner,
                            TypeKind::Str => type_arena.str_id(),
                            _ => return None,
                        };
                        inner_types.push(inner);
                    }
                    let tup = type_arena.intern(TypeKind::Tuple(inner_types));
                    Some(type_arena.intern(TypeKind::Iter(tup)))
                } else {
                    None
                }
            }
            BuiltinFunc::Cartesian => {
                if arg_types.len() >= 2 {
                    let mut inner_types = Vec::new();
                    for arg in arg_types {
                        let inner = match type_arena.get(*arg) {
                            TypeKind::Iter(inner)
                            | TypeKind::Arr(inner)
                            | TypeKind::MutArr(inner) => *inner,
                            TypeKind::Str => type_arena.str_id(),
                            _ => return None,
                        };
                        inner_types.push(inner);
                    }
                    let tup = type_arena.intern(TypeKind::Tuple(inner_types));
                    Some(type_arena.intern(TypeKind::Iter(tup)))
                } else {
                    None
                }
            }
            BuiltinFunc::Permutations => {
                let inner = match type_arena.get(arg_types[0]) {
                    TypeKind::Iter(inner) | TypeKind::Arr(inner) | TypeKind::MutArr(inner) => {
                        *inner
                    }
                    _ => return None,
                };
                let arr = type_arena.intern(TypeKind::Arr(inner));
                Some(type_arena.intern(TypeKind::Iter(arr)))
            }
            BuiltinFunc::Combinations => {
                if arg_types.len() == 2 {
                    let inner = match type_arena.get(arg_types[1]) {
                        TypeKind::Iter(inner) | TypeKind::Arr(inner) | TypeKind::MutArr(inner) => {
                            *inner
                        }
                        _ => return None,
                    };
                    let arr = type_arena.intern(TypeKind::Arr(inner));
                    Some(type_arena.intern(TypeKind::Iter(arr)))
                } else {
                    None
                }
            }

            // ── Terminal operations ──
            BuiltinFunc::Last | BuiltinFunc::Head => {
                let inner = match type_arena.get(arg_types[0]) {
                    TypeKind::Iter(inner) | TypeKind::Arr(inner) | TypeKind::MutArr(inner) => {
                        Some(*inner)
                    }
                    TypeKind::Str => Some(type_arena.str_id()),
                    _ => None,
                };
                inner.map(|i| type_arena.intern(TypeKind::Maybe(i)))
            }
            BuiltinFunc::Length => Some(type_arena.num_id()),
            BuiltinFunc::Contains => Some(type_arena.bool_id()),
            BuiltinFunc::Find => {
                if let TypeKind::Str = type_arena.get(arg_types[1]) {
                    Some(type_arena.intern(TypeKind::Maybe(type_arena.num_id())))
                } else {
                    let _inner = match type_arena.get(arg_types[1]) {
                        TypeKind::Arr(inner) | TypeKind::MutArr(inner) => *inner,
                        TypeKind::Iter(inner) => *inner,
                        _ => return None,
                    };
                    Some(type_arena.intern(TypeKind::Maybe(type_arena.num_id())))
                }
            }

            // ── Mutable collection ops ──
            BuiltinFunc::Push => {
                // push(value, collection) -> collection type
                match type_arena.get(arg_types[1]) {
                    TypeKind::MutArr(_) | TypeKind::MutSet(_) => Some(arg_types[1]),
                    _ => None,
                }
            }
            BuiltinFunc::Put => {
                // put(value, key, collection) -> collection type
                match type_arena.get(arg_types[2]) {
                    TypeKind::MutArr(_) | TypeKind::MutDict { .. } => Some(arg_types[2]),
                    _ => None,
                }
            }
            BuiltinFunc::Pop => match type_arena.get(arg_types[0]) {
                TypeKind::MutArr(_) => Some(arg_types[0]),
                _ => None,
            },
            BuiltinFunc::Remove => match type_arena.get(arg_types[1]) {
                TypeKind::MutSet(_) | TypeKind::MutDict { .. } => Some(arg_types[1]),
                _ => None,
            },

            // ── Mut / immut conversion ──
            BuiltinFunc::Trans => {
                let kind = type_arena.get(arg_types[0]);
                match kind {
                    TypeKind::Arr(inner) => Some(type_arena.intern(TypeKind::MutArr(*inner))),
                    TypeKind::Dict { key, val } => Some(type_arena.intern(TypeKind::MutDict {
                        key: *key,
                        val: *val,
                    })),
                    TypeKind::Set(inner) => Some(type_arena.intern(TypeKind::MutSet(*inner))),
                    _ => None,
                }
            }
            BuiltinFunc::Detrans => {
                let kind = type_arena.get(arg_types[0]);
                match kind {
                    TypeKind::MutArr(inner) => Some(type_arena.intern(TypeKind::Arr(*inner))),
                    TypeKind::MutDict { key, val } => Some(type_arena.intern(TypeKind::Dict {
                        key: *key,
                        val: *val,
                    })),
                    TypeKind::MutSet(inner) => Some(type_arena.intern(TypeKind::Set(*inner))),
                    _ => None,
                }
            }
            BuiltinFunc::UnsafeTrans => {
                let kind = type_arena.get(arg_types[0]);
                match kind {
                    TypeKind::Arr(inner) => Some(type_arena.intern(TypeKind::MutArr(*inner))),
                    TypeKind::Dict { key, val } => Some(type_arena.intern(TypeKind::MutDict {
                        key: *key,
                        val: *val,
                    })),
                    TypeKind::Set(inner) => Some(type_arena.intern(TypeKind::MutSet(*inner))),
                    _ => None,
                }
            }

            // ── String ops ──
            BuiltinFunc::Split => {
                if arg_types.len() == 2 {
                    Some(type_arena.intern(TypeKind::Arr(type_arena.str_id())))
                } else {
                    None
                }
            }
            BuiltinFunc::Replace => {
                if arg_types.len() == 3 {
                    Some(type_arena.str_id())
                } else {
                    None
                }
            }

            // ── Set ops ──
            BuiltinFunc::Union | BuiltinFunc::Intersect => {
                if arg_types.len() == 2 {
                    match (type_arena.get(arg_types[0]), type_arena.get(arg_types[1])) {
                        (TypeKind::Set(_), TypeKind::Set(_)) => Some(arg_types[0]),
                        _ => None,
                    }
                } else {
                    None
                }
            }

            // ── Constructor-like ──
            BuiltinFunc::Dict => {
                let inner = match type_arena.get(arg_types[0]) {
                    TypeKind::Arr(inner) => match type_arena.get(*inner) {
                        TypeKind::Tuple(elems) if elems.len() == 2 => Some((elems[0], elems[1])),
                        _ => None,
                    },
                    _ => None,
                };
                #[allow(clippy::manual_map)]
                // Using explicit match because the closure would conflict
                // with the mutable borrow on `type_arena`.
                match inner {
                    Some((key, val)) => Some(type_arena.intern(TypeKind::Dict { key, val })),
                    None => None,
                }
            }
            BuiltinFunc::Set => match type_arena.get(arg_types[0]) {
                TypeKind::Arr(inner) => Some(type_arena.intern(TypeKind::Set(*inner))),
                _ => None,
            },

            // ── Math ──
            BuiltinFunc::Mod | BuiltinFunc::ArrayEq => Some(arg_types[0]),
        }
    }

    /// Emit the JS code for this builtin given its argument expressions.
    ///
    /// Returns the JS source string for the call expression.
    pub fn emit_js(&self, args: &[&str]) -> String {
        fn a<'a>(args: &'a [&str], i: usize) -> &'a str {
            args.get(i).copied().unwrap_or("undefined")
        }
        match self {
            // ── Type conversions ──
            BuiltinFunc::ToStr => format!("String({})", a(args, 0)),
            BuiltinFunc::ToInt => {
                format!("BigInt(Math.trunc({}))", a(args, 0))
            }
            BuiltinFunc::ToNum => format!("Number({})", a(args, 0)),
            BuiltinFunc::ToBool => format!("Boolean({})", a(args, 0)),
            BuiltinFunc::TypeOf => args[0].to_string(),

            // ── Maybe / None ──
            BuiltinFunc::Some => args[0].to_string(),
            BuiltinFunc::IsNone => format!("{} === null", a(args, 0)),
            BuiltinFunc::Unwrap => {
                if args.len() == 1 {
                    format!("$unwrapNoFallback$({})", a(args, 0))
                } else {
                    format!("$unwrapWithFallback$({}, {})", a(args, 0), a(args, 1))
                }
            }

            // ── Iterator constructors ──
            BuiltinFunc::Range => {
                if args.len() == 3 {
                    format!(
                        "new $IntRangeIterator$({}, {}, {})",
                        a(args, 0),
                        a(args, 1),
                        a(args, 2)
                    )
                } else {
                    format!("new $IntRangeIterator$({}, {})", a(args, 0), a(args, 1))
                }
            }
            BuiltinFunc::Iterate => {
                format!("new $IterateIterator$({}, {})", a(args, 0), a(args, 1))
            }
            BuiltinFunc::ToIter => format!("new $ArrayIterator$({})", a(args, 0)),
            BuiltinFunc::ToArr => format!("[...{}]", a(args, 0)),

            // ── Iterator transformations ──
            BuiltinFunc::Map => format!(
                "new $MapIterator$({}, new $ArrayIterator$({}))",
                a(args, 0),
                a(args, 1)
            ),
            BuiltinFunc::Filter => format!(
                "new $FilterIterator$({}, new $ArrayIterator$({}))",
                a(args, 0),
                a(args, 1)
            ),
            BuiltinFunc::Take => format!(
                "new $TakeIterator$({}, new $ArrayIterator$({}))",
                a(args, 0),
                a(args, 1)
            ),
            BuiltinFunc::TakeWhile => format!(
                "new $TakeWhileIterator$({}, new $ArrayIterator$({}))",
                a(args, 0),
                a(args, 1)
            ),
            BuiltinFunc::Drop => format!(
                "new $DropIterator$({}, new $ArrayIterator$({}))",
                a(args, 0),
                a(args, 1)
            ),
            BuiltinFunc::DropWhile => format!(
                "new $DropWhileIterator$({}, new $ArrayIterator$({}))",
                a(args, 0),
                a(args, 1)
            ),
            BuiltinFunc::Repeat => format!(
                "new $RepeatIterator$({}, new $ArrayIterator$({}))",
                a(args, 0),
                a(args, 1)
            ),
            BuiltinFunc::RepeatInner => format!(
                "new $RepeatInnerIterator$({}, new $ArrayIterator$({}))",
                a(args, 0),
                a(args, 1)
            ),
            BuiltinFunc::Step => format!(
                "new $StepIterator$({}, new $ArrayIterator$({}))",
                a(args, 0),
                a(args, 1)
            ),
            BuiltinFunc::Zip => {
                let inner: Vec<String> = args
                    .iter()
                    .map(|a| format!("new $ArrayIterator$({})", a))
                    .collect();
                format!("new $ZipIterator$({})", inner.join(", "))
            }
            BuiltinFunc::Collect => format!("$collect$({})", a(args, 0)),

            // ── Iterator terminal ops ──
            BuiltinFunc::Reduce => format!(
                "$reduce$({}, {}, new $ArrayIterator$({}))",
                a(args, 0),
                a(args, 1),
                a(args, 2)
            ),
            BuiltinFunc::Last => format!("$last$({})", a(args, 0)),
            BuiltinFunc::Length => format!("({}).length", a(args, 0)),
            BuiltinFunc::Head => format!("({}[0] ?? null)", a(args, 0)),
            BuiltinFunc::Contains => format!("({}).indexOf({}) !== -1", a(args, 1), a(args, 0)),
            BuiltinFunc::Find => format!(
                "((i) => i === -1 ? null : i)({}).indexOf({}))",
                a(args, 1),
                a(args, 0)
            ),

            // ── Mutable collection ops ──
            BuiltinFunc::Push => format!("$push$({}, {})", a(args, 0), a(args, 1)),
            BuiltinFunc::Put => format!("$put$({}, {}, {})", a(args, 0), a(args, 1), a(args, 2)),
            BuiltinFunc::Pop => format!("$pop$({})", a(args, 0)),
            BuiltinFunc::Remove => format!("$removeMutDict$({}, {})", a(args, 0), a(args, 1)),

            // ── Mut / immut conversion ──
            BuiltinFunc::Trans => format!("[...{}]", a(args, 0)),
            BuiltinFunc::Detrans => args[0].to_string(),
            BuiltinFunc::UnsafeTrans => args[0].to_string(),

            // ── String ops ──
            BuiltinFunc::Split => format!("{}.split({})", a(args, 1), a(args, 0)),
            BuiltinFunc::Replace => {
                format!("{}.replaceAll({}, {})", a(args, 2), a(args, 0), a(args, 1))
            }

            // ── Set ops ──
            BuiltinFunc::Union => format!("new Set([...{}, ...{}])", a(args, 0), a(args, 1)),
            BuiltinFunc::Intersect => {
                format!(
                    "new Set([...{}].filter(x => {}.has(x)))",
                    a(args, 0),
                    a(args, 1)
                )
            }

            // ── Constructor-like ──
            BuiltinFunc::Dict => format!("new Map({})", a(args, 0)),
            BuiltinFunc::Set => format!("new Set({})", a(args, 0)),

            // ── Combinatorics ──
            BuiltinFunc::Cartesian => {
                let inner: Vec<String> = args
                    .iter()
                    .map(|a| format!("new $ArrayIterator$({})", a))
                    .collect();
                format!("new $CartesianIterator$({})", inner.join(", "))
            }
            BuiltinFunc::Permutations => format!("new $PermutationsIterator$({})", a(args, 0)),
            BuiltinFunc::Combinations => {
                format!("new $CombinationsIterator$({}, {})", a(args, 0), a(args, 1))
            }

            // ── Math ──
            BuiltinFunc::Mod => format!("$mod$({}, {})", a(args, 0), a(args, 1)),
            BuiltinFunc::ArrayEq => format!("$arrayEq$({}, {})", a(args, 0), a(args, 1)),
        }
    }
}

/// Return the JS helper code for a given helper name, if it exists.
///
/// Only helpers that are actually required (via `required_helpers`)
/// should be included in the final output.
pub fn helper_code(name: &str) -> Option<&'static str> {
    Some(match name {
        "$mod$" => "function $mod$(a, b) { return ((a % b) + b) % b; }",
        "$arrayEq$" => {
            "function $arrayEq$(a, b) { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) return false; } return true; }"
        }
        "$ArrayIterator$" => {
            "class $ArrayIterator$ { constructor(array) { this.array = array; this.index = 0; } next() { const v = this.array[this.index++]; if (v === undefined) { this.reset(); } return v; } reset() { this.index = 0; } clone() { return new $ArrayIterator$(this.array); } }"
        }
        "$IntRangeIterator$" => {
            "class $IntRangeIterator$ { constructor(start, end, step=1n) { this.value = start; this.start = start; this.end = end; this.step = step; } next() { if (this.end !== undefined) { if (this.step > 0n ? this.value > this.end : this.value < this.end) { this.reset(); return undefined; } } const v = this.value; this.value += this.step; return v; } reset() { this.value = this.start; } clone() { return new $IntRangeIterator$(this.start, this.end, this.step); } }"
        }
        "$MapIterator$" => {
            "class $MapIterator$ { constructor(mapfn, innerIter) { this.mapfn = mapfn; this.innerIter = innerIter; } next() { const v = this.innerIter.next(); if (v === undefined) { this.reset(); return undefined; } return this.mapfn(v); } reset() { this.innerIter.reset(); } clone() { return new $MapIterator$(this.mapfn, this.innerIter.clone()); } }"
        }
        "$FilterIterator$" => {
            "class $FilterIterator$ { constructor(filterFn, innerIter) { this.filterFn = filterFn; this.innerIter = innerIter; } next() { while (true) { const v = this.innerIter.next(); if (v === undefined) { this.reset(); return undefined; } if (this.filterFn(v)) return v; } } reset() { this.innerIter.reset(); } clone() { return new $FilterIterator$(this.filterFn, this.innerIter.clone()); } }"
        }
        "$TakeIterator$" => {
            "class $TakeIterator$ { constructor(count, innerIter) { this.remaining = count; this.innerIter = innerIter; this.originalCount = count; } next() { if (!this.remaining) { this.reset(); return undefined; } const v = this.innerIter.next(); if (v === undefined) { this.reset(); return undefined; } this.remaining--; return v; } reset() { this.innerIter.reset(); this.remaining = this.originalCount; } clone() { return new $TakeIterator$(this.originalCount, this.innerIter.clone()); } }"
        }
        "$TakeWhileIterator$" => {
            "class $TakeWhileIterator$ { constructor(pred, innerIter) { this.pred = pred; this.innerIter = innerIter; } next() { const v = this.innerIter.next(); if (v === undefined || !this.pred(v)) { this.reset(); return undefined; } return v; } reset() { this.innerIter.reset(); } clone() { return new $TakeWhileIterator$(this.pred, this.innerIter.clone()); } }"
        }
        "$DropIterator$" => {
            "class $DropIterator$ { constructor(count, innerIter) { this.toSkip = count; this.innerIter = innerIter; this.dropping = true; } next() { if (this.dropping) { for (let i = 0; i < this.toSkip; i++) { const v = this.innerIter.next(); if (v === undefined) { this.reset(); return undefined; } } this.dropping = false; } const v = this.innerIter.next(); if (v === undefined) { this.reset(); return undefined; } return v; } reset() { this.innerIter.reset(); this.dropping = true; } clone() { return new $DropIterator$(this.toSkip, this.innerIter.clone()); } }"
        }
        "$DropWhileIterator$" => {
            "class $DropWhileIterator$ { constructor(pred, innerIter) { this.pred = pred; this.innerIter = innerIter; this.dropping = true; } next() { if (this.dropping) { while (true) { const v = this.innerIter.next(); if (v === undefined) { this.reset(); return undefined; } if (!this.pred(v)) { this.dropping = false; return v; } } } const v = this.innerIter.next(); if (v === undefined) { this.reset(); return undefined; } return v; } reset() { this.innerIter.reset(); this.dropping = true; } clone() { return new $DropWhileIterator$(this.pred, this.innerIter.clone()); } }"
        }
        "$IterateIterator$" => {
            "class $IterateIterator$ { constructor(fn, start) { this.fn = fn; this.current = start; this.first = true; this.start = start; } next() { if (this.first) { this.first = false; return this.current; } this.current = this.fn(this.current); return this.current; } reset() { this.current = this.start; this.first = true; } clone() { return new $IterateIterator$(this.fn, this.start); } }"
        }
        "$StepIterator$" => {
            "class $StepIterator$ { constructor(stepSize, innerIter) { this.stepSize = stepSize; this.innerIter = innerIter; this.count = 0; } next() { while (true) { const v = this.innerIter.next(); if (v === undefined) { this.reset(); return undefined; } if (this.count % this.stepSize === 0) { this.count++; return v; } this.count++; } } reset() { this.innerIter.reset(); this.count = 0; } clone() { return new $StepIterator$(this.stepSize, this.innerIter.clone()); } }"
        }
        "$ZipIterator$" => {
            "class $ZipIterator$ { constructor(...iterators) { this.iterators = iterators; } next() { const values = []; for (const iter of this.iterators) { const v = iter.next(); if (v === undefined) { this.reset(); return undefined; } values.push(v); } return values; } reset() { for (const iter of this.iterators) iter.reset(); } clone() { return new $ZipIterator$(...this.iterators.map(i => i.clone())); } }"
        }
        "$RepeatIterator$" => {
            "class $RepeatIterator$ { constructor(count, innerIter) { this.count = count; this.remaining = count; this.innerIter = innerIter; } next() { const v = this.innerIter.next(); if (v !== undefined) return v; this.innerIter.reset(); if (this.remaining > 0) { this.remaining--; if (this.remaining === 0) return undefined; } return this.innerIter.next(); } reset() { this.innerIter.reset(); this.remaining = this.count; } clone() { return new $RepeatIterator$(this.count, this.remaining, this.innerIter.clone()); } }"
        }
        "$RepeatInnerIterator$" => {
            "class $RepeatInnerIterator$ { constructor(count, innerIter) { this.repeatCount = count; this.innerIter = innerIter; this.currentValue = undefined; this.timesYielded = 0; } next() { if (this.timesYielded > 0 && this.timesYielded < this.repeatCount) { this.timesYielded++; return this.currentValue; } this.currentValue = this.innerIter.next(); if (this.currentValue === undefined) { this.reset(); return undefined; } this.timesYielded = 1; return this.currentValue; } reset() { this.innerIter.reset(); this.currentValue = undefined; this.timesYielded = 0; } clone() { return new $RepeatInnerIterator$(this.count, this.innerIter.clone()); } }"
        }
        "$CartesianIterator$" => {
            "class $CartesianIterator$ { constructor(...iterators) { this.iterators = iterators.map(i => ({ iter: i, saved: [] })); this.finished = false; for (const entry of this.iterators) { while (true) { const v = entry.iter.next(); if (v === undefined) break; entry.saved.push(v); } entry.iter.reset(); if (entry.saved.length === 0) { this.finished = true; break; } } this.indices = new Array(this.iterators.length).fill(0); } next() { if (this.finished) return undefined; const result = this.indices.map((idx, i) => this.iterators[i].saved[idx]); let pos = this.indices.length - 1; while (pos >= 0) { this.indices[pos]++; if (this.indices[pos] < this.iterators[pos].saved.length) break; this.indices[pos] = 0; pos--; } if (pos < 0) this.finished = true; return result; } reset() { this.indices = new Array(this.iterators.length).fill(0); this.finished = false; for (const entry of this.iterators) { if (entry.saved.length === 0) { this.finished = true; break; } } } clone() { return new $CartesianIterator$(...this.iterators.map(i => i.clone())); } }"
        }
        "$PermutationsIterator$" => {
            "class $PermutationsIterator$ { constructor(innerIter, innerIsArray=false) { if (innerIsArray) { this.elements = innerIter; } else { this.elements = []; while (true) { const v = innerIter.next(); if (v === undefined) break; this.elements.push(v); } innerIter.reset(); } this.n = this.elements.length; this.indices = new Array(this.n).fill(0).map((_, i) => i); this.done = this.n === 0; } next() { if (this.done) return undefined; const result = this.indices.map(i => this.elements[i]); let i = this.n - 2; while (i >= 0 && this.indices[i] >= this.indices[i + 1]) i--; if (i < 0) { this.done = true; } else { let j = this.n - 1; while (this.indices[j] <= this.indices[i]) j--; [this.indices[i], this.indices[j]] = [this.indices[j], this.indices[i]]; let left = i + 1; let right = this.n - 1; while (left < right) { [this.indices[left], this.indices[right]] = [this.indices[right], this.indices[left]]; left++; right--; } } return result; } reset() { this.indices = new Array(this.n).fill(0).map((_, i) => i); this.done = this.n === 0; } clone() { return new $PermutationsIterator$(this.elements, true); } }"
        }
        "$CombinationsIterator$" => {
            "class $CombinationsIterator$ { constructor(choose, innerIter, innerIsArray=false) { if (innerIsArray) { this.elements = innerIter; } else { this.elements = []; while (true) { const v = innerIter.next(); if (v === undefined) break; this.elements.push(v); } innerIter.reset(); } this.choose = choose; this.indices = new Array(this.choose).fill(0).map((_, i) => i); this.done = this.choose > this.elements.length || this.choose === 0; } next() { if (this.done) return undefined; const result = this.indices.map(i => this.elements[i]); let i = this.choose - 1; while (i >= 0 && this.indices[i] === this.elements.length - this.choose + i) i--; if (i < 0) { this.done = true; } else { this.indices[i]++; for (let j = i + 1; j < this.choose; j++) this.indices[j] = this.indices[j - 1] + 1; } return result; } reset() { this.indices = new Array(this.choose).fill(0).map((_, i) => i); this.done = this.choose > this.elements.length || this.choose === 0; } clone() { return new $CombinationsIterator$(this.choose, this.elements, true); } }"
        }
        "$collect$" => {
            "function $collect$(iter) { const out = []; while (true) { const v = iter.next(); if (v === undefined) { iter.reset(); break; } out.push(v); } return out; }"
        }
        "$reduce$" => {
            "function $reduce$(reduceFn, initValue, iter) { let acc = initValue; while (true) { const v = iter.next(); if (v === undefined) { iter.reset(); break; } acc = reduceFn(acc, v); } return acc; }"
        }
        "$last$" => {
            "function $last$(iter) { let last = null; while (true) { const v = iter.next(); if (v === undefined) { iter.reset(); return last; } last = v; } }"
        }
        "$push$" => "function $push$(val, mutarr) { mutarr.push(val); return mutarr; }",
        "$pop$" => "function $pop$(mutarr) { mutarr.pop(); return mutarr; }",
        "$put$" => "function $put$(val, idx, mutarr) { mutarr[idx] = val; return mutarr; }",
        "$putMutDict$" => {
            "function $putMutDict$(val, key, mutdict) { mutdict.set(key, val); return mutdict; }"
        }
        "$removeMutDict$" => {
            "function $removeMutDict$(key, mutdict) { mutdict.delete(key); return mutdict; }"
        }
        "$pushMutSet$" => "function $pushMutSet$(val, mutset) { mutset.add(val); return mutset; }",
        "$removeMutSet$" => {
            "function $removeMutSet$(val, mutset) { mutset.delete(val); return mutset; }"
        }
        "$unwrapNoFallback$" => {
            "function $unwrapNoFallback$(value) { if (value === null) throw new Error(\"Unwrapped on None without a fallback value\"); return value; }"
        }
        "$unwrapWithFallback$" => {
            "function $unwrapWithFallback$(fallback, value) { if (value === null) return fallback; return value; }"
        }
        _ => return None,
    })
}

/// Return the set of JS helper names required by this builtin call.
///
/// The codegen tool should accumulate these and emit only the
/// corresponding `helper_code` entries in the final output.
pub fn required_helpers(builtin: BuiltinFunc) -> Vec<&'static str> {
    match builtin {
        BuiltinFunc::Mod => vec!["$mod$"],
        BuiltinFunc::ArrayEq => vec!["$arrayEq$"],
        BuiltinFunc::Unwrap if false => vec![],
        BuiltinFunc::Some
        | BuiltinFunc::IsNone
        | BuiltinFunc::ToStr
        | BuiltinFunc::ToInt
        | BuiltinFunc::ToNum
        | BuiltinFunc::ToBool
        | BuiltinFunc::TypeOf
        | BuiltinFunc::Length
        | BuiltinFunc::Head
        | BuiltinFunc::Contains
        | BuiltinFunc::Find
        | BuiltinFunc::Split
        | BuiltinFunc::Replace
        | BuiltinFunc::ToArr
        | BuiltinFunc::ToIter
        | BuiltinFunc::Dict
        | BuiltinFunc::Set
        | BuiltinFunc::Union
        | BuiltinFunc::Intersect
        | BuiltinFunc::Trans
        | BuiltinFunc::Detrans
        | BuiltinFunc::UnsafeTrans => vec![],

        BuiltinFunc::Unwrap => {
            // unwrap with 2 args = $unwrapWithFallback$, 1 arg = $unwrapNoFallback$
            // We return both; the codegen will only request one based on arg count.
            vec!["$unwrapNoFallback$", "$unwrapWithFallback$"]
        }
        BuiltinFunc::Range => vec!["$IntRangeIterator$"],
        BuiltinFunc::Iterate => vec!["$IterateIterator$"],
        BuiltinFunc::Map => vec!["$MapIterator$", "$ArrayIterator$"],
        BuiltinFunc::Filter => vec!["$FilterIterator$", "$ArrayIterator$"],
        BuiltinFunc::Take => vec!["$TakeIterator$", "$ArrayIterator$"],
        BuiltinFunc::TakeWhile => vec!["$TakeWhileIterator$", "$ArrayIterator$"],
        BuiltinFunc::Drop => vec!["$DropIterator$", "$ArrayIterator$"],
        BuiltinFunc::DropWhile => vec!["$DropWhileIterator$", "$ArrayIterator$"],
        BuiltinFunc::Repeat => vec!["$RepeatIterator$", "$ArrayIterator$"],
        BuiltinFunc::RepeatInner => vec!["$RepeatInnerIterator$", "$ArrayIterator$"],
        BuiltinFunc::Step => vec!["$StepIterator$", "$ArrayIterator$"],
        BuiltinFunc::Zip => vec!["$ZipIterator$", "$ArrayIterator$"],
        BuiltinFunc::Collect => vec!["$collect$"],
        BuiltinFunc::Reduce => vec!["$reduce$", "$ArrayIterator$"],
        BuiltinFunc::Last => vec!["$last$"],
        BuiltinFunc::Push => vec!["$push$"],
        BuiltinFunc::Pop => vec!["$pop$"],
        BuiltinFunc::Put => vec!["$put$"],
        BuiltinFunc::Remove => vec!["$removeMutDict$", "$removeMutSet$"],
        BuiltinFunc::Cartesian => vec!["$CartesianIterator$", "$ArrayIterator$"],
        BuiltinFunc::Permutations => vec!["$PermutationsIterator$"],
        BuiltinFunc::Combinations => vec!["$CombinationsIterator$"],
    }
}

/// Emit JS helper code for a set of required helper names.
///
/// Each name is looked up via `helper_code` and included in order.
pub fn emit_helpers(required: &[&str]) -> String {
    let mut out = String::from("// BUILTIN HELPERS //\n");
    for name in required {
        if let Some(code) = helper_code(name) {
            out.push_str(code);
            out.push('\n');
        }
    }
    out
}

/// Emit the JS code for this builtin given actual HirExpr arguments.
///
/// This is a convenience wrapper that extracts string representations
/// from the HIR expressions (or the codegen context) and delegates
/// to `BuiltinFunc::emit_js`.
pub fn emit_builtin_js(builtin: BuiltinFunc, _args: &[HirExpr]) -> String {
    // Placeholder — in the real codegen pass, each HirExpr has a
    // `to_js` method that produces the JS string for that expression.
    // For now, the callers pass &str slices to `builtin.emit_js()`.
    builtin.emit_js(&[])
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Name matching ──

    #[test]
    fn try_from_name_known_builtins() {
        assert!(BuiltinFunc::try_from_name("map").is_some());
        assert!(BuiltinFunc::try_from_name("filter").is_some());
        assert!(BuiltinFunc::try_from_name("reduce").is_some());
        assert!(BuiltinFunc::try_from_name("collect").is_some());
        assert!(BuiltinFunc::try_from_name("length").is_some());
        assert!(BuiltinFunc::try_from_name("push").is_some());
        assert!(BuiltinFunc::try_from_name("pop").is_some());
        assert!(BuiltinFunc::try_from_name("range").is_some());
        assert!(BuiltinFunc::try_from_name("toStr").is_some());
        assert!(BuiltinFunc::try_from_name("toInt").is_some());
        assert!(BuiltinFunc::try_from_name("toNum").is_some());
        assert!(BuiltinFunc::try_from_name("some").is_some());
        assert!(BuiltinFunc::try_from_name("isnone").is_some());
        assert!(BuiltinFunc::try_from_name("unwrap").is_some());
    }

    #[test]
    fn try_from_name_unknown_returns_none() {
        assert!(BuiltinFunc::try_from_name("nonexistent").is_none());
        assert!(BuiltinFunc::try_from_name("").is_none());
        assert!(BuiltinFunc::try_from_name("foo").is_none());
    }

    // ── Arity ──

    #[test]
    fn arity_unary_builtins() {
        for b in &[
            BuiltinFunc::ToStr,
            BuiltinFunc::Length,
            BuiltinFunc::Head,
            BuiltinFunc::Collect,
        ] {
            let (min, max) = b.arity();
            assert_eq!(min, 1);
            assert_eq!(max, Some(1));
        }
    }

    #[test]
    fn arity_binary_builtins() {
        for b in &[BuiltinFunc::Push, BuiltinFunc::Contains, BuiltinFunc::Map] {
            let (min, max) = b.arity();
            assert_eq!(min, 2);
            assert_eq!(max, Some(2));
        }
    }

    #[test]
    fn arity_range() {
        let (min, max) = BuiltinFunc::Range.arity();
        assert_eq!(min, 2);
        assert_eq!(max, Some(3));
    }

    #[test]
    fn arity_zip_variable() {
        let (min, max) = BuiltinFunc::Zip.arity();
        assert_eq!(min, 2);
        assert_eq!(max, None);
    }

    #[test]
    fn arity_unwrap() {
        let (min, max) = BuiltinFunc::Unwrap.arity();
        assert_eq!(min, 1);
        assert_eq!(max, Some(2));
    }

    // ── Return type inference ──

    #[test]
    fn infer_length_returns_num() {
        let mut ta = TypeArena::new();
        let arr = ta.intern(TypeKind::Arr(ta.int_id()));
        let result = BuiltinFunc::Length.infer_return_type(&[arr], &mut ta);
        assert_eq!(result, Some(ta.num_id()));
    }

    #[test]
    fn infer_collect_arr_returns_arr() {
        let mut ta = TypeArena::new();
        let iter_int = ta.intern(TypeKind::Iter(ta.int_id()));
        let result = BuiltinFunc::Collect.infer_return_type(&[iter_int], &mut ta);
        assert_eq!(result, Some(ta.intern(TypeKind::Arr(ta.int_id()))));
    }

    #[test]
    fn infer_collect_str_returns_arr_str() {
        let mut ta = TypeArena::new();
        let result = BuiltinFunc::Collect.infer_return_type(&[ta.str_id()], &mut ta);
        assert_eq!(result, Some(ta.intern(TypeKind::Arr(ta.str_id()))));
    }

    #[test]
    fn infer_map_returns_iter() {
        let mut ta = TypeArena::new();
        let func = ta.intern(TypeKind::Func {
            params: vec![ta.num_id()],
            ret: ta.bool_id(),
        });
        let iter = ta.intern(TypeKind::Iter(ta.num_id()));
        let result = BuiltinFunc::Map.infer_return_type(&[func, iter], &mut ta);
        assert_eq!(result, Some(ta.intern(TypeKind::Iter(ta.bool_id()))));
    }

    #[test]
    fn infer_filter_returns_iter() {
        let mut ta = TypeArena::new();
        let func = ta.intern(TypeKind::Func {
            params: vec![ta.int_id()],
            ret: ta.bool_id(),
        });
        let iter = ta.intern(TypeKind::Iter(ta.int_id()));
        let result = BuiltinFunc::Filter.infer_return_type(&[func, iter], &mut ta);
        assert_eq!(result, Some(ta.intern(TypeKind::Iter(ta.int_id()))));
    }

    #[test]
    fn infer_to_str_returns_str() {
        let mut ta = TypeArena::new();
        let result = BuiltinFunc::ToStr.infer_return_type(&[ta.int_id()], &mut ta);
        assert_eq!(result, Some(ta.str_id()));
    }

    #[test]
    fn infer_some_returns_maybe() {
        let mut ta = TypeArena::new();
        let result = BuiltinFunc::Some.infer_return_type(&[ta.int_id()], &mut ta);
        assert_eq!(result, Some(ta.intern(TypeKind::Maybe(ta.int_id()))));
    }

    #[test]
    fn infer_isnone_returns_bool() {
        let mut ta = TypeArena::new();
        let maybe = ta.intern(TypeKind::Maybe(ta.int_id()));
        let result = BuiltinFunc::IsNone.infer_return_type(&[maybe], &mut ta);
        assert_eq!(result, Some(ta.bool_id()));
    }

    #[test]
    fn infer_unwrap_returns_inner() {
        let mut ta = TypeArena::new();
        let maybe = ta.intern(TypeKind::Maybe(ta.int_id()));
        let result = BuiltinFunc::Unwrap.infer_return_type(&[maybe], &mut ta);
        assert_eq!(result, Some(ta.int_id()));
    }

    #[test]
    fn infer_unwrap_with_fallback() {
        let mut ta = TypeArena::new();
        let maybe = ta.intern(TypeKind::Maybe(ta.int_id()));
        let result = BuiltinFunc::Unwrap.infer_return_type(&[ta.int_id(), maybe], &mut ta);
        assert_eq!(result, Some(ta.int_id()));
    }

    #[test]
    fn infer_range_returns_iter() {
        let mut ta = TypeArena::new();
        let result = BuiltinFunc::Range.infer_return_type(&[ta.int_id(), ta.int_id()], &mut ta);
        assert_eq!(result, Some(ta.intern(TypeKind::Iter(ta.int_id()))));
    }

    #[test]
    fn infer_wrong_arg_count_returns_none() {
        let mut ta = TypeArena::new();
        // Length expects 1 arg, passing 2
        assert!(
            BuiltinFunc::Length
                .infer_return_type(&[ta.int_id(), ta.num_id()], &mut ta)
                .is_none()
        );
    }

    #[test]
    fn infer_to_iter_from_arr() {
        let mut ta = TypeArena::new();
        let arr = ta.intern(TypeKind::Arr(ta.str_id()));
        let result = BuiltinFunc::ToIter.infer_return_type(&[arr], &mut ta);
        assert_eq!(result, Some(ta.intern(TypeKind::Iter(ta.str_id()))));
    }

    #[test]
    fn infer_to_iter_from_str() {
        let mut ta = TypeArena::new();
        let result = BuiltinFunc::ToIter.infer_return_type(&[ta.str_id()], &mut ta);
        assert_eq!(result, Some(ta.intern(TypeKind::Iter(ta.str_id()))));
    }

    #[test]
    fn infer_to_arr_from_str() {
        let mut ta = TypeArena::new();
        let result = BuiltinFunc::ToArr.infer_return_type(&[ta.str_id()], &mut ta);
        assert_eq!(result, Some(ta.intern(TypeKind::Arr(ta.str_id()))));
    }

    #[test]
    fn infer_trans_mut_arr() {
        let mut ta = TypeArena::new();
        let arr = ta.intern(TypeKind::Arr(ta.int_id()));
        let result = BuiltinFunc::Trans.infer_return_type(&[arr], &mut ta);
        assert_eq!(result, Some(ta.intern(TypeKind::MutArr(ta.int_id()))));
    }

    #[test]
    fn infer_detrans_arr() {
        let mut ta = TypeArena::new();
        let mut_arr = ta.intern(TypeKind::MutArr(ta.num_id()));
        let result = BuiltinFunc::Detrans.infer_return_type(&[mut_arr], &mut ta);
        assert_eq!(result, Some(ta.intern(TypeKind::Arr(ta.num_id()))));
    }

    #[test]
    fn infer_push_returns_collection() {
        let mut ta = TypeArena::new();
        let mut_arr = ta.intern(TypeKind::MutArr(ta.int_id()));
        let result = BuiltinFunc::Push.infer_return_type(&[ta.int_id(), mut_arr], &mut ta);
        assert_eq!(result, Some(mut_arr));
    }

    #[test]
    fn infer_split() {
        let mut ta = TypeArena::new();
        let result = BuiltinFunc::Split.infer_return_type(&[ta.str_id(), ta.str_id()], &mut ta);
        assert_eq!(result, Some(ta.intern(TypeKind::Arr(ta.str_id()))));
    }

    #[test]
    fn infer_dict() {
        let mut ta = TypeArena::new();
        let tup = ta.intern(TypeKind::Tuple(vec![ta.str_id(), ta.int_id()]));
        let arr_tup = ta.intern(TypeKind::Arr(tup));
        let result = BuiltinFunc::Dict.infer_return_type(&[arr_tup], &mut ta);
        assert_eq!(
            result,
            Some(ta.intern(TypeKind::Dict {
                key: ta.str_id(),
                val: ta.int_id()
            }))
        );
    }

    #[test]
    fn infer_set() {
        let mut ta = TypeArena::new();
        let arr = ta.intern(TypeKind::Arr(ta.int_id()));
        let result = BuiltinFunc::Set.infer_return_type(&[arr], &mut ta);
        assert_eq!(result, Some(ta.intern(TypeKind::Set(ta.int_id()))));
    }

    // ── JS emission ──

    #[test]
    fn emit_to_str() {
        let js = BuiltinFunc::ToStr.emit_js(&["x"]);
        assert_eq!(js, "String(x)");
    }

    #[test]
    fn emit_length() {
        let js = BuiltinFunc::Length.emit_js(&["xs"]);
        assert_eq!(js, "(xs).length");
    }

    #[test]
    fn emit_head() {
        let js = BuiltinFunc::Head.emit_js(&["xs"]);
        assert_eq!(js, "(xs[0] ?? null)");
    }

    #[test]
    fn emit_push() {
        let js = BuiltinFunc::Push.emit_js(&["val", "arr"]);
        assert_eq!(js, "$push$(val, arr)");
    }

    #[test]
    fn emit_some() {
        let js = BuiltinFunc::Some.emit_js(&["x"]);
        assert_eq!(js, "x");
    }

    #[test]
    fn emit_isnone() {
        let js = BuiltinFunc::IsNone.emit_js(&["x"]);
        assert_eq!(js, "x === null");
    }

    #[test]
    fn emit_unwrap_no_fallback() {
        let js = BuiltinFunc::Unwrap.emit_js(&["x"]);
        assert_eq!(js, "$unwrapNoFallback$(x)");
    }

    #[test]
    fn emit_unwrap_with_fallback() {
        let js = BuiltinFunc::Unwrap.emit_js(&["fallback", "x"]);
        assert_eq!(js, "$unwrapWithFallback$(fallback, x)");
    }

    #[test]
    fn emit_split() {
        let js = BuiltinFunc::Split.emit_js(&["sep", "s"]);
        assert_eq!(js, "s.split(sep)");
    }

    #[test]
    fn emit_range_two_args() {
        let js = BuiltinFunc::Range.emit_js(&["0n", "10n"]);
        assert_eq!(js, "new $IntRangeIterator$(0n, 10n)");
    }

    #[test]
    fn emit_range_three_args() {
        let js = BuiltinFunc::Range.emit_js(&["0n", "10n", "2n"]);
        assert_eq!(js, "new $IntRangeIterator$(0n, 10n, 2n)");
    }

    #[test]
    fn emit_zip_two_args() {
        let js = BuiltinFunc::Zip.emit_js(&["a", "b"]);
        assert_eq!(
            js,
            "new $ZipIterator$(new $ArrayIterator$(a), new $ArrayIterator$(b))"
        );
    }

    #[test]
    fn emit_union() {
        let js = BuiltinFunc::Union.emit_js(&["a", "b"]);
        assert_eq!(js, "new Set([...a, ...b])");
    }

    #[test]
    fn known_helper_codes() {
        assert!(helper_code("$ArrayIterator$").is_some());
        assert!(helper_code("$MapIterator$").is_some());
        assert!(helper_code("$push$").is_some());
        assert!(helper_code("$collect$").is_some());
        assert!(helper_code("$nonexistent$").is_none());
    }

    #[test]
    fn required_helpers_empty_for_simple_builtins() {
        assert!(required_helpers(BuiltinFunc::ToStr).is_empty());
        assert!(required_helpers(BuiltinFunc::Length).is_empty());
        assert!(required_helpers(BuiltinFunc::IsNone).is_empty());
    }

    #[test]
    fn required_helpers_for_iterator_builtins() {
        let helpers = required_helpers(BuiltinFunc::Map);
        assert!(helpers.contains(&"$MapIterator$"));
        assert!(helpers.contains(&"$ArrayIterator$"));
    }

    #[test]
    fn emit_helpers_only_includes_requested() {
        let out = emit_helpers(&["$push$", "$pop$"]);
        assert!(out.contains("$push$"));
        assert!(out.contains("$pop$"));
        assert!(!out.contains("$MapIterator$"));
    }
}
