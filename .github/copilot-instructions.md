# Gema — AI Agent Guide

Gema is a statically-typed programming language that transpiles to JavaScript, built with TypeScript on the [Bun](https://bun.sh) runtime.

## Quick Start

```bash
bun install              # Install dependencies
bun test                 # Run all tests (Bun's built-in test runner)
bun run build:frontend   # Bundle the web playground
```

## Compilation Pipeline

`scan()` → `parse()` → `cascadeTypes()` → `writeJS()`

- **compiler** ([`src/compiler.ts`](src/compiler.ts)): Orchestrates compilation, including scanning, parsing, type-checking, and code-gen.
- **scan** ([`src/scan.ts`](src/scan.ts)): Lexes source text into `Token[]`. Handles `#` comments.
- **parse** ([`src/parse.ts`](src/parse.ts)): Pratt parser with precedence climbing. Produces AST + `ASTError[]`.
- **type-check** ([`src/ast.ts`](src/ast/*)): `cascadeTypes()` walks the AST top-down, resolving each node's type. Generic functions are monomorphized on demand.
- **codegen** ([`src/write-js.ts`](src/write-js.ts)): `writeJS()` produces a JavaScript string. Builtin runtime functions (iterators, etc.) are injected if needed.

## Testing Patterns

- Tests use Bun's built-in test runner (`bun:test`). Test files are in [`tests/`](tests/).
- Always create new tests before adding a new language feature.
- If you suspect that a test is not passing because the test itself has a mistake in it, let the user know.
- If you add or modify tests for any reason, ALWAYS have the user review your changes to the tests before making further changes to the codebase.

If you need to dig into the generated tokens / AST / compiled JS for a test case, you can use a command like this to create and execute a test file within the project directory (do not create such tests outside the project directory):

```bash
cat > ./test_foo.js << 'ENDSCRIPT'
import { compile } from "./src/compiler";
const text = `
func foo(x: Int) { x }
foo(1)
`;
const compiled = compile(text);
console.log("Compiled:\n", compiled);
if (compiled.errors.length === 0) {
  const result = eval(compiled.js);
  console.log("Result:", result);
}
ENDSCRIPT
bun run ./test_foo.js
```

Note that above example shows only the compiled JS, runtime result, and any compilation errors, but if you want to dig into the scanned tokens or generated AST, you could use a similar script that calls the scanning and parsing code directly. Be sure to delete any test files you create this way once you are done debugging.

## Contribution guidelines

- Run eslint (e.g. `bun run eslint`) and tsc (`bun tsc`) before finalizing changes. Do your best to comply with its suggestions. DO NOT use eslint-ignore without verifying it's okay with the user.
- Run Prettier formatter (e.g. `bun run prettier . --write`) when finalizing any changes.
- If you add notable new syntax or other features to the language, you can update the `README.md` and the code examples in the frontend sandbox to showcase the new language features.
- Be conservative about adding new builtins to the BUILTINS in `src/builtins.ts`. If you can reasonably implement a new builtin operation inline instead of creating a new function, you should do that.
