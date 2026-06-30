# Gema — AI Agent Guide

Gema is a statically-typed programming language that transpiles to JavaScript, built with TypeScript on the [Bun](https://bun.sh) runtime. Review the README.md file in the root directory if you want an overview of the language syntax and features.

## Quick Start

```bash
bun install              # Install dependencies
bun test                 # Run all tests (Bun's built-in test runner)
bun run build:frontend   # Bundle the web playground
bun run prettier . --write  # Format code
bun run eslint           # Lint check
bun tsc                  # TypeScript check
```

## Compilation Pipeline

`scan()` → `parse()` → `cascadeTypes()` → `writeJS()`

- **compiler** ([`src/compiler.ts`](../src/compiler.ts)): Orchestrates compilation, including scanning, parsing, type-checking, and code-gen. Supports both single-file and multi-file modes. JS module files (`.js`, `.mjs`) are excluded from the scan step and handled at runtime via ES module imports.

- **scan** ([`src/scan.ts`](../src/scan.ts)): Lexes source text into `Token[]`. Handles `#` comments. Integer literals use `i` suffix (e.g., `42i` → BigInt). Plain decimal-less numbers without `i` are `Num` (Number).

- **parse** ([`src/parse.ts`](../src/parse.ts)): Pratt parser with precedence climbing. Produces AST + `ASTError[]`. Key parse methods:
    - `structDef()` — parses struct defs, including generic params `struct Pair[T] { ... }`
    - `parseEnum()` — parses enum defs, including generic params `enum Option[T] { ... }`
    - `parseUse()` — parses module imports and JS interop imports `use (fn: Type) from "path"`
    - `getTypeName()` / `getTemplateTypes()` — parse type annotations and template args `[Int, Str]`

- **type-check** ([`src/ast/`](../src/ast/)): `cascadeTypes()` walks the AST top-down, resolving each node's type. Generic functions and generic structs/enums are monomorphized on demand.

- **codegen** ([`src/write-js.ts`](../src/write-js.ts)): `writeJS()` produces a JavaScript string. Builtin runtime functions (iterators, mutable ops, etc.) are injected if needed. JS module imports are collected during cascadeTypes and emitted as `import` statements at the top level.

## AST Node Types

| Node                  | File            | Purpose                                                                                                                 |
| --------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `Expression`          | `expression.ts` | Base class for all AST nodes                                                                                            |
| `Block`               | `expression.ts` | Sequence of expressions; last expr is value. Has `jsImports` for collecting JS module imports from `UseJSModule` nodes. |
| `Literal`             | `literals.ts`   | Int, Num, Str, Bool, Null literals                                                                                      |
| `Binary` / `Unary`    | `operators.ts`  | Binary and unary operators                                                                                              |
| `Variable`            | `nodes.ts`      | Variable/type references; carries `templateTypes` for `Arr[Int]`, `Result[Int, Str]`, etc.                              |
| `FunctionDef`         | `nodes.ts`      | Named function definition; supports generics via `typeParams` + `monomorphize()`                                        |
| `AnonymousFunction`   | `nodes.ts`      | Lambda/func expression with optional inferred param types                                                               |
| `Call` / `DirectCall` | `calls.ts`      | Named function calls and direct callee calls                                                                            |
| `StructDef`           | `structs.ts`    | Struct definition; supports generics via `typeParams` + `monomorphize()`                                                |
| `EnumDef`             | `enums.ts`      | Enum definition; supports generics via `typeParams` + `monomorphize()`                                                  |
| `FieldAccess`         | `structs.ts`    | Field access (`obj.field`) and enum variant access                                                                      |
| `UseModule`           | `nodes.ts`      | Gema module import (`use "path.gema"`)                                                                                  |
| `UseJSModule`         | `nodes.ts`      | JS module import (`use (fn: Type) from "path.js"`)                                                                      |
| `Match`               | `enums.ts`      | Match expression for enums and Maybe types                                                                              |
| `RangeIter`           | `nodes.ts`      | Range literal `a..b`                                                                                                    |
| `TupleLit`            | `nodes.ts`      | Tuple literal `(a, b, c)`                                                                                               |

## Type System

Types are defined in `src/ast/types.ts`:

- **Primitives**: `"Int" | "Num" | "Str" | "Bool" | "Null" | "Self"` (string literals)
- **Compound**: `FuncType`, `ArrayType`, `IterType`, `MutArrType`, `TupleType`, `DictType`, `MutDictType`, `SetType`, `MutSetType`, `MaybeType`, `EnumType`
- **CustomType**: User-defined types (structs, trait references, type params like `T`). Carries optional `templateArgs` for generic type references (e.g., `Pair[Int]` → `CustomType("Pair", [], [Int])`).
- **`substituteTypeParams(type, bindings)`**: Replaces type params with concrete types throughout a type tree. Handles `templateArgs` on `CustomType`.
- **`collectCustomTypeNames(type, names)`**: Collects all `CustomType` names from a type tree (recurses into `templateArgs`).
- **`typeEquals(a, b)`**: Structural comparison of types. Compares `templateArgs` for `CustomType`.
- **`extractBindingsFromParams(params, argTypes, typeParams, bindings)`**: Infers type param bindings by matching parameter types against argument types. Handles `CustomType` with `templateArgs`.

## Monomorphization

Generic functions, structs, and enums use a consistent monomorphization pattern:

1. **Generic definitions** are stored in scope with `isGeneric: true`, `typeParams: string[]`, and `def` referencing the AST node.
2. **On concrete usage**, `monomorphize(concreteTypes)` is called which:
    - Creates bindings from type params to concrete types (via `extractBindingsFromParams` or direct mapping)
    - Calls `substituteTypeParams` on all relevant types
    - Returns concrete field/variant/param types
3. **Monomorphized versions** are registered in scope before the generic entry via `defineVariableBefore()` for functions.
4. **Generic struct/enum** monomorphization doesn't register in scope — it computes concrete types inline.

## Generic Functions

- Defined with `func name(x: T): T where T is Any { ... }`
- `where T is TraitName` clause is **required** to register `T` as a type parameter
- `trait Any {}` is the universal trait bound
- `monomorphize()` infers type bindings from call argument types
- Monomorphized versions are cached in `monomorphizedVersions[]`

## Generic Structs

```gema
struct Pair[T] { a: T, b: T }
```

- Type params in square brackets after the struct name
- `where` clauses are NOT supported for structs
- Type params are inferred from constructor arguments: `Pair(1, 2)` → `T = Num`
- Field access on monomorphized instances substitutes the concrete types

## Generic Enums

```gema
enum Option[T] { some: T, nothing }
enum Result[T, E] { value: T, error: E }
```

- Type params in square brackets after the enum name
- Explicit type params required for construction: `Option[Int].some(1i)`
- Full match support on generic enum variants
- `FieldAccess.cascadeTypes()` uses the concrete `EnumType` from the object's type directly (not scope lookup)

## JS Interop

```gema
use (add: Func[Num, Num: Num], PI: Num) from "math.js"
```

- Parser: `parseUse()` detects `.js`/`.mjs` extension, creates `UseJSModule` node with typed symbol list
- Type-check: `UseJSModule.cascadeTypes()` registers symbols as variables in enclosing scope and records imports on the top-level `Block.jsImports`
- Codegen: `JSWriter.compile()` emits `import` statements at the top level, adding `./` prefix to bare paths

## Key types in the scope system

From `src/ast/scope.ts`:

```ts
type VariableAttributes =
  | { class: "var"; name: string; type: Type; isMutable: boolean; isConsumed: boolean }
  | { class: "func"; name: string; type: FuncType; isGeneric: boolean; fullName: string; def?: FunctionDef; paramNames?: string[] }
  | { class: "struct"; name: string; fields: [...]; isGeneric?: true; typeParams?: string[]; def?: StructDef }
  | { class: "enum"; name: string; variants: [...]; isGeneric?: true; typeParams?: string[]; def?: EnumDef }
  | { class: "trait"; name: string; requiredFunctions: [...] }
```

## Testing Patterns

- Tests use Bun's built-in test runner (`bun:test`). Test files are in `tests/`.
- Always create new tests before adding a new language feature.
- If you suspect that a test is not passing because the test itself has a mistake in it, let the user know.
- If you add or modify tests for any reason, ALWAYS have the user review your changes to the tests before making further changes to the codebase.

### Test helpers (from `tests/helpers.ts`)

| Function                                          | Purpose                          |
| ------------------------------------------------- | -------------------------------- |
| `testCompile(text, expectEqual)`                  | Compile + eval, assert result    |
| `testCompileMulti(files, entry, expectEqual)`     | Multi-file compile + eval        |
| `testCompileMultiExpectError(files, entry, msg?)` | Multi-file compile, assert error |
| `testParse(text)`                                 | Parse, assert no errors          |
| `testParseExpectError(text, msg?)`                | Parse, assert error              |
| `testCompileAndCheck(text, includes, excludes)`   | Compile, check JS output strings |

Be aware that the built-in tests should run quite quickly. If they don't complete with a timeout of just a few seconds, there is probably an infinite loop somewhere.

If you need to dig into the generated tokens / AST / compiled JS for a test case, you can use a command like this to create and execute a test file within the project directory (_do not create such tests outside the project directory_):

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

Be sure to delete any test files you create this way once you are done debugging.

## Contribution guidelines

- Run eslint (`bun run eslint`) and tsc (`bun tsc`) before finalizing changes. Do your best to comply with its suggestions. DO NOT use eslint-ignore without verifying it's okay with the user.
- Run Prettier formatter (`bun run prettier . --write`) when finalizing any changes.
- If you add notable new syntax or other features to the language, update the `README.md` and the code examples in `frontend/editor-presets.js` to showcase the new language features.
- Be conservative about adding new builtins to the `BUILTINS` in `src/builtins.ts`. If you can reasonably implement a new builtin operation inline instead of creating a new function, you should do that.
