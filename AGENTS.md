# Gema — AI Agent Guide (Rust Rewrite)

Gema is a statically-typed programming language that transpiles to
JavaScript.  This is the **Rust rewrite** of the compiler.  See
[`ROADMAP-RUST-REWRITE.md`](./ROADMAP-RUST-REWRITE.md) for the full
architecture plan and implementation phases.

**GitHub:** https://github.com/quevivasbien/gema

---

## Quick Start

```bash
cargo build              # Build the compiler library
cargo test               # Run all Rust tests
cargo test -- --nocapture # Show stdout/stderr from tests
cargo doc --open         # Build and open API docs
cargo clippy             # Lint check
```

The TypeScript implementation is still available in `ts/` for
cross-validation during the migration:

```bash
cd ts && bun test        # Run the TS test suite (ground truth)
cd ts && bun run compile.ts input.gema  # Compile a file with the old compiler
```

---

## Compilation Pipeline

```
Source  ──scan──►  Tokens  ──parse──►  AST  ──resolve──►  Named AST
    │                                                     │
    │                  ┌─── monomorphize ───┐              │
    │                  ▼                    ▼              │
    │            Generic HIR          Concrete HIR         │
    │                  │                    │              │
    ▼                  ▼                    ▼              │
JS String  ◄──codegen──┴─────── HIR ◄──lower ──────────────┘
```

Each phase is a pure function — no mutable shared state between
passes.  Diagnostics are accumulated in a `DiagnosticsBag` threaded
through the pipeline.

### Module ownership

| Module | Phase | Purpose |
|--------|-------|---------|
| `source.rs` | I | `SourceText`, `Span`, `SourceMap` (line/col lookup) |
| `diagnostics.rs` | I | `Diagnostic`, `Severity`, `DiagnosticsBag` |
| `token.rs` | I | `TokenKind`, `Token` |
| `scan.rs` | I | Scanner / lexer |
| `ast.rs` | I | AST enum + `AstArena` |
| `arena.rs` | I | Arena allocator for AST nodes |
| `parse.rs` | I | Pratt parser |
| `types.rs` | II | Interned type system (`TypeKind`, `TypeId`, `TypeArena`) |
| `symbol.rs` | II | `Symbol`, `SymbolTable`, `ScopeTree` |
| `resolve.rs` | II | Name resolution pass |
| `infer.rs` | II | Type inference |
| `monomorphize.rs` | II | Generic instantiation |
| `builtins.rs` | II | Builtin function signatures |
| `traits.rs` | II | Trait resolution (`impl` lookup) |
| `lower.rs` | III | AST → HIR lowering |
| `hir.rs` | III | Codegen IR types |
| `codegen.rs` | III | HIR → JavaScript string |
| `modules.rs` | III | Module graph and linking |
| `tree_shake.rs` | III | Dead code elimination |

---

## Key Design Principles

### 1. Immutable AST + arena

AST nodes are stored in arenas and referenced by `NodeId` (a `Copy`
`u32` index).  Analysis results (types, resolved names, etc.) go into
**separate side tables** (`HashMap<NodeId, TypeId>`,
`HashMap<NodeId, SymbolId>`, etc.), not onto the nodes themselves.

```rust
// DO: side table
let types: HashMap<NodeId, TypeId>;

// DON'T: mutable field on the node
// node.type = Some(...);
```

### 2. Diagnostics, not exceptions

Every pass takes a `&mut DiagnosticsBag` and pushes errors into it
instead of throwing/panicking.  Error-recovery sentinel nodes
(`ErrorExpr`, `TokenKind::Error`) allow subsequent passes to
continue and collect more errors.

```rust
// DO:
fn resolve_names(
    arena: &AstArena,
    root: NodeId,
    diagnostics: &mut DiagnosticsBag,
) -> ScopeTree { ... }

// DON'T: panic on user error
// fn resolve_names(...) -> ScopeTree { panic!("undefined variable") }
```

### 3. Separate passes

Each phase in the pipeline is a distinct pass.  Do not merge concerns:

- **Name resolution** unconditionally resolves every identifier to a
  symbol — no type information needed.
- **Type inference** assumes every name is already resolved.
- **Monomorphization** runs after type inference, not during it.
- **Codegen** operates on a fully monomorphized HIR, not the original
  AST.

### 4. Minimal dependencies

The compiler should build quickly and have few external dependencies.
Current approved dependencies:

| Crate | Purpose | When added |
|-------|---------|------------|
| `id-arena` | Arena allocation for AST nodes | Phase I |
| `rustc-hash` | Fast `FxHashMap` / `FxHashSet` | Phase II |
| `codespan-reporting` | Beautiful diagnostics output | Phase III (or III) |

Do not add dependencies without discussion.

---

## Coding Conventions

### Naming

- Types: `PascalCase` — `SourceText`, `TokenKind`, `DiagnosticsBag`
- Functions and methods: `snake_case` — `scan()`, `make_token()`
- Enum variants: `PascalCase` — `TokenKind::PlusEqual`
- Modules: `snake_case` — `source.rs`, `diagnostics.rs`
- Error types: append `Error` or `Diagnostic` — `ParseError`,
  `Diagnostic`
- Type parameters: short uppercase — `T`, `E`, `A`

### Error messages

Error messages should be **clear, actionable, and consistent**:

```rust
// Good:
"cannot add values of type `Str` and `Int`"

// Avoid:
"type mismatch"
```

When possible, include the offending value and the expected type.

### Spans

Use `Span` (byte-offset pairs) everywhere for source positions.
Compute line/col only when displaying diagnostics via `SourceMap`.

```rust
// DO:
fn parse_expr(tokens: &[Token], span: Span) -> NodeId;

// DON'T: pass line/col separately
// fn parse_expr(tokens: &[Token], line: usize, col: usize);
```

### Testing

- Unit tests go in the same file as the code they test, inside a
  `#[cfg(test)] mod tests { ... }` block.
- Integration tests go in `tests/`.
- Every scan/parse/resolve/infer function should have a test for:
  - Normal case (happy path)
  - Edge case (empty input, extreme values)
  - Error case (invalid input, expected diagnostic)
- Use the TS test suite in `ts/tests/` as ground truth when migrating
  features.  For any source program, the Rust compiler should produce
  the same output (or a strictly better error message), unless we are
  intentionally changing part of the language design, in which case
  should check with the user first.
- Prefer `assert_eq!` and `assert!(matches!(...))` over manual
  boolean assertions for better failure output.

### Comments

- Document public API items with doc comments (`///`).
- Use `//` for internal comments — explain *why*, not *what*.
- Use `// ── Section headers ──` sparingly, only for major
  groupings within a file.
- Do not leave TODO comments without a brief explanation of what's
  missing and why.

---

## Common Patterns

### Pattern: Pass that transforms the AST

```rust
pub fn do_something(
    arena: &AstArena,
    root: NodeId,
    diagnostics: &mut DiagnosticsBag,
) -> HashMap<NodeId, SomeResult> {
    let mut result = HashMap::new();
    do_something_recursive(arena, root, &mut result, diagnostics);
    result
}

fn do_something_recursive(
    arena: &AstArena,
    node: NodeId,
    result: &mut HashMap<NodeId, SomeResult>,
    diagnostics: &mut DiagnosticsBag,
) {
    // process node...
    for child in children_of(arena, node) {
        do_something_recursive(arena, child, result, diagnostics);
    }
}
```

### Pattern: Walking the AST with a stack

```rust
pub fn walk_ast<F>(arena: &AstArena, root: NodeId, mut f: F)
where
    F: FnMut(&AstArena, NodeId),
{
    let mut stack = vec![root];
    while let Some(node) = stack.pop() {
        f(arena, node);
        // push children...
    }
}
```

---

## Cross-Validation with the TypeScript Compiler

The TypeScript implementation in `ts/` serves as the reference during
migration.  Use it to verify correctness:

1. Write a Gema source program.
2. Compile it with the TS compiler: `cd ts && bun run compile.ts
   program.gema`
3. Compile the same program with the Rust compiler.
4. Compare the output — it should be semantically equivalent.

When adding new features, add tests to both the Rust test suite and
(if applicable) the TS test suite to maintain parity until the
migration is complete. We should not make substantial changes to the
language design during the re-write process, without first consulting
the user.
