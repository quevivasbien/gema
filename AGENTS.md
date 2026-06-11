# Gema — AI Agent Guide

Gema is a small, statically-typed programming language that transpiles to JavaScript, built with TypeScript on the [Bun](https://bun.sh) runtime.

## Quick Start

```bash
bun install              # Install dependencies
bun test                 # Run all tests (Bun's built-in test runner)
bun run build:frontend   # Bundle the web playground
bun run server.ts        # Start dev server on port 3000
```

## Project Structure

```
index.ts              # Public API: compile(), compileWithRawErrors()
server.ts             # Bun HTTP server — serves frontend + POST /run
src/
├── tokens.ts         # TokenType enum, Token interface
├── scan.ts           # Lexer — text → Token[]
├── parse.ts          # Pratt parser — Token[] → AST + errors
├── ast.ts            # ~2700 lines — AST nodes, type checker, registries
├── write-js.ts       # Codegen — AST → JavaScript string
├── types.ts          # Type system: FuncType, ArrayType, IterType, CustomType
└── builtins.ts       # JS runtime helpers (iterators, modulo, etc.)
tests/
├── compile.test.ts   # E2E tests: parse → compile → eval → check result
└── parse.test.ts     # Parser + type-checker tests
frontend/
├── editor.js         # CodeMirror 6 editor (entry point for bundle)
├── index.html        # Web playground page
├── styles.css        # Dark-theme styles
└── dist/bundle.js    # Built bundle (run `bun run build:frontend` to rebuild)
```

## Compilation Pipeline

`scan()` → `parse()` → `cascadeTypes()` → `writeJS()`

- **scan** ([`src/scan.ts`](src/scan.ts)): Lexes source text into `Token[]`. Handles `#` comments.
- **parse** ([`src/parse.ts`](src/parse.ts)): Pratt parser with precedence climbing. Produces AST + `ASTError[]`.
- **type-check** ([`src/ast.ts`](src/ast.ts)): `cascadeTypes()` walks the AST top-down, resolving each node's type. Generic functions are monomorphized on demand.
- **codegen** ([`src/write-js.ts`](src/write-js.ts)): `writeJS()` produces a JavaScript string. Builtin runtime functions (iterators, etc.) are injected if needed.

## Key Conventions

- **`import type`** is required for type-only imports (`verbatimModuleSyntax: true`).
- **`deepEquals()`** from `bun` is used for structural type comparison — not `===`.
- **Global registries** (`structRegistry`, `traitRegistry`, `functionRegistry`, `monomorphizedCache`) are module-level singletons in `src/ast.ts`. Call `resetRegistries()` between independent compilations.
- **Semicolons discard values**: `{ 1 }` returns `1`, but `{ 1; }` returns `null` (creates a `DropValue` node).
- **`if` requires `else`**: There is no standalone `if` — every `if` must have an `else` branch.
- **Empty arrays must be annotated**: Write `[]: Arr[Int]`, not `[]`.
- **Names conflicting with JS reserved words** (`const`, `let`, `return`, etc.) get auto-prefixed with `_gema_`.

## Testing Patterns

Tests use Bun's built-in test runner (`bun:test`). Two test files in [`tests/`](tests/):

- [`tests/parse.test.ts`](tests/parse.test.ts) exports `testParse(text)` and `testParseExpectError(text)` helpers.
- [`tests/compile.test.ts`](tests/compile.test.ts) uses a local `testCompile(text, expectedResult)` helper.
- Always create new tests before adding a new language feature.
- You need to reset registries between tests; otherwise tests can pollute each others' registries.
- If you suspect that a test is not passing because the test itself has a mistake in it, let the user know.
- If you add or modify tests for any reason, always have the user review your changes to the tests before making further changes to the codebase.

## Important Gotchas

- **`findCaller()`** (in `src/ast.ts`) is the central name resolution function — it handles struct constructors, function dispatch, generics via monomorphization, variable-based callables, type conversions, and trait dispatch. Changes here affect everything.
- **Generic functions** (`typeParams.length > 0`) skip body type-checking until monomorphization. They're stored as templates, not registered in `functionRegistry`.
- **`Self` type** is represented as both the string `"Self"` and `CustomType("Self")` in different code paths — be careful when adding trait-related code.
- **Experimental features** (marked `test.todo`): repeated iterator reads, nested generic types, generic struct fields.

## Contribution guidelines
- Run eslint (e.g. `bun run eslint`) before finalizing changes. Do your best to comply with its suggestions.
- Run Prettier formatter (e.g. `bun run prettier . --write`) when finalizing any changes.
- If you add notable new syntax or other features to the language, you can update the `README.md` and the code examples in the frontend sandbox to showcase the new language features.
