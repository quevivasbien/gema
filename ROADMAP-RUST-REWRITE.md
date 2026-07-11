# Gema Rust Rewrite — Architecture & Roadmap

This document lays out a phased plan for rewriting Gema in Rust. It is
organized into **three phases**, each building on the last:

- **Phase I — Core Infrastructure** (scaffolding, scanner, parser, AST)
- **Phase II — Semantic Analysis** (name resolution, type system, type
  inference, monomorphization)
- **Phase III — Codegen, Module System, Polish** (IR lowering, JS
  emission, module linking, tree-shaking)

Each phase is designed to be **independently testable** — you can stop
after Phase I and have a working parser, stop after Phase II and have a
fully typed program, etc.

---

## Table of Contents

1. [First Principles: Language Design Decisions](#1-first-principles-language-design-decisions)
   - [1a. Trait System](#1a-trait-system)
   - [1b. Mutability Model](#1b-mutability-model)
   - [1c. Target Scope](#1c-target-scope)
2. [Project Structure](#2-project-structure)
3. [Phase I — Core Infrastructure](#3-phase-i--core-infrastructure)
   - [Step 1: Source representation & diagnostics](#step-1-source-representation--diagnostics)
   - [Step 2: Scanner (Lexer)](#step-2-scanner-lexer)
   - [Step 3: Immutable AST with arena](#step-3-immutable-ast-with-arena)
   - [Step 4: Parser](#step-4-parser)
   - [Phase I testing checkpoint](#phase-i-testing-checkpoint)
4. [Phase II — Semantic Analysis](#4-phase-ii--semantic-analysis)
   - [Step 5: Interned type system](#step-5-interned-type-system)
   - [Step 6: Symbol table & name resolution](#step-6-symbol-table--name-resolution)
   - [Step 7: Type inference](#step-7-type-inference)
   - [Step 8: Generic monomorphization](#step-8-generic-monomorphization)
   - [Step 9: Builtin function resolution](#step-9-builtin-function-resolution)
   - [Phase II testing checkpoint](#phase-ii-testing-checkpoint)
5. [Phase III — Codegen & Polish](#5-phase-iii--codegen--polish)
   - [Step 10: lowering to codegen IR](#step-10-lowering-to-codegen-ir)
   - [Step 11: JavaScript emission](#step-11-javascript-emission)
   - [Step 12: Module system](#step-12-module-system)
   - [Step 13: Tree-shaking](#step-13-tree-shaking)
   - [Step 14: Error recovery & diagnostics polish](#step-14-error-recovery--diagnostics-polish)
   - [Step 15: Playground frontend](#step-15-playground-frontend)
6. [Dataflow Diagram](#6-dataflow-diagram)

---

## 1. First Principles: Language Design Decisions

Before writing any code, get clarity on these three axes. They affect
every downstream decision.

### 1a. Trait System

**The current design** defines traits as a set of named function
signatures. Implementation is *implicit* — you just define standalone
functions with the right name and signature:

```gema
trait Equals {
    equal[Self, Self]: Bool
}

// Implicit implementation for MyType:
func equal(a: MyType, b: MyType): Bool { ... }
```

**Disadvantages of the implicit approach:**

1. **No coherence.** Two modules can each define `equal(MyType, MyType)`
   with different behavior. Whichever gets imported last wins, silently.
2. **Name collision.** `add(MyType, MyType)` might be an `Add` trait
   impl, or it might be a completely unrelated function. The compiler
   can't distinguish, so trait dispatch relies on fragile string
   matching.
3. **No impl-scoped imports.** A trait impl often needs helper functions
   that shouldn't pollute the global namespace.
4. **Cannot verify trait bounds.** `checkCandidateTypeSatisfiesTrait`
   does string-based scope lookups — it's expensive and fallible.
5. **No associated types or constants.** The current `Self::x` hack for
   associated functions works but doesn't extend to associated types.

**Recommendation: Explicit `impl` blocks**

Add explicit `impl Trait for Type` syntax:

```gema
impl Equals for MyType {
    func equal(a: Self, b: Self): Bool { ... }
}
```

This fixes every issue above:
- Implementations are **coherent** — a given `<Trait, Type>` pair has
  exactly one impl in scope.
- The compiler can **verify trait bounds** by looking up the impl table,
  not by string-matching function names.
- `Self` is unambiguously the implementing type.
- The path is open to **associated types** later (`type Output` in a
  trait) and **blanket impls** (`impl [T: Equals] Equals for Arr[T]`).

**How it fits the rest of the design:**

The syntax is already prepared for this — the existing `struct`, `enum`,
`func`, and `trait` keywords establish the pattern. An `impl` block
follows naturally:

```gema
trait Add {
    add(Self, Self): Self
}

struct Vec2 { x: Num, y: Num }

impl Add for Vec2 {
    func add(a: Self, b: Self): Self {
        Vec2(a.x + b.x, a.y + b.y)
    }
}
```

**What about `Self` as a type annotation?** You keep it — it resolves to
the implementing type inside the impl block and acts as a constrained
generic parameter outside it.

**Migration path:** During the rewrite, you can drop the current "just
define a matching function" approach entirely and start fresh with
explicit impls. The language is young enough that breaking changes are
acceptable.

### 1b. Mutability Model

**Current:** `mut x = ...` with field-level mutability on structs.
No borrow checker, no ownership tracking (though there's a
deprecated `isConsumed` vestige).

**Recommendation:** Keep the current **pragmatic mutable/immutable
split** for Phase I. You can layer ownership on later if you want.

Why:
- Compiling ownership semantics to JavaScript (no borrow checker, no
  heap-allocated references by default) is a research problem, not an
  implementation detail.
- The current approach — `mut` at binding sites and struct field level
  — maps naturally to JS `let` vs `const` and direct property
  assignment.
- The `isConsumed` tracker was an early attempt at linear types that
  was wisely deprecated. Don't revive it unless you have a clear
  use-case.

**If you want ownership later:** Add it as an opt-in lint or a separate
pass that tracks move/borrow semantics on the typed HIR. The HIR still
emits the same JS; ownership is a *static check*, not a codegen concern.

### 1c. Target Scope

**Hobby/learning project.** This means:

- **Optimize for clarity over performance** of the compiler itself.
- **Don't build an LSP** unless you want to as a separate project.
- **Prioritize good error messages** — they're the #1 thing that makes
  a hobby language usable.
- **Keep dependencies minimal.** The Rust ecosystem has great crate
  choices at every level, but you don't need a parser generator or a
  full query-based incremental system. A hand-written scanner + parser
  + recursive tree walks is fully appropriate.

---

## 2. Project Structure

```
gema/
├── Cargo.toml              # workspace root (single crate is fine)
├── src/
│   ├── main.rs             # CLI entry point (compile file, etc.)
│   ├── lib.rs              # Re-exports, module declarations
│   │
│   │   ── Phase I ──
│   ├── source.rs            # SourceText, Span, SourceMap
│   ├── diagnostics.rs       # Diagnostic, Severity, Error emission
│   ├── scan.rs              # Scanner (lexer) → Vec<Token>
│   ├── token.rs             # TokenKind, Token
│   ├── ast.rs               # Expr enum, all AST node types
│   ├── arena.rs             # Arena<T>, NodeId generics
│   └── parse.rs             # Pratt parser → RootNode<Expr>
│   │
│   │   ── Phase II ──
│   ├── types.rs             # TypeKind, TypeId, TypeArena
│   ├── symbol.rs            # Symbol, SymbolTable, ScopeTree
│   ├── resolve.rs           # Name resolution pass
│   ├── infer.rs             # Type inference (constraint-based)
│   ├── monomorphize.rs      # Generic instantiation pass
│   ├── builtins.rs          # Builtin function signatures
│   └── traits.rs            # Trait resolution (impl lookup)
│   │
│   │   ── Phase III ──
│   ├── lower.rs             # AST → HIR lowering
│   ├── hir.rs               # HIR type definitions
│   ├── codegen.rs           # HIR → JavaScript string
│   ├── modules.rs           # ModuleGraph, linking
│   └── tree_shake.rs        # Dead code elimination
│
├── tests/
│   ├── scan_test.rs
│   ├── parse_test.rs
│   ├── resolve_test.rs
│   ├── infer_test.rs
│   ├── codegen_test.rs
│   └── integration_test.rs  # Full compile+eval tests
│
└── frontend/                # Web playground (same as now)
```

**Single-crate vs workspace:** Start with a single crate. You can split
into `gema-core`, `gema-cli`, `gema-wasm` later if the need arises.
Premature multi-crate adds friction for no benefit.

**Key Cargo dependencies (recommended):**

| Crate | Why | When |
|-------|-----|------|
| `codespan-reporting` or `miette` | Beautiful, structured diagnostics with source snippets | Phase I |
| `rustc-hash` | Fast `FxHashMap` / `FxHashSet` for symbol tables | Phase II |
| `wasm-pack` / `wasm-bindgen` | WASM target for the playground | Phase III |
| `clap` | CLI argument parsing | Phase I (trivial, or skip it) |

**What NOT to add:**
- `logos` / `nom` / `pest` — hand-written scanner+parser is cleaner for
  a language this size
- `lalrpop` — Pratt parsing is already working; no need for a grammar
  DSL
- `salsa` — incremental query system is overkill for a hobby compiler
- `inkwell` / `llvm-sys` — you're compiling to JS, not native code

User note: since inkwell and llvm-sys are mentioned here, it's worth noting that I would eventually like to experiment with targeting LLVM instead of just JS, so we should try to structure the project in such a way that it would not require a huge amount of refactoring to support a different compilation target in the future.

---

## 3. Phase I — Core Infrastructure

### Step 1: Source representation & diagnostics

**Goal:** Define how the compiler tracks source positions and reports
errors.

**SourceText:**
```rust
pub struct SourceText {
    pub text: String,
    pub name: String,  // filename or "<stdin>"
}
```

**Span:**
```rust
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct Span {
    pub start: u32,  // byte offset
    pub end: u32,
}
```

Span is *byte offset pair*, not line/col. Line/col is computed lazily
from the `SourceMap` when displaying diagnostics. This is critical
because:
- Spans survive transformations (parsing, lowering, codegen) without
  re-computation
- They're `Copy` — cheap to thread everywhere
- They compose naturally (`span.union(other_span)`)

**SourceMap:**
```rust
pub struct SourceMap {
    files: Vec<SourceText>,
}
impl SourceMap {
    pub fn new(source: SourceText) -> Self;
    pub fn lookup_line_col(&self, span: Span) -> (usize, usize);
    pub fn lookup_source(&self, span: Span) -> &str;
}
```

**Diagnostics:**
```rust
pub struct Diagnostic {
    pub severity: Severity,    // Error | Warning | Note
    pub message: String,
    pub span: Span,
    pub source_file: String,
}

pub struct DiagnosticsBag {
    diagnostics: Vec<Diagnostic>,
}

impl DiagnosticsBag {
    pub fn push(&mut self, diag: Diagnostic);
    pub fn has_errors(&self) -> bool;
    pub fn emit(&self, source_map: &SourceMap);  // pretty-print
}
```

**Why not use exceptions?** The Rust equivalent of exceptions is
`panic!` + `catch_unwind`, which is fragile and doesn't compose. A
`DiagnosticsBag` threaded through the compiler lets you collect multiple
errors per pass.

---

### Step 2: Scanner (Lexer)

**Goal:** Produce a `Vec<Token>` from `&SourceText`.

```rust
pub enum TokenKind {
    // Literals
    Integer(String),  // "42" from "42i" — stores the digits, not the 'i'
    Num(String),      // "3.14", "1e10"
    String(String),   // content without quotes
    // Identifiers and keywords
    Ident(String),
    // Keywords — reuse Ident and check at the parser level, OR
    // encode them here. Encoding them here is more explicit.
    Fn, Struct, Enum, Trait, Impl,  // ...
    True, False, None,
    // Punctuation
    Plus, Minus, Star, Slash, Percent,
    Eq, EqEq, Bang, BangEq,
    // ...
}

pub struct Token {
    pub kind: TokenKind,
    pub span: Span,
}
```

Key design decisions:
- **No `i` suffix on the integer token.** Strip it during scanning and
  mark the token as `TokenKind::Integer`. The `i` is a suffix, not part
  of the value.
- **Comments (`# ...`) are skipped entirely**, same as now.
- **String escape processing** (if any) happens during scanning, not
  during parsing.

**Implementation:**
```rust
pub fn scan(source: &SourceText) -> (Vec<Token>, DiagnosticsBag) {
    let mut scanner = Scanner::new(source);
    let mut tokens = Vec::new();
    let mut diagnostics = DiagnosticsBag::new();
    loop {
        match scanner.next_token(&mut diagnostics) {
            Some(token) => tokens.push(token),
            None => break,
        }
    }
    (tokens, diagnostics)
}
```

Return diagnostics from the scanner so malformed tokens (unterminated
strings, invalid numeric suffixes) produce errors instead of panics.

---

### Step 3: Immutable AST with arena

**Goal:** Define the AST as a set of recursive enums stored in arenas.

**Core pattern:**
```rust
pub type NodeId = id_arena::Id<NodeData>;

pub struct NodeData {
    pub kind: NodeKind,
    pub span: Span,
}

pub enum NodeKind {
    // Literals
    IntLit(String),
    NumLit(String),
    StrLit(String),
    BoolLit(bool),
    NoneLit,

    // Variables and names
    Var(Var),
    Call(Call),
    DirectCall(DirectCall),

    // Definitions
    FuncDef(FuncDef),
    StructDef(StructDef),
    EnumDef(EnumDef),
    TraitDef(TraitDef),
    ImplBlock(ImplBlock),

    // Control flow
    Block(Block),
    If(If),
    ForLoop(ForLoop),
    Break,
    Continue,
    Return(Option<NodeId>),
    Match(Match),

    // Expressions
    Binary(Binary),
    Unary(Unary),
    FieldAccess(FieldAccess),
    FieldAssign(FieldAssign),
    Assign(Assign),
    TupleLit(TupleLit),
    TupleUnpack(TupleUnpack),
    ArrLit(ArrLit),
    RangeIter(RangeIter),
    Pipe(PipeExpr),

    // Modules
    Use(Use),
    UseJs(UseJs),
}

// Child references use NodeId, not `Box<Expr>`.
pub struct Block {
    pub stmts: Vec<NodeId>,
}

pub struct Binary {
    pub op: BinaryOp,
    pub left: NodeId,
    pub right: NodeId,
}

pub struct FuncDef {
    pub name: IdentId,
    pub is_generic: bool,
    pub type_params: Vec<IdentId>,
    pub params: Vec<Param>,
    pub return_type: Option<TypeNode>,
    pub body: NodeId,
}
```

**Arena:**
```rust
use id_arena::Arena;

pub struct AstArena {
    pub nodes: Arena<NodeData>,
    // Additional interning tables:
    pub idents: Interner<str>,  // or a simple Vec<String>
}

impl AstArena {
    pub fn new_node(&mut self, kind: NodeKind, span: Span) -> NodeId {
        self.nodes.alloc(NodeData { kind, span })
    }
}
```

**Why arenas?**
- `NodeId` is `Copy` (u32 internally) — no `Box` or `Rc` overhead
- All nodes have the same lifetime (the arena's), so the borrow checker
  is happy
- Side tables (`HashMap<NodeId, TypeId>`) are natural
- The arena can be dropped as a group, no recursive `Drop`

**TypeNode for type annotations:**
```rust
pub enum TypeNode {
    // Primitives
    Int, Num, Str, Bool, Null,
    // Compounds — these match the current `getType()` function
    Func { param_types: Vec<TypeNode>, return_type: Box<TypeNode> },
    Arr(Box<TypeNode>),
    Iter(Box<TypeNode>),
    MutArr(Box<TypeNode>),
    Tup(Vec<TypeNode>),
    Dict { key: Box<TypeNode>, value: Box<TypeNode> },
    MutDict { key: Box<TypeNode>, value: Box<TypeNode> },
    Set(Box<TypeNode>),
    MutSet(Box<TypeNode>),
    Maybe(Box<TypeNode>),
    // Named types (user-defined or type vars)
    Named { name: IdentId, args: Vec<TypeNode> },
    // Self keyword
    SelfType,
    /// Generic param reference used in function/struct/enum definitions
    Generic { name: IdentId, traits: Vec<IdentId> },
}
```

`TypeNode` is what the parser produces. It gets *resolved* into interned
`Type` values (Phase II, Step 5) during type inference.

---

### Step 4: Parser

**Goal:** Convert `Vec<Token>` → `AstArena` + root `NodeId` +
`DiagnosticsBag`.

**Approach:** Pratt parser, closely modeled on the current
`parse.ts` but cleaner because:
- No exception-based error handling — collect into `DiagnosticsBag`
  and insert `ErrorExpr` sentinel nodes
- No recursive module parsing — parse `use` statements as leaf nodes
  with just a path string and optional symbol list; module linking
  happens in Phase III
- No `skipCascadeTypes` flag — the parser's only job is to produce an
  AST

```rust
pub struct Parser<'a> {
    tokens: &'a [Token],
    pos: usize,
    arena: &'a mut AstArena,
    diagnostics: &'a mut DiagnosticsBag,
    // Optional: a small token-injection stack for `..` range syntax
}

impl<'a> Parser<'a> {
    pub fn parse(&mut self) -> Option<NodeId> { ... }
}
```

**Error recovery strategy:** Insert `ErrorExpr` sentinel nodes and
advance to the next statement boundary (semicolon, `}`, or matching
delimiter). This prevents one bad expression from aborting the entire
parse.

**Precedence table** — port the current `PARSE_RULES` table directly.
The Pratt approach maps beautifully to Rust:

```rust
fn get_infix_rule(kind: &TokenKind) -> Option<InfixRule> {
    use TokenKind::*;
    match kind {
        Plus | Minus => Some(InfixRule::left(Prec::Term)),
        Star | Slash | Percent => Some(InfixRule::left(Prec::Factor)),
        EqEq | BangEq => Some(InfixRule::left(Prec::Comparison)),
        And => Some(InfixRule::left(Prec::And)),
        Or => Some(InfixRule::left(Prec::Or)),
        Dot => Some(InfixRule::field_access()),
        LParen => Some(InfixRule::call()),
        LBracket => Some(InfixRule::index()),
        Pipe => Some(InfixRule::right(Prec::Pipe)),
        _ => None,
    }
}
```

---

### Phase I testing checkpoint

What you can test at this point:

```rust
#[test]
fn scan_simple() {
    let source = SourceText::new("42", "test.gema");
    let (tokens, errors) = scan(&source);
    assert!(errors.is_empty());
    assert_eq!(tokens.len(), 1);
    assert!(matches!(tokens[0].kind, TokenKind::Integer(..)));
}

#[test]
fn parse_binary_expr() {
    let (ast, arena, diagnostics) = parse_source("1 + 2 * 3");
    assert!(diagnostics.is_empty());
    // Verify tree structure
    let root = &arena.nodes[ast.unwrap()];
    assert!(matches!(root.kind, NodeKind::Block(_)));
}

#[test]
fn parse_error_recovery() {
    let (ast, _arena, diagnostics) = parse_source("x = ;");
    assert!(diagnostics.has_errors());
    // Parser should still produce an AST (with error sentinel nodes)
    assert!(ast.is_some());
}
```

---

## 4. Phase II — Semantic Analysis

### Step 5: Interned type system

**Goal:** Replace `TypeNode` (recursive, contains strings) with
interned `TypeId` (flat arena index).

```rust
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct TypeId(u32);

pub struct TypeArena {
    types: Vec<TypeKind>,
}

pub enum TypeKind {
    Int,
    Num,
    Str,
    Bool,
    Null,
    Func { params: Vec<TypeId>, ret: TypeId },
    Array(TypeId),
    Iter(TypeId),
    MutArr(TypeId),
    Tuple(Vec<TypeId>),
    Dict { key: TypeId, val: TypeId },
    MutDict { key: TypeId, val: TypeId },
    Set(TypeId),
    MutSet(TypeId),
    Maybe(TypeId),
    /// User-defined or generic type reference.
    /// - `name` is the symbol (e.g., "MyStruct", "T")
    /// - `args` are any type arguments (e.g., `[Int, Str]` for `Pair[Int, Str]`)
    Named { name: IdentId, args: Vec<TypeId> },
    /// A type variable (generic parameter during inference).
    /// `id` is a unique index, `bound` is an optional trait name.
    InferVar { id: u32, bound: Option<IdentId> },
}
```

**Key invariants:**
- `TypeArena` deduplicates structurally equivalent types via
  `FxHashMap<TypeKind, TypeId>` (hash consing)
- Named types with different `args` are different `TypeId`s
- `InferVar` is only present during type inference; after
  monomorphization, every type is concrete

**Operations:**
```rust
impl TypeArena {
    pub fn intern(&mut self, kind: TypeKind) -> TypeId;
    pub fn get(&self, id: TypeId) -> &TypeKind;
    pub fn substitute(&mut self, ty: TypeId, bindings: &HashMap<IdentId, TypeId>) -> TypeId;
    pub fn structural_eq(&self, a: TypeId, b: TypeId) -> bool;
}
```

Because of hash consing, `structural_eq` is often just `a == b`.

---

### Step 6: Symbol table & name resolution

**Goal:** A separate pass that builds a scope tree and resolves every
name reference to its definition.

```rust
pub struct Symbol {
    pub name: IdentId,
    pub kind: SymbolKind,
    pub def_node: NodeId,  // the AST node that defines this symbol
    pub visibility: Visibility,
}

pub enum SymbolKind {
    Variable { ty: TypeId, is_mut: bool },
    Function { full_name: IdentId, is_generic: bool },
    Struct { generics: Vec<IdentId> },
    Enum { generics: Vec<IdentId>, variants: Vec<EnumVariant> },
    Trait { required_funcs: Vec<FuncSig> },
    Impl { trait_name: IdentId, self_type: TypeId },
    // Generic type parameter
    TypeParam { bound: Option<IdentId> },
}

pub struct ScopeTree {
    /// Parent-child relationships among scopes
    pub scopes: Arena<ScopeData>,
    /// For each AST node, which scope it belongs to
    pub node_scope: HashMap<NodeId, ScopeId>,
}

pub struct ScopeData {
    pub parent: Option<ScopeId>,
    pub symbols: FxHashMap<IdentId, SymbolId>,
    pub children: Vec<ScopeId>,
}
```

**Resolution pass:**
```rust
pub fn resolve_names(
    arena: &AstArena,
    root: NodeId,
    diagnostics: &mut DiagnosticsBag,
) -> ScopeTree {
    let mut resolver = Resolver::new(arena, diagnostics);
    resolver.resolve_block(root);
    resolver.scope_tree
}
```

Algorithm:
1. Walk the AST top-down.
2. Enter a new scope at `Block`, `FuncDef`, `ForLoop`, `ImplBlock`.
3. On encountering a definition (`Assignment`, `FuncDef`, `StructDef`,
   `EnumDef`, `TraitDef`, `ImplBlock`), register it in the current
   scope. Detect shadowing with a warning (or error, your call).
4. On encountering a reference (`Variable`, `Call.name`), look up the
   name by walking up the scope chain. Record the resolved
   `SymbolId` in a side table `HashMap<NodeId, SymbolId>`.
5. On encountering a **generic type parameter** (e.g., `[T: TraitName]`
   on a function or struct), register `T` as a `TypeParam` in the
   function's scope.

**Why not conflate with type inference?** Because name resolution is
unconditional — it doesn't depend on types at all. Separating it means:
- You get "undefined name" errors immediately, before any type checking
- The type inference pass can assume every name is resolved
- The passes are independently testable

---

### Step 7: Type inference

**Goal:** Walk the resolved AST and assign a `TypeId` to every
expression node.

**Approach:** Bidirectional (bottom-up + top-down) type checking
using the "AST typing" pattern (attribute grammar style). No type
variables or unification is needed for a simple language like Gema
— expressions either have known types from their sub-expressions or
can be inferred from context.

```rust
pub fn infer_types(
    arena: &AstArena,
    scope_tree: &ScopeTree,
    type_arena: &mut TypeArena,
    root: NodeId,
    diagnostics: &mut DiagnosticsBag,
) -> HashMap<NodeId, TypeId> {
    let mut infer = Inferer::new(arena, scope_tree, type_arena, diagnostics);
    infer.infer_expr(root, None);
    infer.types
}
```

**How each expression is typed (roughly):**

| Expression | Inference rule |
|---|---|
| `IntLit` | Type is always `Int` |
| `NumLit` | Type is always `Num` |
| `StrLit` | Type is always `Str` |
| `BoolLit` | Type is always `Bool` |
| `NoneLit` | Type is `Maybe[T]` where `T` is inferred from context |
| `Variable` | Look up `Symbol.ty` from the symbol table |
| `Binary(a, op, b)` | Type-check `a` and `b`; result type from operator table |
| `Call(name, args)` | Look up function signature; substitute generics if needed |
| `FuncDef(...)` | Register `FuncType` in scope; type-check body with return type |
| `Block(stmts)` | Type is the type of the last statement |
| `If(conds, else)` | All branches must have the same type |
| `Match(scrutinee, arms)` | Each arm type-checked; must unify to a single type |

**The key simplification:** Because Gema has no subtyping, no
higher-kinded types, and no complex type inference (like Hindley-Milner
with let-polymorphism), the inference pass can be a straightforward
recursive walk. The only tricky part is:

1. **Lambda param type inference** — when a closure is passed to
   `map`, `filter`, `reduce`, etc., the param types are inferred from
   the function signature. This is the existing
   `inferLambdaParams` logic, but now operating on the typed IR.

2. **`none` type inference** — `none` is `Maybe[T]` where `T` is
   inferred from how the value is used (assigned to a variable, passed
   to a function, etc.). This is a classic bidirectional inference
   problem and is handled by threading an "expected type" context
   parameter through the walk.

User note: it would actually be nice to have more complex type inference so we don't need to provide type annotations in some locations where they are currently required (e.g., when creating empty arrays, instantiating generic enums, or using functions as values). 

---

### Step 8: Generic monomorphization

**Goal:** After type inference, create concrete copies of every generic
function/struct/enum instantiation.

```rust
pub fn monomorphize(
    arena: &mut AstArena,
    type_arena: &mut TypeArena,
    types: &HashMap<NodeId, TypeId>,
    root: NodeId,
    diagnostics: &mut DiagnosticsBag,
) -> MonomorphizedProgram {
    // ...
}
```

**Algorithm:**

1. **Collect instantiations.** Walk the typed AST and find every
   `Call` to a generic function. Record `(func_symbol, [concrete_type,
   ...])` pairs. Likewise, find every `Variable` reference to a generic
   struct/enum with concrete type args.

2. **Deduplicate.** Use a `HashMap<(IdentId, Vec<TypeId>), NodeId>` to
   ensure each instantiation produces exactly one copy.

3. **Instantiate.** For each `(generic_def, concrete_types)` pair:
   - Clone the generic definition's AST subtree
   - Substitute all type parameters with their concrete types
   - Re-type-check the body (it may reference other generics, creating
     a transitive closure)
   - Assign a mangled name: `foo$Int$Str`

4. **Replace call sites.** Update each `Call` node to reference the
   monomorphized function's `NodeId` directly.

The output is a `MonomorphizedProgram`: an `AstArena` where all generic
nodes have been replaced with concrete copies, and a `Vec<(NodeId,
IdentId)>` mapping root call-site nodes to their monomorphized
function IDs.

**Why a separate pass?** Because monomorphization creates new AST nodes
that need their own type inference. Running monomorphization during
type inference (as the current code does) means you're interleaving two
recursive processes. Separating them makes the control flow simpler and
allows caching: if `foo[Int, Str]` is called from two places, you only
instantiate it once.

---

### Step 9: Builtin function resolution

**Goal:** Recognize calls to builtin functions (`map`, `filter`,
`reduce`, `push`, `pop`, `len`, etc.) and resolve them to codegen
templates.

**Approach:** Same as the current `BUILTIN_RESOLVERS` table in
`builtin-calls.ts`, but expressed as a Rust enum + match:

```rust
pub enum BuiltinFunc {
    Map,
    Filter,
    Reduce,
    Push,
    Pop,
    Length,
    // ... etc.
}

impl BuiltinFunc {
    pub fn try_from_name(name: &str, arg_types: &[TypeId]) -> Option<BuiltinFunc>;
    pub fn return_type(&self, arg_types: &[TypeId], type_arena: &TypeArena) -> TypeId;
    pub fn emit(&self, args: &[NodeId], writer: &mut JsWriter);
}
```

During type inference, after name resolution fails to find a
user-defined function, fall through to `BuiltinFunc::try_from_name`.
If it matches, annotate the `Call` node with a `BuiltinFunc` tag instead
of a normal function reference.

During codegen, the `BuiltinFunc::emit` method produces the
JavaScript runtime call, including any necessary wrapper code
(wrapping arrays in `$ArrayIterator$`, etc.).

---

### Phase II testing checkpoint

```rust
#[test]
fn type_int_literal() {
    let program = infer("42");
    assert_eq!(program.type_of_main_expr(), TypeId::INT);
}

#[test]
fn type_binary_op() {
    let program = infer("1 + 2.0");
    assert_eq!(program.type_of_main_expr(), TypeId::NUM);
}

#[test]
fn type_generic_function() {
    let program = infer(r#"
        func [T] id(x: T): T { x }
        id(42)
    "#);
    assert_eq!(program.type_of_last_expr(), TypeId::INT);
}

#[test]
fn monomorphize_generic() {
    let (program, arena) = compile(r#"
        func [T] double(x: T): T { x + x }
        double(1) + double(2.0)
    "#);
    // Two concrete copies: double$Int, double$Num
    assert!(program.has_function("double$Int"));
    assert!(program.has_function("double$Num"));
}
```

---

## 5. Phase III — Codegen & Polish

### Step 10: Lowering to codegen IR

**Goal:** Transform the richly-typed AST (with side tables) into a
simpler representation that maps directly to JavaScript.

**The HIR:**
```rust
pub enum HirExpr {
    /// Literals emit directly
    IntLit(String),
    NumLit(String),
    StrLit(String),
    BoolLit(bool),
    NoneLit(Option<TypeId>),  // Some for Maybe[T]

    /// Simple identifier (variable, function name after monomorphization)
    Ident(IdentId),

    /// Struct literal: { field1: value1, ... }
    StructLit(Vec<(IdentId, HirNodeId)>),

    /// Array literal: [value1, value2, ...]
    ArrayLit(Vec<HirNodeId>),

    /// Tuple literal: [value1, value2]
    TupleLit(Vec<HirNodeId>),

    /// Range: start..end (with step)
    RangeLit { start: HirNodeId, end: Option<HirNodeId>, step: Option<HirNodeId> },

    /// Binary operation (arithmetic, comparison, boolean)
    Binary { op: HirBinaryOp, left: HirNodeId, right: HirNodeId },

    /// Unary operation
    Unary { op: HirUnaryOp, child: HirNodeId },

    /// Variable assignment
    Assign { name: IdentId, value: HirNodeId, is_mut: bool },

    /// Field access: obj.field
    FieldAccess { obj: HirNodeId, field: IdentId },

    /// Field assignment: obj.field = value
    FieldAssign { obj: HirNodeId, field: IdentId, value: HirNodeId },

    /// Block (IIFE wrapping if value is used)
    Block { stmts: Vec<HirNodeId>, returns_value: bool },

    /// If / else if / else
    If {
        branches: Vec<(HirNodeId, HirNodeId)>,
        else_branch: Option<HirNodeId>,
    },

    /// For loop (lowered to while loop + iterator)
    ForLoop { var: IdentId, iter: HirNodeId, body: HirNodeId },

    /// Break, Continue, Return
    Break,
    Continue,
    Return(Option<HirNodeId>),

    /// Function call (after monomorphization — name is concrete)
    Call { name: IdentId, args: Vec<HirNodeId>, is_builtin: Option<BuiltinFunc> },

    /// Function definition (only at module level after monomorphization)
    FuncDef { name: IdentId, params: Vec<IdentId>, body: HirNodeId },

    /// Enum variant construction
    EnumLit { tag: u32, value: Option<HirNodeId>, is_tagged_union: bool },

    /// Match / switch on an enum
    Match {
        scrutinee: HirNodeId,
        arms: Vec<MatchArm>,
    },

    /// Pipe expression: a |> f |> g
    Pipe { chain: Vec<HirNodeId> },
}
```

**Lowering rules (examples):**

| AST pattern | HIR output |
|---|---|
| `Binary(a, '+', b)` where both are `Int` | `Binary { op: Add, left: a, right: b }` |
| `Binary(a, '//', b)` | `BuiltinCall { name: "intDiv", args: [a, b] }` |
| `Match(scrut, arms)` where scrut is `Maybe[T]` | `If(..isNone..) { none .. } else { some .. }` |
| `Block(stmts)` where value is used | Wrapped in `(() => { .. })()` |
| `ForLoop(var, iter, body)` | `while` loop with `iter.next()` |
| `Call("map", [fn, iter])` | `BuiltinFunc::Map` |
| Generic call after monomorphization | `Call { name: "map$Int$Str", args: [...] }` |

The HIR is **flat** — no recursion, no side tables. Every child
reference is a `HirNodeId` index into a `Vec<HirExpr>`. You could
serialize it to JSON if you wanted.

---

### Step 11: JavaScript emission

**Goal:** Walk the HIR and produce a JavaScript string.

```rust
pub struct JsWriter {
    output: String,
    indent: usize,
    // Track which runtime builtins are needed
    needed_builtins: FxHashSet<BuiltinRuntime>,
}

impl JsWriter {
    pub fn emit_expr(&mut self, hir: &HirProgram, node: HirNodeId);
    pub fn finish(&mut self, mode: OutputMode) -> String;
}

pub enum OutputMode {
    Immediate,  // () => { ... }()
    Inline,     // const main = () => { ... };
    Export,     // export const main = () => { ... };
}
```

**Emission rules map directly from HIR to JS:**

| HIR node | JS output |
|---|---|
| `IntLit("42")` | `42n` |
| `NumLit("3.14")` | `3.14` |
| `StrLit("hello")` | `"hello"` |
| `StructLit([("x", a), ("y", b)])` | `{ x: a, y: b }` |
| `Call { name: "foo$Int", args }` | `foo$Int(args)` |
| `BuiltinFunc::Map` | `mapFn(fn, iter)` |
| `Block { ..., returns_value: true }` | `(() => { ... return val; })()` |
| `ForLoop { var, iter, body }` | `for (let var; ; ) { ... iter.next() ... }` |

**No more `toJS` closures stored during type-checking.** The HIR is a
pure data structure. Codegen is a pure function:
```rust
fn codegen(program: &HirProgram) -> String
```

---

### Step 12: Module system

**Goal:** Link multiple `.gema` files via `use` statements.

**Approach (simpler than the current recursive parsing):**

1. **Parse phase:** Each file is scanned and parsed independently,
   producing `Module { path, ast, exports: Vec<IdentId> }`.
   A `use "foo.gema"` statement stores just the path string.

2. **Module graph building:** The compiler resolves `use` paths to
   module files, building a `ModuleGraph`:
   ```rust
   pub struct ModuleGraph {
       pub modules: Vec<Module>,
       pub entry: usize,
   }
   ```

3. **Linking pass:** Walk the AST of each module. For each `Use` node:
   - Locate the target module in the graph
   - Read its exports (either all symbols or the explicitly listed ones)
   - Register each exported symbol in the current module's scope with a
     `source_module` annotation

**Circular imports:** Detect them during graph construction by
tracking which modules are currently being resolved. This is a clean
graph algorithm problem, not something buried in recursive parser
calls.

**Selective imports:** `use { foo, bar } from "utils.gema"` — only
the listed symbols are added to the scope. The same linking pass
handles this.

---

### Step 13: Tree-shaking

**Goal:** Remove dead code from the final JS bundle.

**Approach (much simpler than the current approach):**

After name resolution, each symbol has a `defined_at: NodeId` and we
have a reference graph from the resolution pass. Tree-shaking becomes:

```rust
pub fn compute_reachable(
    scope_tree: &ScopeTree,
    root: NodeId,
    arena: &AstArena,
    resolved_refs: &HashMap<NodeId, SymbolId>,
) -> FxHashSet<SymbolId> {
    // Phase 1: Start from the entry expression (last expression of the
    // entry module's top-level block).
    // Phase 2: Follow all symbol references transitively.
    //    - Every `Variable` use resolves to a SymbolId
    //    - Every `Call` name resolves to a SymbolId
    //    - Function bodies are followed recursively
    //    - Struct/Enum definitions referenced in types are followed
    // Phase 3: Return the set of reachable SymbolIds.
}
```
let
Then, during codegen (or as a filter on the HIR), only emit symbols
in the reachable set. Functions that are never called, variables that
are never read, and types that are never instantiated are dropped.

**Why this is simpler than the current approach:**
- The current code does ad-hoc string matching (`reachable.has(name)`,
  `name.includes("$")`, etc.)
- The new approach uses actual resolved `SymbolId`s, so there are no
  name collisions or string parsing issues
- Function calls through trait impls are captured naturally because
  the call site's `SymbolId` points to the monomorphized function

---

### Step 14: Error recovery & diagnostics polish

**Goal:** Collect multiple errors per pass; produce beautiful,
actionable error messages.

**Recovery strategies:**

| Pass | Recovery |
|------|----------|
| Scanner | Skip bad characters; continue to next token |
| Parser | Insert `ErrorExpr` sentinel; skip to next `;` or `}` |
| Name resolution | For undefined names, create a synthetic "error symbol" and continue |
| Type inference | On type mismatch, emit error but continue with a best-guess type |
| Codegen | On unrecognized IR node, emit `/* ERROR */` and continue |

**Error formatting:**

Using `miette` or `codespan-reporting`:

```
error[E001]: cannot add values of type `Str` and `Int`
  ┌─ test.gema:3:11
  │
3 │ x = "hello" + 42
  │     ───┬─── ^ ──
  │        │       │
  │        │       this has type `Int`
  │        this has type `Str`
  │
  = note: binary operator `+` requires both operands to have the same type
```

---

### Step 15: Playground frontend

The existing frontend (`frontend/editor.js`, `frontend/index.html`)
compiles Gema source using the TypeScript compiler loaded from a Bun
module. In the Rust rewrite:

1. Compile the Rust compiler to WASM using `wasm-pack`
2. Expose a function: `compile(source: &str) -> String` (returns JS or
   errors as a JSON string)
3. The frontend calls this WASM function instead of the TS one

This is a late step because you need the full compiler working before
it's worth doing the WASM build.

---

## 6. Dataflow Diagram

```
 Source Text
     │
     ▼
 ┌──────────┐    Phase I
 │  Scanner  │──── Token stream
 └──────────┘
     │
     ▼
 ┌──────────┐
 │  Parser   │──── Immutable AST (Arena-owned)
 └──────────┘     + DiagnosticsBag
     │
     ▼
 ┌────────────────┐  Phase II
 │ Name Resolution│──── ScopeTree, SymbolTable
 └────────────────┘     Resolved refs map
     │
     ▼
 ┌────────────────┐
 │ Type Inference │──── Expr → TypeId map
 └────────────────┘
     │
     ▼
 ┌──────────────────┐
 │ Monomorphization │──── Fully concrete AST
 └──────────────────┘
     │
     ▼
 ┌──────────┐       Phase III
 │ Lowering │──── HIR (flat codegen IR)
 └──────────┘
     │
     ▼
 ┌────────────────┐
 │ Tree Shaking   │──── Filtered HIR
 └────────────────┘
     │
     ▼
 ┌──────────┐
 │ Codegen  │──── JavaScript string
 └──────────┘
```

Each box is a pure function: `(Input) -> Result<Output, Diagnostics>`.
No mutable shared state between passes.

---

## Appendix: Migrating the Test Suite

The current test suite (`tests/*.test.ts`) is comprehensive (~21 test
files). The recommended migration order:

1. **Scanner tests first** — `tests/scan_test.rs` — literal parsing,
   number suffixes, string escapes, comments, operators
2. **Parser tests** — `tests/parse_test.rs` — AST shape verification
   for each language construct
3. **Name resolution tests** — `tests/resolve_test.rs` — scope
   lookups, shadowing, undefined names
4. **Type inference tests** — `tests/infer_test.rs` — type checking,
   generic instantiation, trait resolution
5. **Full compilation tests** — `tests/codegen_test.rs` — compile
   source, evaluate in a JS runtime, assert output. This maps 1:1 to
   the current `testCompile()` helper.

The `testCompile()` helper in TypeScript:
```ts
testCompile("1 + 2", 3)
```
becomes in Rust:
```rust
#[test]
fn add_integers() {
    let result = compile_and_eval("1 + 2");
    assert_eq!(result, Value::Num(3.0));
}
```

You'll need a JS runtime for evaluation tests. The options are:
- **Boa** (pure Rust JS interpreter) — good for testing, no binary
  dependency
- **Deno core** (V8 bindings) — heavier but a real JS runtime
- **Sidecar** — compile to a file, then run with `node` or `bun` in
  a test subprocess

For a hobby project, the **sidecar approach** is simplest: the test
writes the compiled JS to a temp file, spawns `bun run temp.js`, and
reads stdout. It's what the current tests effectively do.
