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
7. [Breaking changes](#7-breaking-changes)

---

## 1. First Principles: Language Design Decisions

Before writing any code, get clarity on these three axes. They affect
every downstream decision.

### 1a. Trait System

**The current design** defines traits as a set of named function
signatures. Implementation is _implicit_ — you just define standalone
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
emits the same JS; ownership is a _static check_, not a codegen concern.

### 1c. Target Scope

**Hobby/learning project.** This means:

- **Optimize for clarity over performance** of the compiler itself.
- **Don't build an LSP** unless you want to as a separate project.
- **Prioritize good error messages** — they're the #1 thing that makes
  a hobby language usable.
- **Keep dependencies minimal.** The Rust ecosystem has great crate
  choices at every level, but you don't need a parser generator or a
  full query-based incremental system. A hand-written scanner + parser
  - recursive tree walks is fully appropriate.

---

## 2. Project Structure

```
gema/
├── Cargo.toml              # single crate
├── src/
│   ├── lib.rs              # Module declarations
│   │
│   │   ── Phase I ──
│   ├── source.rs           # SourceText, Span, SourceMap
│   ├── diagnostics.rs      # Diagnostic, Severity, DiagnosticsBag
│   ├── token.rs            # TokenKind, Token
│   ├── scan.rs             # Scanner
│   ├── ast.rs              # Expr enum, AstArena (= Arena<Expr>), TypeNode
│   └── parse/
│   |   ├── mod.rs          # Public parse() entry point
│   |   ├── parser.rs       # Pratt parser
│   |   ├── precedence.rs   # Precedence table
│   |   └── utils.rs        # Operator helpers
│   │
│   │   ── Phase II (all implemented) ──
│   ├── types.rs            # TypeId, TypeKind, TypeArena
│   ├── interner.rs         # IdentId, Interner
│   ├── symbol.rs           # Symbol, ScopeTree, ScopeData
│   ├── resolve.rs          # Name resolution pass (includes trait symbol registration)
│   ├── infer.rs            # Type inference (unification-based HM)
│   ├── monomorphize.rs     # Generic dictionary-passing (HIR-to-HIR transform)
│   └── builtins.rs         # Builtin function signatures + codegen templates
│   │
│   │   ── Phase III ──
│   ├── lower.rs            # AST → HIR lowering
│   ├── hir.rs              # HIR type definitions
│   ├── codegen.rs          # HIR → JavaScript string
│   ├── modules.rs          # ModuleGraph, linking
│   └── tree_shake.rs       # Dead code elimination (not yet implemented)
│
├── docs/
│   ├── variables.md        # Variable semantics
│   └── type-system.md      # Type system reference
│
└── frontend/               # Web playground (TS, Bun)
```

**Single-crate vs workspace:** Start with a single crate. You can split
into `gema-core`, `gema-cli`, `gema-wasm` later if the need arises.
Premature multi-crate adds friction for no benefit.

**Key Cargo dependencies (recommended):**

| Crate                            | Why                                                    | When                          |
| -------------------------------- | ------------------------------------------------------ | ----------------------------- |
| `codespan-reporting` or `miette` | Beautiful, structured diagnostics with source snippets | Phase I                       |
| `rustc-hash`                     | Fast `FxHashMap` / `FxHashSet` for symbol tables       | Phase II                      |
| `wasm-pack` / `wasm-bindgen`     | WASM target for the playground                         | Phase III                     |
| `clap`                           | CLI argument parsing                                   | Phase I (trivial, or skip it) |

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

Span is _byte offset pair_, not line/col. Line/col is computed lazily
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

`TypeNode` is what the parser produces. It gets _resolved_ into interned
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
    Void,
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
    /// User-defined (structs, enums): `Pair[Int, Str]`
    Custom { name: IdentId, args: Vec<TypeId> },
    /// Generic type param (e.g. `T` in `func [T: Hash]`)
    Generic { name: IdentId, bounds: Vec<IdentId> },
    /// Unknown type — inference variable (solved by unification)
    InferVar { id: u32 },
    /// `Self` in trait/impl contexts
    SelfType,
    /// Error-recovery sentinel
    Unknown,
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
    pub def_node: NodeId,
}

pub enum SymbolKind {
    Variable { type_id: Option<TypeId>, is_mut: bool },
    Function { full_name: Option<IdentId>, is_generic: bool, param_count: usize },
    Struct { type_params: Vec<IdentId> },
    Enum { type_params: Vec<IdentId>, variants: Vec<EnumVariant> },
    Trait { requirements: Vec<TraitRequirement> },
    Impl { trait_name: IdentId, self_type: TypeNode, member_nodes: Vec<NodeId> },
    TypeParam { bounds: Vec<IdentId> },
}

pub struct ScopeTree {
    pub scopes: Arena<ScopeData>,
    pub symbols: Arena<Symbol>,
    pub root_scope: ScopeId,
    pub node_scope: FxHashMap<NodeId, ScopeId>,
    pub resolved_refs: FxHashMap<NodeId, SymbolId>,
}

pub struct ScopeData {
    pub parent: Option<ScopeId>,
    pub symbols: FxHashMap<IdentId, Vec<SymbolId>>,
    pub children: Vec<ScopeId>,
}
```

**Resolution pass:**

```rust
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

### Step 7: Type inference (Unification-Based)

**Goal:** Assign a `TypeId` to every expression node by solving type
constraints generated from the program structure.

**Approach:** Hindley-Milner unification (Algorithm M). Each expression
gets a fresh `InferVar`; constraints are generated and solved via
`unify()`.  This replaces the TS compiler's ad-hoc cascade with a
principled system.

```rust
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

**Core algorithm:**

1. **Fresh variables**: Each expression that doesn't have a fixed type
   gets a fresh `InferVar`.

2. **Constraint generation**: Walk the AST and generate equality
   constraints.  For example:
   - `IntLit(42)` → type is `Int`
   - `Binary(l + r)` → `typeof(l) = typeof(r) = Int/Num`, result is the same
   - `Call(f, args)` → `typeof(f) = Func[typeof(args...): ret]`
   - `If(cond, then, else)` → all branches unify to the same type
   - `Match(scrutinee, arms)` → all arms unify
   - `ForLoop(var, iter, body)` → `typeof(iter) = Iter[typeof(var)]`
   - `NoneLit` → `Maybe[α]` where α is fresh (or from annotation)
   - `ArrLit([e1, e2])` → elements unify, result is `Arr[T]`
   - `FuncDef` → register function type, infer body, unify with return type
   - `AnonFunc` → params get fresh variables, body constrains them

3. **Unification**: `unify(a, b)` resolves `InferVar` bindings,
   performs occurs checks, handles compound types recursively (arrays,
   tuples, functions, etc.), and reports type mismatches.

4. **Type population**: After inference completes, `scope_tree` symbol
   type fields are populated from the results so downstream passes
   can read them.

**Key inference capabilities:**

| Feature | How it works |
|---------|-------------|
| Literals | Fixed types (`Int`, `Num`, `Str`, `Bool`) |
| `none` | `Maybe[α]` — α unified with expected type from context |
| Variable lookup | Scope-stack lookup (walked top-to-bottom for scoping) |
| Assignment | New decl or reassignment; scope-stack tracks `(TypeId, is_mut)` |
| Functions | Body inferred, return type from annotation or inferred from body |
| Lambdas | Params get fresh variables; body constrains them |
| Calls | Look up function type, unify param types with arg types |
| Struct construction | Field types unified with argument types |
| Struct field access | Field looked up from struct definition, generic params substituted |
| Enum variants | Variant's data type looked up from enum definition, params substituted |
| `Int`/`Num` | Separate types — no automatic promotion (explicit `toNum`/`toInt`) |
| `if` without `else` | Type is `Void` (expression may not produce a value) |
| Overloaded functions | Each overload tried independently via binding save/restore |

---

### Step 8: Generic monomorphization (dictionary passing)

**Goal:** After type inference, transform the HIR so that generic functions
receive trait implementation dictionaries as extra parameters, and call sites
pass the appropriate dictionaries.

**Status: Implemented.** Unlike the roadmap's original AST-cloning plan, the
actual implementation uses **dictionary passing** (type erasure). Generic
functions are compiled once and accept trait implementations as extra arguments.

**Approach (HIR-to-HIR transform):**

```rust
pub fn monomorphize(
    hir: HirExpr,
    arena: &AstArena,
    scope_tree: &ScopeTree,
    type_arena: &TypeArena,
    interner: &mut Interner,
) -> HirExpr
```

1. **Discover generic functions.** For each `FuncDef` with non-empty
   `type_params`, add one extra parameter per (type_param, trait) pair,
   named e.g. `$impl_T_Hash` for `func [T: Hash] foo(x: T)`.

2. **Route trait method calls inside generic bodies.** When the body
   contains `T::hash(x)`, the monomorphizer converts it to
   `$impl_T_Hash.hash(x)` (a `FieldAccess` through the descriptor).

3. **Build descriptor arguments at call sites.** For each call to a
   generic function, the monomorphizer looks up the concrete type from the
   arguments and constructs references to the impl block's named constants
   (e.g., `$impl_Int_Hash`).

4. **Impl blocks produce dictionary IIFEs.** Each `impl` block is lowered
   to an `ImplBlock` HIR node, emitted as:
   ```js
   const $impl_Int_Hash = (() => {
       function hash$0(x) { return x; }
       return { hash: hash$0 };
   })();
   ```

**Key difference from AST cloning:** Dictionary passing avoids duplicating
function bodies for each concrete type instantiation. The trade-off is that
generic functions pay a small runtime cost for indirect method dispatch
through the dictionary.

---

### Step 9: Builtin function resolution

**Status: Implemented.** See `src/builtins.rs`. Builtins are resolved during
type inference via `try_from_name`, and emitted via `BuiltinFunc::emit_js`
templates during codegen.

---


### Phase II testing checkpoint

```rust
// See src/infer.rs for the full test suite (310+ tests)

#[test]
fn int_literal() {
    let (_arena, _interner, diags, types, ta, root) = infer_types_map("42i");
    assert!(!diags.has_errors());
    let ty = last_expr_type(&_arena, root, &types, &ta);
    assert_eq!(ta.get(ty), &TypeKind::Int);
}

#[test]
fn binary_add_nums() {
    let (_arena, _interner, diags, types, ta, root) = infer_types_map("1.5 + 2.5");
    assert!(!diags.has_errors());
    let ty = last_expr_type(&_arena, root, &types, &ta);
    assert_eq!(ta.get(ty), &TypeKind::Num);
}

#[test]
fn named_func_call() {
    let (_arena, _interner, diags, types, ta, root) =
        infer_types_map("func add(x: Int, y: Int): Int { x + y }; add(1i, 2i)");
    assert!(!diags.has_errors());
    let ty = last_expr_type(&_arena, root, &types, &ta);
    assert_eq!(ta.get(ty), &TypeKind::Int);
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

    /// Pipe expression: a | f | g
    Pipe { chain: Vec<HirNodeId> },
}
```

**Lowering rules (examples):**

| AST pattern                                    | HIR output                                     |
| ---------------------------------------------- | ---------------------------------------------- |
| `Binary(a, '+', b)` where both are `Int`       | `Binary { op: Add, left: a, right: b }`        |
| `Binary(a, '//', b)`                           | `BuiltinCall { name: "intDiv", args: [a, b] }` |
| `Match(scrut, arms)` where scrut is `Maybe[T]` | `If(..isNone..) { none .. } else { some .. }`  |
| `Block(stmts)` where value is used             | Wrapped in `(() => { .. })()`                  |
| `ForLoop(var, iter, body)`                     | `while` loop with `iter.next()`                |
| `Call("map", [fn, iter])`                      | `BuiltinFunc::Map`                             |
| Generic call after monomorphization            | `Call { name: "map$Int$Str", args: [...] }`    |

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

| HIR node                             | JS output                                   |
| ------------------------------------ | ------------------------------------------- |
| `IntLit("42")`                       | `42n`                                       |
| `NumLit("3.14")`                     | `3.14`                                      |
| `StrLit("hello")`                    | `"hello"`                                   |
| `StructLit([("x", a), ("y", b)])`    | `{ x: a, y: b }`                            |
| `Call { name: "foo$Int", args }`     | `foo$Int(args)`                             |
| `BuiltinFunc::Map`                   | `mapFn(fn, iter)`                           |
| `Block { ..., returns_value: true }` | `(() => { ... return val; })()`             |
| `ForLoop { var, iter, body }`        | `for (let var; ; ) { ... iter.next() ... }` |

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

| Pass            | Recovery                                                            |
| --------------- | ------------------------------------------------------------------- |
| Scanner         | Skip bad characters; continue to next token                         |
| Parser          | Insert `ErrorExpr` sentinel; skip to next `;` or `}`                |
| Name resolution | For undefined names, create a synthetic "error symbol" and continue |
| Type inference  | On type mismatch, emit error but continue with a best-guess type    |
| Codegen         | On unrecognized IR node, emit `/* ERROR */` and continue            |

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
 ┌──────────┐
 │ Lowering │──── HIR (flat codegen IR)
 └──────────┘
     │
     ▼
 ┌──────────────────┐
 │ Monomorphization │──── HIR with descriptor params
 │ (dictionary pass)│     (HIR-to-HIR transform)
 └──────────────────┘
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

## 7. Remaining Work

### Traits: trait-associated variable routing (`T::bar`)

The `T::bar` syntax for trait-associated variables (e.g., `bar: Self` in a
trait definition) is not yet implemented. Currently, `T::hash(x)` (function
calls through traits) works, but standalone variable references like `T::bar`
are not routed through the descriptor. This requires a new HIR variant or
a mechanism for the monomorphizer to intercept `Ident` nodes from
trait-associated expressions.

### Traits: concrete type trait method calls (`Int::hash(1i)`)

Calling trait methods on concrete types (e.g., `Int::hash(1i)`) is not
yet implemented. The resolver would need to look up the concrete type's
impl blocks and route through the named impl constant (e.g., `$impl_Int_Hash`).
The machinery is in place (impl blocks are emitted as named constants), but
the resolver/inference path for concrete types is missing.

### Module system (partially implemented)

The module linker (`src/modules.rs`) exists but has some test failures.
Cross-module scope merging and cyclic dependency handling still need work.

### Tree-shaking (not yet implemented)

`src/tree_shake.rs` does not exist yet. Dead code elimination is still
on the roadmap.

### Codegen for some language features

Codegen for some language features like direct calls, builtin calls, and enums doesn't yet work 100% correctly.

---

## 8. Breaking changes

This is a list of language features that will be changed during the rewrite.
Anything not included in this list is intended to remain unchanged.

### Trait impls must appear in a special `impl`

As described earlier in this document, the current system of allowing trait-required
functions to be defined anywhere in the program has some downsides. We will change
this so that trait impls must appear in a special `impl` block. Example:

```gema
impl Vec2: Add {
    func add(a: Self, b: Self): Self {
        Vec2(a.x + b.x, a.y + b.y)
    }
}
```

### Rework of "type-associated" functions

The system for type-associated functions present in the TS implementation was extremely clunky. The new rules are these:

We now only use the `Type::` syntax in one of two cases:

1. As part of an enum instantation (not a change from the previous design)
2. When referring specifically to a function that is part of a trait definition -- we can no longer use this syntax for functions that are not part of trait definitions.

This means we can no longer do something like:

```gema
func Foo::bar() {
  Foo(1, 2, 3)
}
```

and if we see something like `Foo::bar`, and `Foo` is not an enum type, then we know `bar` must be a function associated with some trait that `Foo` satisfies. Furthermore, in this rework, the `Type::` syntax is _required_ when referring to functions that are part of trait definitions -- something like `T::foo()` says "look for `foo` in the traits implemented by `T`. Even when dealing with concrete types, as long as we're using a trait-defined function, we have to use this syntax.

In trait definitions, we no longer have things like:

```gema
trait HasZero {
  Self::zero[:Self]
}
```

Instead we would just do

```gema
trait HasZero {
  zero: Func[:Self]
}

# Example of implementation
impl Num: HasZero {
  func zero() {
    0
  }
}

# Then we could do:
Num::zero()  # == 0
```

### Traits can require variables (and trait requirement syntax slightly modified)

Traits can now require both functions and variables, like this:

```gema
trait Foo {
  bar: Func[Self: Self],
  baz: Self,
}

# Example implementation
# The impl block now functions basically like any other Block expression (though it has somewhat different rules -- it can only have assignments or func definitions)
impl Num: Foo {
  func bar(x: Num) { x + 1 }  # Note that `bar = \x: Num -> x + 1;` would also work here
  baz = 0;
}

# Example usage
Num::bar(Num::baz)  # == 1
```

### Lambda functions

Currently, we allow two types of anon function definitions.

- `func` syntax with type annotations: `func(x: Num) { x + 1 }`
- Backslash syntax with no type annotations: `\x { x + 1 }`

In the rewrite, we will support _only_ the backslash syntax (no `func` syntax), and we will have
type annotations for it be optional.

We will also slightly modify the syntax:

**Arrow syntax to separate params from body**

- Currently, any expression type can follow the function params, so something like `\x x + 1` is valid.
- In the rewrite, if the lambda body is not a block expression (enclosed in curly braces), it must be
  separated from the params by a `->` (which is a new token type). The `->` token is optional if the
  lambda body is a block expression.
- So the example given above would be written as `\x -> x + 1`.

**No parentheses around lambda params**

- Currently, if a lambda has more than one param, its params must be enclosed in parentheses.
- In the rewrite, we will not have parentheses around lambda params.
- So instead of `\(x, y) { ... }`, we will have `\x, y { ... }`.

Examples of things that are valid lambda functions in the new syntax:

```gema
\a { a + 1 }
\a -> a + 1
\a -> { a + 1 }
\a: Num { a + 1 }
\a: Num -> a + 1
\a, b { a + b }
\a, b -> a + b
\a: Str, b: Str -> a + b
\a -> { x = a + 1; x }
```

### Match expressions

Here, we have a similar change to the change to lambda function syntax. When the expression that follows the
match variant is not a block expression, it must be separated from the match result by a `->` token.

So in the previous verison, something like this is legal:

```gema
match x {
    variant1 2
    variant2 3
}
```

But in the new version, it must be written as:

```gema
match x {
    variant1 -> 2
    variant2 -> 3
}
```

or as the (already legal)

```gema
match x {
    variant1 { 2 }
    variant2 { 3 }
}
```

### JS interop

The syntax for JS interoperation changes slightly. We require a `!` token after the `use` keyword when importing JS functions and variables:

```gema
use!(foo: Func[Num: Num]) from "foo.js"
```

### Stricter requirements on semicolons and commas

In the previous version, the syntax rules were rather lax around when commas and semicolons were required. In the new version, we always require semicolons after non-terminal expressions in a block, and we always require commas between adjacent expressions/tokens in an array, tuple, or other list-like construct.

### Significant rework of type inference system

The rewrite implements a more thorough Hindley-Milner type inference system. See the [type inference spec](./docs/type-system.md) for details.

### `Null` type is replaced by `Void`

Expression that do not give values had type `Null` in the TS implementation. In the new implementation, this type is renamed to `Void`, to match the word use in other languages and avoid confusion with JS's `null` value.

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
testCompile("1 + 2", 3);
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
