# Gema — AI Agent Guide

Gema is a small, statically-typed programming language that transpiles to JavaScript, built with TypeScript on the [Bun](https://bun.sh) runtime.

## Quick Start

```bash
bun install              # Install dependencies
bun test                 # Run all tests (Bun's built-in test runner)
bun run build:frontend   # Bundle the web playground
bun run server.ts        # Start dev server on port 3000
```

## Compilation Pipeline

`scan()` → `parse()` → `cascadeTypes()` → `writeJS()`

- **scan** ([`src/scan.ts`](src/scan.ts)): Lexes source text into `Token[]`. Handles `#` comments.
- **parse** ([`src/parse.ts`](src/parse.ts)): Pratt parser with precedence climbing. Produces AST + `ASTError[]`.
- **type-check** ([`src/ast.ts`](src/ast/*)): `cascadeTypes()` walks the AST top-down, resolving each node's type. Generic functions are monomorphized on demand.
- **codegen** ([`src/write-js.ts`](src/write-js.ts)): `writeJS()` produces a JavaScript string. Builtin runtime functions (iterators, etc.) are injected if needed.

## Key Conventions

- **`deepEquals()`** is used for structural type comparison — not `===`.
- **Global registries** (`structRegistry`, `traitRegistry`, `functionRegistry`, `monomorphizedCache`, `consumedVars`) are controlled in `src/ast/registries.ts`. Call `resetRegistries()` between independent compilations.
- **Semicolons discard values**: `{ 1 }` returns `1`, but `{ 1; }` returns `null` (creates a `DropValue` node).
- **Empty arrays must be annotated**: Write `[]: Int` (for an array of integers), not just `[]`.
- **Names conflicting with JS reserved words** (`const`, `let`, `return`, etc.) get auto-prefixed with `_gema_`.

## Testing Patterns

- Tests use Bun's built-in test runner (`bun:test`). Test files are in [`tests/`](tests/).
- Always create new tests before adding a new language feature.
- If you suspect that a test is not passing because the test itself has a mistake in it, let the user know.
- If you add or modify tests for any reason, ALWAYS have the user review your changes to the tests before making further changes to the codebase.

## Contribution guidelines

- Run eslint (e.g. `bun run eslint`) and tsc (`bun tsc`) before finalizing changes. Do your best to comply with its suggestions. DO NOT use eslint-ignore without verifying it's okay with the user.
- Run Prettier formatter (e.g. `bun run prettier . --write`) when finalizing any changes.
- If you add notable new syntax or other features to the language, you can update the `README.md` and the code examples in the frontend sandbox to showcase the new language features.
