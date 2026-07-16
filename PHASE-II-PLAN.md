# Phase II Implementation Plan — Semantic Analysis

This document is a detailed, implementable plan for the first part of Phase II
of the Gema Rust rewrite.  It covers **Steps 5–6** from the roadmap: the
interned type system and name resolution.

Each section specifies **what to build, the exact API surface, key
implementation details, edge cases, and a test plan.**

---

## Table of Contents

1. [Step 5: `types.rs` — Interned Type System](#step-5-typesrs--interned-type-system)
2. [Step 6a: `symbol.rs` — Symbol Table & Scope Tree](#step-6a-symbolrs--symbol-table--scope-tree)
3. [Step 6b: `resolve.rs` — Name Resolution Pass](#step-6b-resolvers--name-resolution-pass)
4. [Cross-Cutting Concerns](#cross-cutting-concerns)
5. [Testing Strategy](#testing-strategy)
6. [Integration Checklist](#integration-checklist)

---

## Step 5: `types.rs` — Interned Type System

### Goal

Replace the parser's recursive `TypeNode` with an arena-interned, hash-consed
type representation.  Every structurally identical type has exactly one
`TypeId`.  This is the foundation that all later passes (inference, trait
resolution, monomorphization) build on.

### Files to create

`src/types.rs`

### Public Types

```rust
/// Opaque index into `TypeArena`.  `Copy` + cheap equality.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct TypeId(u32);

/// The type arena — owns all `TypeKind` values and deduplicates them.
pub struct TypeArena {
    types: Vec<TypeKind>,
    /// Hash-consing map: `TypeKind → TypeId`.
    dedup: FxHashMap<TypeKind, TypeId>,
}

/// Discriminated union of every possible type.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum TypeKind {
    // ── Primitives ──
    Int,
    Num,
    Str,
    Bool,
    Void,

    // ── Compound types ──
    Func { params: Vec<TypeId>, ret: TypeId },
    Arr(TypeId),
    Iter(TypeId),
    MutArr(TypeId),
    Tuple(Vec<TypeId>),
    Dict { key: TypeId, val: TypeId },
    MutDict { key: TypeId, val: TypeId },
    Set(TypeId),
    MutSet(TypeId),
    Maybe(TypeId),

    // ── User-defined (structs, enums) ──
    /// `name` is the struct/enum name, `args` are concrete type args.
    /// Example: `Pair[Int, Str]` → Custom { name: Id("Pair"), args: [Int, Str] }
    Custom { name: IdentId, args: Vec<TypeId> },

    // ── Generics ──
    /// A type variable, e.g. `T` in `func [T: Hash]`.
    Generic { name: IdentId, bounds: Vec<IdentId> },

    // ── Inference sentinels ──
    /// Placeholder for a type not yet known (lambdas, `none`, etc.).
    InferVar { id: u32 },

    // ── Special ──
    /// `Self` in trait function signatures.
    SelfType,
}
```

**Derive `Hash` and `Eq` manually** for `TypeKind` (the default derive on
`Vec<TypeId>` is fine since `TypeId` is a newtype around `u32`).  The
`dedup` map relies on these.

### TypeArena operations

```rust
impl TypeArena {
    pub fn new() -> Self;

    /// Intern a type kind.  Returns the existing `TypeId` if this exact
    /// kind has already been interned (hash consing).
    pub fn intern(&mut self, kind: TypeKind) -> TypeId;

    /// Retrieve the `TypeKind` for a given `TypeId`.
    /// Panics if `id` is out of range (should never happen with valid IDs).
    pub fn get(&self, id: TypeId) -> &TypeKind;

    // ── Pre-defined type constants ──
    // These must be pre-interned in the constructor or lazily initialized.
    pub fn int_id(&self) -> TypeId;
    pub fn num_id(&self) -> TypeId;
    pub fn str_id(&self) -> TypeId;
    pub fn bool_id(&self) -> TypeId;
    pub fn void_id(&self) -> TypeId;

    // ── Structural operations ──

    /// Substitute generic type parameters with concrete types.
    /// `bindings: &FxHashMap<IdentId, TypeId>` maps generic param names
    /// to their concrete types.  Returns a new (or existing) `TypeId`.
    pub fn substitute(&mut self, ty: TypeId, bindings: &FxHashMap<IdentId, TypeId>) -> TypeId;

    /// Creates a fresh inference variable, returning its `TypeId`.
    /// Each call returns a unique ID.
    pub fn fresh_infer_var(&mut self) -> TypeId;

    /// Check if a type is fully concrete (contains no `Generic` or
    /// `InferVar`).
    pub fn is_concrete(&self, ty: TypeId) -> bool;
}
```

### Implementation notes

1. **Hash consing requires `TypeKind: Hash + Eq`**.  The derived `Hash` on
   `Vec<TypeId>` hashes the contained `u32` values, which gives structural
   hashing for free.  Make sure `TypeKind` derives both traits.

2. **Pre-interned primitives**.  In `TypeArena::new()`, intern the five
   primitive types (`Int`, `Num`, `Str`, `Bool`, `Null`) and store their
   `TypeId`s in a small fixed-size array so `int_id()` etc. are O(1).

3. **`substitute` implementation**: Recursive match on `TypeKind`.  For
   `Generic { name, .. }`, look up `name` in `bindings`; return the binding
   if found, otherwise return the generic unchanged.  For all other
   compound variants, recursively substitute children and re-intern the
   result.

4. **`fresh_infer_var`**: Increment a counter in `TypeArena`.  Each
   `InferVar` gets a unique `id`.  Do NOT hash-cons `InferVar` — every
   call creates a distinct entry.

5. **`is_concrete`**: Recursive walk.  Returns `false` if any
   `Generic` or `InferVar` is found.  `Custom { .. }` with concrete args
   is concrete.  `SelfType` is concrete (it's resolved before
   monomorphization).

### Connecting to the existing AST

The parser currently produces `TypeNode` in type annotation positions
(e.g. `StructField.type_node`, `FuncDef.return_type`).  These `TypeNode`
values must be **lowered to `TypeId`** during type inference.

Create a helper:

```rust
/// Lower a parser `TypeNode` to an interned `TypeId`.
/// `generic_params` maps generic parameter names to their `TypeId` so
/// that `TypeNode::TypeParamRef { name, .. }` resolves correctly.
pub fn lower_type_node(
    type_node: &TypeNode,
    arena: &mut TypeArena,
    generic_params: &HashMap<IdentId, TypeId>,
) -> TypeId;
```

This function will be used during type inference when processing each AST
node that has type annotations.

### Tests

```rust
#[test]
fn intern_primitives() {
    let mut arena = TypeArena::new();
    let a = arena.intern(TypeKind::Int);
    let b = arena.intern(TypeKind::Int);
    assert_eq!(a, b, "hash consing: same type → same TypeId");
}

#[test]
fn intern_compound() {
    let mut arena = TypeArena::new();
    let int = arena.intern(TypeKind::Int);
    let arr1 = arena.intern(TypeKind::Array(int));
    let arr2 = arena.intern(TypeKind::Array(int));
    assert_eq!(arr1, arr2);
}

#[test]
fn substitute_generic() {
    let mut arena = TypeArena::new();
    let int = arena.intern(TypeKind::Int);
    let t_id = arena.intern(TypeKind::Generic { name: ident("T"), bounds: vec![] });
    let mut bindings = HashMap::new();
    bindings.insert(ident("T"), int);
    let result = arena.substitute(t_id, &bindings);
    assert_eq!(result, int);
}

#[test]
fn substitute_in_compound() {
    let mut arena = TypeArena::new();
    let int = arena.intern(TypeKind::Int);
    let t_id = arena.intern(TypeKind::Generic { name: ident("T"), bounds: vec![] });
    let arr_t = arena.intern(TypeKind::Array(t_id));
    let mut bindings = HashMap::new();
    bindings.insert(ident("T"), int);
    let result = arena.substitute(arr_t, &bindings);
    let expected = arena.intern(TypeKind::Array(int));
    assert_eq!(result, expected);
}

#[test]
fn infer_var_not_deduplicated() {
    let mut arena = TypeArena::new();
    let v1 = arena.fresh_infer_var();
    let v2 = arena.fresh_infer_var();
    assert_ne!(v1, v2, "each InferVar is unique");
}

#[test]
fn is_concrete() {
    let mut arena = TypeArena::new();
    let int = arena.intern(TypeKind::Int);
    assert!(arena.is_concrete(int));
    let t = arena.intern(TypeKind::Generic { name: ident("T"), bounds: vec![] });
    assert!(!arena.is_concrete(t));
}

#[test]
fn lower_type_node_named() {
    // TypeNode::Named { name: "Foo", params: [Int] } → Custom { name: Id("Foo"), args: [Int] }
    let mut arena = TypeArena::new();
    let int = arena.intern(TypeKind::Int);
    let type_node = TypeNode::Named {
        name: ident("Foo"),
        params: vec![TypeNode::Int],
    };
    let result = lower_type_node(&type_node, &mut arena, &interner, &HashMap::new());
    let expected = arena.intern(TypeKind::Custom { name: ident("Foo"), args: vec![int] });
    assert_eq!(result, expected);
}

#[test]
fn lower_type_node_generic_param() {
    // TypeNode::TypeParamRef { name: "T" } → Generic { name: Id("T"), bounds: [] }
    let mut arena = TypeArena::new();
    let t_id = arena.intern(TypeKind::Generic { name: ident("T"), bounds: vec![] });
    let mut generic_params = HashMap::new();
    generic_params.insert(ident("T"), t_id);
    let type_node = TypeNode::TypeParamRef { name: ident("T"), traits: vec![] };
    let result = lower_type_node(&type_node, &mut arena, &interner, &generic_params);
    assert_eq!(result, t_id);
}
```

---

## Step 6a: `symbol.rs` — Symbol Table & Scope Tree

### Goal

Define the data structures for representing named entities (variables,
functions, structs, enums, traits, type parameters) and the lexical scope
tree that organizes them.

### Files to create

`src/symbol.rs`

### Public Types

/// A name+type pair from a trait requirement (`name: Type`).
/// The type_node captures both function types (`Func[P1, P2: Ret]`)
/// and value types (`Self`, `Int`, etc.).
#[derive(Clone, Debug)]
pub struct TraitRequirement {
    pub name: IdentId,
    pub type_node: TypeNode,
}

```rust
/// Opaque index into the symbol arena.
pub type SymbolId = id_arena::Id<Symbol>;

/// Opaque index into the scope arena.
pub type ScopeId = id_arena::Id<ScopeData>;

/// A single named entity in the program.
#[derive(Clone, Debug)]
pub struct Symbol {
    pub name: IdentId,
    pub kind: SymbolKind,
    /// The AST node where this symbol was defined.
    pub def_node: NodeId,
    /// Whether the symbol is visible outside its module.
    pub visibility: Visibility,
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
        /// The fully-qualified name including parameter types, used for
        /// overload resolution.  Set during type inference.
        full_name: Option<IdentId>,
        is_generic: bool,
        /// Number of parameters (known from AST, no types needed).
        param_count: usize,
    },
    /// A struct definition.
    Struct {
        type_params: Vec<IdentId>,
    },
    /// An enum definition.
    Enum {
        type_params: Vec<IdentId>,
        /// The variant names and their (optional) data types.
        /// The `TypeNode` here is lowered to `TypeId` during inference.
        variants: Vec<EnumVariant>,
    },
    /// A trait definition.
    Trait {
        requirements: Vec<TraitRequirement>,
    },
    /// An impl block connecting a type to a trait.
    Impl {
        trait_name: IdentId,
        self_type: TypeNode,  // lowered to TypeId during inference
        /// The member definitions inside this impl block (both `FuncDef`
        /// and `Assign` nodes for fulfilling trait requirements).
        member_nodes: Vec<NodeId>,
    },
    /// A generic type parameter (e.g. `T` in `func [T: Hash]`).
    TypeParam {
        bounds: Vec<IdentId>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Visibility {
    Public,
    Private,
}
```

### ScopeData

```rust
/// A single lexical scope in the program.
#[derive(Clone, Debug)]
pub struct ScopeData {
    pub parent: Option<ScopeId>,
    /// Symbols defined in this scope, keyed by name.
    /// For overloaded functions, multiple symbols may share the same name.
    /// We use a multimap: `FxHashMap<IdentId, Vec<SymbolId>>`.
    pub symbols: FxHashMap<IdentId, Vec<SymbolId>>,
    pub children: Vec<ScopeId>,
}
```

### ScopeTree

```rust
/// The complete scope tree for a compilation unit.
#[derive(Clone, Debug)]
pub struct ScopeTree {
    pub scopes: Arena<ScopeData>,
    pub symbols: Arena<Symbol>,
    pub root_scope: ScopeId,
    /// Maps AST nodes to the scope they belong to.
    pub node_scope: HashMap<NodeId, ScopeId>,
    /// Maps AST nodes (Var, Call) to their resolved SymbolId.
    pub resolved_refs: HashMap<NodeId, SymbolId>,
}
```

### SymbolTable operations

Scope tree construction is done during name resolution, but these are the
key operations needed:

```rust
/// Register a symbol in a given scope.  If the name already exists
/// and the existing symbol is a Function, allow duplicates (overloading).
/// For non-functions, duplicate names produce a diagnostic.
pub fn define(
    scope_tree: &mut ScopeTree,
    scope: ScopeId,
    name: IdentId,
    kind: SymbolKind,
    def_node: NodeId,
    diagnostics: &mut DiagnosticsBag,
) -> SymbolId;

/// Look up a name in the scope chain (current scope first, then parent).
/// Returns the most recent definition (function overloads are
/// disambiguated by the caller during type inference).
pub fn lookup<'a>(
    scope_tree: &'a ScopeTree,
    from: ScopeId,
    name: IdentId,
) -> Option<(ScopeId, &'a [SymbolId])>;

/// Look for a specific function overload by name.
/// Returns all function symbols with this name in scope.
pub fn lookup_functions<'a>(
    scope_tree: &'a ScopeTree,
    from: ScopeId,
    name: IdentId,
) -> Vec<&'a Symbol>;
```

### Tests

```rust
fn ident(s: &str) -> IdentId; // helper to intern a string

#[test]
fn define_and_lookup_variable() {
    // Define x: Int in root scope, look it up → found
}

#[test]
fn scoped_shadowing() {
    // x = 1 in root, { x = 2 } in block → inner resolves to 2
}

#[test]
fn lookup_walks_parent_chain() {
    // x defined in root, referenced in nested block → found
}

#[test]
fn undefined_name_returns_none() {
    // lookup("nonexistent") → None
}

#[test]
fn function_overloading_allowed() {
    // Two `foo` functions with different param types → both registered
}

#[test]
fn duplicate_variable_error() {
    // x = 1; x = 2 → diagnostic produced
}

#[test]
fn scope_entering_and_leaving() {
    // Blocks create new child scopes, function bodies create new scopes
}
```

---

## Step 6b: `resolve.rs` — Name Resolution Pass

### Goal

Walk the AST produced by the parser, build the scope tree, register every
definition in its containing scope, and resolve every name reference
(`Var`, `Call`, `FieldAccess`, etc.) to the `SymbolId` it refers to.

### Files to create

`src/resolve.rs`

### Public API

```rust
/// Perform name resolution on a parsed AST.
///
/// This pass does NOT require type information.  It operates solely on
/// names and structure.  Every identifier in the program is resolved to
/// a `SymbolId` in the returned `ScopeTree`.
///
/// Errors (undefined names, duplicate definitions) are pushed to
/// `diagnostics`.  Sentinels (synthetic error symbols) are used for
/// undefined references so subsequent passes can continue.
pub fn resolve_names(
    arena: &AstArena,
    root: NodeId,
    interner: &mut Interner,
    diagnostics: &mut DiagnosticsBag,
    file_idx: usize,
) -> ScopeTree {
    let mut resolver = Resolver::new(arena, interner, diagnostics, file_idx);
    resolver.resolve_node(root);
    resolver.finish()
}
```

### The Resolver

```rust
struct Resolver<'a> {
    arena: &'a AstArena,
    interner: &'a Interner,
    diagnostics: &'a mut DiagnosticsBag,
    scope_tree: ScopeTree,
    /// Current scope we're in.
    current_scope: ScopeId,
    /// Stack of loop scopes (for break/continue validation).
    loop_stack: Vec<ScopeId>,
}
```

### Resolution rules (node by node)

The resolver walks the AST recursively.  For each node:

| AST Node | Resolution Behavior |
|----------|-------------------|
| `Block` | Create a new child scope.  Resolve all statements.  Pop scope on exit. |
| `Assign(name, value)` | Resolve `value`.  Register `name` as a `Variable` in current scope.  If `is_mut`, mark it. |
| `FuncDef(name, params, body)` | **Before** resolving body: register `func_name` as a `Function` in current scope (enables recursion).  Create a new scope for the function body.  Register each param as a `Variable` in that scope.  Register type params as `TypeParam` symbols.  Resolve body.  Pop scope on exit. |
| `AnonFunc(params, body)` | Create a new scope.  Register params as `Variable`s.  Resolve body.  No outer registration (anonymous). |
| `StructDef(name, type_params, fields)` | Register `name` as a `Struct` in current scope.  Type params and fields are recorded (field types are lowered during inference). |
| `EnumDef(name, type_params, variants)` | Register `name` as an `Enum` in current scope. |
| `TraitDef(name, requirements)` | Register `name` as a `Trait` in current scope.  Each `TraitRequirement` has a `name` and `type_node` — no body to resolve (trait sigs have no bodies). |
| `ImplBlock(self_type, trait_name, members)` | Register an `Impl` symbol.  Resolve each member in a fresh scope where `Self` is bound to the implementing type.  Members are either `FuncDef` or `Assign` nodes; the resolve pass registers function names as `Function` symbols and assignment targets as `Variable` symbols. |
| `ForLoop(var_name, iter, body)` | Create a new scope.  Register `var_name` as a `Variable`.  Push loop scope.  Resolve `iter` and `body`.  Pop loop scope and scope on exit. |
| `Var(name)` | Look up `name` in scope chain.  If found, record `resolved_refs[node] = symbol_id`.  If not found, emit "undefined name" diagnostic and record a sentinel. |
| `Call(name, args)` | Resolve args.  Look up `name` like a `Var`.  Record `resolved_refs[node] = symbol_id`. |
| `DirectCall(caller, args)` | Resolve `caller` and `args`.  No name lookup (caller is an expression). |
| `Return(value)` | Resolve `value` if present. |
| `Break` / `Continue` | Validate we're inside a loop (check `loop_stack`).  If not, emit diagnostic. |
| `Use` / `UseJs` | Register imported symbols in current scope (module linking deferred to Phase III). |
| `FieldAccess(obj, field)` | Resolve `obj` only.  `field` is resolved by type during inference. |
| All other nodes (`IntLit`, `Binary`, `If`, `Match`, etc.) | Resolve children recursively. |

### Error recovery

- **Undefined name**: Create a synthetic error `Symbol` and record it in
  `resolved_refs`.  Emit a diagnostic.  Continue resolution.
- **Duplicate definition** (non-function): Emit a warning (or error, your
  call).  The second definition replaces the first in scope.
- **Break/Continue outside loop**: Emit a diagnostic.  Continue.

### Key implementation details

1. **Scopes are created lazily**.  Not every `Block` creates a new scope
   — only blocks that are function bodies, loop bodies, or nested `{ .. }`
   expressions.  Actually, *every* `Block` creates a scope in Gema.  See
   the TS reference: `Block.cascadeTypes()` always creates a `new Scope(this)`.

2. **Recursive functions**.  Register the function name in the enclosing
   scope *before* resolving the body.  This means the body can call itself
   by name.

3. **Function parameters shadow outer names**.  Parameters are registered
   in the function's body scope *before* resolving the body, so they take
   precedence over outer definitions.

4. **`Self` in impl blocks**.  Inside an `ImplBlock`, register `Self` as
   a special symbol pointing to the implementing type.  This is used
   during type inference.

5. **No type information**.  The resolver does NOT look at types at all.
   `Function.param_count` is set from the AST (`.params.len()`), but
   param types are ignored.  Overload resolution happens in type inference.

### Tests

```rust
/// Helper: parse and resolve a source string, return the ScopeTree.
fn resolve(source: &str) -> (AstArena, Interner, DiagnosticsBag, ScopeTree, NodeId);

#[test]
fn resolve_variable() {
    let (arena, _, diags, tree, root) = resolve("x = 42i; x");
    assert!(!diags.has_errors());
    // Verify `x` in the second statement resolves to the first.
    // (Walk AST, find the Var node, check resolved_refs.)
}

#[test]
fn resolve_function() {
    let (arena, _, diags, tree, root) = resolve("func foo() { 1i }; foo()");
    assert!(!diags.has_errors());
    // The Call to `foo` should resolve to the FuncDef.
}

#[test]
fn resolve_recursive_function() {
    let (arena, _, diags, tree, root) = resolve("func factorial(n): Int { if n == 0 { 1i } else { n * factorial(n - 1i) } }");
    assert!(!diags.has_errors());
    // The body references `factorial` which is defined in the same scope.
}

#[test]
fn resolve_scoped_shadowing() {
    let (arena, _, diags, tree, root) = resolve("x = 1; { x = 2; x }; x");
    assert!(!diags.has_errors());
    // Inner `x` resolves to inner assignment; outer `x` resolves to outer.
}

#[test]
fn undefined_variable_error() {
    let (_, _, diags, _, _) = resolve("nonexistent");
    assert!(diags.has_errors());
    assert!(diags.format(&SourceMap::new()).contains("undefined"));
}

#[test]
fn break_outside_loop_error() {
    let (_, _, diags, _, _) = resolve("break");
    assert!(diags.has_errors());
}

#[test]
fn function_creates_new_scope() {
    let (arena, _, diags, tree, root) = resolve("func foo() { x = 1 }; x");
    assert!(diags.has_errors()); // `x` is not in scope outside `foo`
}

#[test]
fn anon_func_creates_new_scope() {
    let (arena, _, diags, tree, root) = resolve("\\x { x }");
    assert!(!diags.has_errors());
}

#[test]
fn for_loop_variable_resolved() {
    let (arena, _, diags, tree, root) = resolve("for x = 0..10 { x }");
    assert!(!diags.has_errors(), "errors: {:?}", diags);
}

#[test]
fn struct_definition_registered() {
    let (arena, _, diags, tree, root) = resolve("struct Point { x: Num, y: Num }");
    assert!(!diags.has_errors());
    // Verify Point is registered as a Struct symbol.
}

#[test]
fn enum_definition_registered() {
    let (arena, _, diags, tree, root) = resolve("enum Option[T] { some: T, none }");
    assert!(!diags.has_errors());
}

#[test]
fn trait_definition_registered() {
    let (arena, _, diags, tree, root) = resolve("trait Eq { equal: Func[Self, Self: Bool] }");
    assert!(!diags.has_errors());
}
```

---

## Step 7: `infer.rs` — Type Inference (Unification-Based)

**NOTE:** This replaces the earlier "bidirectional" approach described in
the roadmap.  After discussions, we settled on a full Hindley-Milner
unification-based inference engine.

### Goal

Assign a `TypeId` to every expression node in the resolved AST by solving
type constraints generated from the program structure.

### Files to create

`src/infer.rs`

### Prerequisites

Before implementing inference, the following must be in place:
- `types.rs` — `TypeArena`, `TypeKind`, `substitute`, `is_concrete` ✓
- `symbol.rs` — scope tree, resolved symbol table ✓
- `resolve.rs` — name resolution pass ✓
- `docs/type-system.md` — language-level type system reference ✓

### Public API

```rust
/// Run type inference on a resolved AST.
///
/// Produces a map from every expression node to its inferred `TypeId`.
/// Errors (type mismatches, undefined names, etc.) are pushed to
/// `diagnostics`.
pub fn infer_types(
    arena: &AstArena,
    scope_tree: &mut ScopeTree,
    type_arena: &mut TypeArena,
    interner: &Interner,
    root: NodeId,
    diagnostics: &mut DiagnosticsBag,
    file_idx: usize,
) -> FxHashMap<NodeId, TypeId>;
```

### Algorithm: Constraint-based unification

1. **Fresh variables**: Each expression node that doesn't have a fixed type
   gets a fresh `InferVar` as its initial type.

2. **Constraint generation**: Walk the AST and generate equality
   constraints between types:
   - `IntLit(42)` → type is `Int`
   - `NumLit(3.14)` → type is `Num`
   - `StrLit("hi")` → type is `Str`
   - `BoolLit(true)` → type is `Bool`
   - `NoneLit(...)` → type is `Maybe[α]` where α is fresh
   - `Var(name)` → type is the symbol's `type_id` (or fresh if unknown)
   - `Binary(l + r)` → `l: Int`, `r: Int`, result: `Int`
   - `Binary(l + r)` where one operand is `Num` → coerce to `Num`
   - `Call(f, args)` → `f: Func[typeof(args): α]`, result is α
   - `Assign(x, v)` → `typeof(x) = typeof(v)`
   - `If(cond, body, else)` → `typeof(body) = typeof(else)`
   - `ArrLit([e1, e2, ...])` → `typeof(e1) = typeof(e2) = ... = T`, result is `Arr[T]`
   - `TupleLit([e1, e2, ...])` → result is `Tup[typeof(e1), typeof(e2), ...]`
   - `Match(scrutinee, arms)` → all arms unify to the same type
   - `ForLoop(var, iter, body)` → `typeof(iter) = Iter[typeof(var)]`
   - `NoneLit` with explicit annotation → result is `Maybe[annotated_type]`
   - Assignment with type annotation → `typeof(value) = annotated_type`
   - Function with explicit return type → `typeof(body) = return_type`
   - Lambda → `Func[typeof(params): typeof(body)]`

3. **Unification**: For each constraint `a = b`, call `unify(a, b)` which:
   - If both are `InferVar`, record that they are equal (union-find or
     substitution)
   - If one is `InferVar` and the other is concrete, substitute the
     variable with the concrete type (with **occurs check**)
   - If both are concrete, check structural equality
   - On mismatch, emit a diagnostic with context

4. **Generalization**: After unification, walk all expressions and
   substitute remaining `InferVar` bindings.  Any `InferVar` that was
   never constrained is an "ambiguous type" — error.

### Unification engine

The core of the inference engine is the `Unifier`:

```rust
struct Unifier {
    /// Maps InferVar ids to their current binding (if solved).
    bindings: FxHashMap<u32, TypeId>,
    type_arena: *mut TypeArena,
}

impl Unifier {
    /// Unify two types.  Returns the unified TypeId.
    fn unify(&mut self, a: TypeId, b: TypeId) -> Result<TypeId, TypeError>;

    /// Resolve an InferVar to its final binding, if any.
    fn resolve(&self, ty: TypeId) -> TypeId;

    /// Occurs check: is `var_id` contained in `ty`?
    fn occurs(&self, var_id: u32, ty: TypeId) -> bool;
}
```

### Type errors

Clear error messages for common inference failures:

| Scenario | Message |
|----------|---------|
| `1 + "hello"` | `mismatched types: expected 'Int', found 'Str'` |
| `if true { 1 } else { "hello" }` | `mismatched types in if branches: 'Int' vs 'Str'` |
| `x = 1; x = "hello"` | `cannot assign 'Str' to variable 'x' of type 'Int'` |
| Ambiguous type | `type cannot be inferred: add a type annotation` |

### Lambda inference

Lambdas get fresh type variables for each parameter.  The body generates
constraints on those variables.  When the lambda is used as an argument to
a function call like `map(fn, arr)`, the function's type signature
constrains the lambda's param types through unification.

This replaces the TS compiler's ad-hoc `inferLambdaParams` and
per-builtin inference rules.  No special cases needed.

### Overloaded functions

When a `Call` resolves to a name with multiple `Function` symbols, the
inference engine tries each overload and selects the one where all
constraints unify.  If zero match, report "no matching function."  If
multiple match, report "ambiguous call."

### What requires annotations

| Construct | Reason |
|-----------|--------|
| Named function params | Public API boundary; enables recursion and overloading |
| Variable declarations with `mut` | Optional — inference works without it |
| Return types on named functions | Optional — inferred from body |
| Lambda params | Optional — inferred from context |
| Generic enum type args | Required when context cannot resolve all params |

### Tests

```rust
#[test]
fn infer_int_literal() {
    let types = infer("42i");
    assert_eq!(types.of_main_expr(), TypeId::INT);
}

#[test]
fn infer_binary_add() {
    let types = infer("1 + 2");
    assert_eq!(types.of_main_expr(), TypeId::INT);
}

#[test]
fn infer_variable() {
    let types = infer("x = 42i; x");
    assert_eq!(types.of_last_expr(), TypeId::INT);
}

#[test]
fn infer_annotated_decl() {
    let types = infer("x: Num = 42");
    // 42 is unified with Num — no error
    assert_eq!(types.of_var("x"), TypeId::NUM);
}

#[test]
fn type_mismatch_error() {
    let (_, diags) = infer_with_diags("1 + \"hello\"");
    assert!(diags.has_errors());
}

#[test]
fn infer_lambda() {
    let types = infer("map(\x { x + 1 }, [1, 2, 3])");
    assert_eq!(types.of_main_expr(), TypeId::arr(TypeId::INT));
}

#[test]
fn infer_none_with_context() {
    let types = infer("x: Maybe[Int] = none; x");
    assert_eq!(types.of_var("x"), TypeId::maybe(TypeId::INT));
}

#[test]
fn infer_generic_identity() {
    let types = infer("func [T] id(x: T): T { x }; id(42)");
    assert_eq!(types.of_last_expr(), TypeId::INT);
}
```

---

## Cross-Cutting Concerns

Make sure all three are listed in the `Phase II` section of the module
ownership table in AGENTS.md (already done — just need to ensure the
files exist).

### 2. Cargo.toml

Already has `rustc-hash = "2"` and `id-arena = "2"` — no new
dependencies needed for Steps 5–6.

### 3. Diagnostic messages

Use clear, actionable messages.  Examples:

| Scenario | Message |
|----------|---------|
| Undefined name | `undefined name 'foo'` |
| Duplicate definition (non-function) | `duplicate definition of 'x'` |
| Shadowing (function overloading) | No error — overloading is intentional |
| Break outside loop | `'break' outside of a loop` |
| Continue outside loop | `'continue' outside of a loop` |

### 4. Test helpers

Create a shared test helper (in `tests/` or a `test_utils` module under
`src/`) for parse+resolve round-trips:

```rust
// tests/test_utils.rs or inline in resolve_test.rs
pub fn resolve_program(source: &str) -> (AstArena, Interner, DiagnosticsBag, ScopeTree, NodeId) {
    let src = SourceText::new("test.gema", source);
    let (tokens, scan_diags) = scan::scan(&src, 0);
    let mut arena = AstArena::new();
    let mut interner = Interner::new();
    let mut diagnostics = DiagnosticsBag::new();
    for d in scan_diags.into_vec() { diagnostics.push(d); }
    let root = parse::parse(&tokens, &mut arena, &mut interner, &mut diagnostics, 0);
    let scope_tree = resolve::resolve_names(&arena, root, &interner, &mut diagnostics);
    (arena, interner, diagnostics, scope_tree, root)
}
```

### 5. Transition from TypeNode to TypeId

After name resolution, each AST node still carries its parser-produced
`TypeNode` annotations.  The lowering function `lower_type_node` (defined
in `types.rs`) is called during **type inference** (Step 7).  Name
resolution (Step 6) does NOT touch type annotations at all.

The connection point: `resolve.rs` builds `resolved_refs: HashMap<NodeId,
SymbolId>`.  The type inference pass reads this map and the `ScopeTree`
to know what each name refers to.

---

## Testing Strategy

### Phase II Part 1 testing checkpoint

After implementing `types.rs`, `symbol.rs`, and `resolve.rs`:

```
cargo test                           # Unit tests for each module
cargo test types                     # Type internment, substitution, lowering
cargo test symbol                    # Scope tree, define/lookup, overloading
cargo test resolve                   # Name resolution round-trips
```

Create a dedicated test file `tests/resolve_test.rs` for integration-level
resolve tests (alongside the existing `tests/parse_comprehensive.rs`).

### What can be tested at this point

1. **Type system in isolation**: Interning, hash consing, substitution,
   fresh inference variables, concreteness checking.

2. **Scope tree in isolation**: Creating scopes, defining symbols, looking
   them up, parent-chain walking, shadowing.

3. **Full pipeline (scan+parse+resolve)**: Parsing a Gema program into
   an AST, then resolving all names.  At this point you can test:
   - Variables resolve to their definitions
   - Functions resolve to their definitions (including recursion)
   - Scoping rules (shadowing, block scope, function scope)
   - Error detection (undefined names, break/continue outside loop)
   - Structure definitions (structs, enums, traits) register correctly

### What is NOT tested yet (deferred to Part 2)

- Type errors (mismatched types, wrong arg counts) — that's type inference
- Generic monomorphization — Step 8
- Trait satisfaction — Step 9
- Codegen — Phase III

---

## Integration Checklist (Phase I & II — Complete)

- [x] `src/types.rs` created with `TypeId`, `TypeKind`, `TypeArena`
- [x] `lower_type_node` helper implemented (in `infer.rs` and `types.rs`)
- [x] Primitive types pre-interned
- [x] `substitute` works recursively on all compound types
- [x] `fresh_infer_var` produces unique IDs
- [x] `is_concrete` correctly identifies concrete types
- [x] `src/symbol.rs` created with `Symbol`, `SymbolKind`, `ScopeData`, `ScopeTree`
- [x] Scope tree supports parent-child relationships
- [x] Symbols can be defined by name (with function overloading support)
- [x] Scope chain lookup walks parents
- [x] `src/resolve.rs` created with `resolve_names()` public API
- [x] Resolver walks every AST node variant
- [x] Blocks create new scopes
- [x] FuncDef registers name before resolving body (enables recursion)
- [x] FuncDef params registered in body scope
- [x] ForLoop creates loop scope with variable
- [x] Break/Continue validated against loop stack
- [x] Undefined names produce diagnostics
- [x] Duplicate non-function definitions produce diagnostics
- [x] `resolved_refs` side table populated correctly
- [x] `node_scope` side table populated correctly
- [x] `src/infer.rs` created with unification-based type inference
- [x] `infer_types` takes `&mut ScopeTree` and populates symbol types
- [x] `src/lib.rs` updated with all module declarations
- [x] **310 unit tests pass**
- [x] **`cargo clippy` clean**

### Remaining for Phase III

- Generic monomorphization (Step 8)
- Trait satisfaction checking (Step 9)
- HIR lowering and JavaScript codegen
- Module system and linking
- Tree-shaking
- CLI entry point (`main.rs`)
