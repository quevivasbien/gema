# gema

A statically-typed functional programming language that transpiles to JavaScript.

## Quick Start

```bash
bun install              # Install dependencies
bun build:frontend       # Bundle the web playground
bun run server.ts        # Start dev server on port 3000
```

Or use the static site directly: `open frontend/static-site/index.html` -- this will give you the same code sandbox that is hosted [here](https://quevivasbien.github.io/gema).

## Language Tour

### 1. Expressions and Values

Everything in Gema is an expression — every piece of code produces a value.

```gema
3.14            # Num (compiles to JS Number)
42i             # Int (compiles to JS BigInt)
"hello"         # Str
true            # Bool

# Blocks: the last expression is the return value
{ 1 + 2 }       # → 3

# Semicolons discard values
{ 1; }          # → null (the 1 is computed but discarded)
```

**Operators** follow standard precedence:

| Category   | Operators                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------- |
| Arithmetic | `+`, `-`, `*`, `/`, `%` (modulo), `//` (floor div), `%%` (euclidean mod), `^` (exponentiation) |
| Comparison | `==`, `!=`, `<`, `<=`, `>`, `>=`                                                               |
| Logical    | `and`, `or`                                                                                    |
| Unary      | `-` (negate), `!` (not)                                                                        |
| Range      | `..` (inclusive range)                                                                         |
| Pipe       | `\|` (forward pipe)                                                                            |
| Compound   | `+=`, `-=`, `*=`, `/=`, `%=`, `//=`, `%%=`, `^=`                                               |

### 2. Variables

```gema
x = 1;              # Immutable by default
x = 2;              # Compile error! Cannot reassign immutable

mut y = 1;          # Declare mutable with `mut`
y = y + 1;          # → 2 — reassignment allowed
y += 2;             # → 4 — compound assignment (+=, -=, *=, /=, %=, ^=)

# Mutable vars are captured by reference in closures
func makeCounter(): Func[:Int] {
    mut count = 0;
    func() { count = count + 1; count }
};
a = makeCounter();
a();  # 1
a();  # 2
```

### 3. Functions

```gema
# Named function with explicit types
func add(a: Num, b: Num): Num {
    a + b
};
add(3, 4)  # → 7

# Anonymous function (func syntax — requires type annotations)
f = func(x: Num, y: Num): Num { x + y };
f(10, 20)  # → 30

# Lambda syntax (backslash — types inferred from context)
map(\x { x + 1 }, [1, 2, 3])     # → iter of [2, 3, 4]
filter(\x { x > 2 }, [1, 2, 3, 4])  # → iter of [3, 4]
reduce(\(acc, x) { acc + x }, 0, [1, 2, 3])  # → 6

# Keyword arguments — args can be named in any order
func greet(name: Str, greeting: Str): Str {
    greeting + ", " + name + "!"
};
greet(greeting="Hello", name="Gema")  # → "Hello, Gema!"

# Functions can be passed as values
func apply(fn: Func[Num: Num], x: Num): Num { fn(x) };
apply(\x { x * 3 }, 5)  # → 15
```

### 4. Tuples

```gema
t = (1, "hello", 3.0);  # Tuple literal — groups values of different types
t(0)                    # → 1 — indexed access
Tup[Int, Str, Num]      # Type annotation syntax

# Nested tuples
nested = (1, (2, 3));
nested(1)(0)            # → 2

# Tuple unpacking
(a, b, c) = (10, 20, 30);
a + b + c               # → 60

# Mutable unpacking
(mut i, mut j) = (1, 2);
i = i + j;
i                       # → 3
```

### 5. Conditionals

```gema
# if/else is an expression — both branches must have the same type
x = 5;
label = if x > 0 { "positive" } else { "non-positive" };

# Chained else-if
score = 85;
grade = if score >= 90 {
    "A"
} else if score >= 80 {
    "B"
} else {
    "C"
};

# Without else — acts as a statement, returns null
if x > 0 {
    doSomething(x)
};
```

### 6. Loops and Control Flow

```gema
# break — exit a loop early
mut sum = 0;
for i = 1.. {
    if i > 10 { break };
    sum += i
};
sum  # → 55 (sum of 1..10)

# continue — skip to next iteration
mut evens = 0;
for i = 1..10 {
    if i % 2 == 0 { continue };
    evens += i
};
```

```gema
# For loop over a range
mut values = []:Int | trans;
for i = 1..5 {
    push(values, i * 10);
};
# values: 10, 20, 30, 40, 50

# For loop over an array
values = []:Int | trans;
for x in [10, 20, 30] {
    push(values, x + 1);
};
# values: 11, 21, 31

# break — exit a loop early
values = []:Int | trans;
for i = 1..10 {
    if i > 5 {
        break
    };
    push(values, i);
};
# values: 1, 2, 3, 4, 5

# continue — skip to next iteration
values = []:Int | trans;
for i = 1..10 {
    if i % 2 == 0 {
        continue
    };
    push(values, i);
};
# values: 1, 3, 5, 7, 9

# return — exit a function early (only valid inside functions)
func findFirstEven(xs: Arr[Int]): Int {
    for x in xs {
        if x % 2 == 0 {
            return x
        }
    };
    0
};
findFirstEven([1, 3, 4, 7])  # → 4
```

### 6. Arrays

```gema
arr = [1, 2, 3];        # Array literal
arr(0)                  # → 1 — indexed access
arr(1)                  # → 2

# Concatenation with +
[1, 2] + [3, 4]         # → [1, 2, 3, 4]

# Empty arrays need a type annotation
empty = []:Int;         # → Arr[Int]
```

### 6. Iterators and Functional Pipelines

Gema has first-class iterator combinators — all lazy, no intermediate arrays.

```gema
# Range: create an inclusive integer range
range(1, 5)             # iter of [1, 2, 3, 4, 5]
1..5                    # same, using .. syntax

# Pipe syntax: value | function
1..10 | filter(\x { x % 2 == 0 })
      | map(\x { x * x })
      | collect          # → [4, 16, 36, 64, 100]

# Iterator combinators
map(\x { x * 2 }, [1, 2, 3])                # transform
filter(\x { x > 2 }, [1, 2, 3, 4])          # filter
reduce(\acc, x { acc + x }, 0, [1, 2, 3])   # fold → 6
take(3, 1..)                                # first 3 of infinite range → [1, 2, 3]
drop(2, 1..5)                               # skip first 2 → [3, 4, 5]
takeWhile(\x { x < 4 }, 1..10)              # → [1, 2, 3]
dropWhile(\x { x < 4 }, 1..10)              # → [4, 5, 6, 7, 8, 9, 10]
iterate(\x { x * 2 }, 1)                    # infinite: 1, 2, 4, 8, ...
step(2, 1..10)                              # every 2nd → [1, 3, 5, 7, 9]
zip([1, 2, 3], ["a", "b", "c"])             # → iter of [(1,"a"), (2,"b"), (3,"c")]

# Collect: materialize an iterator into an array
collect(1..5)           # → [1, 2, 3, 4, 5]

# Array slicing with ranges
arr = [0, 10, 20, 30, 40];
arr(1..3)               # → [10, 20, 30] — slice from index 1 to 3 inclusive
arr(2..)                # → [20, 30, 40] — slice to end

# last / length — optimized for arrays
last([10, 20, 30])      # → 30
length([1, 2, 3])       # → 3
```

### 7. Structs

```gema
struct Point {
    x: Num,
    y: Num
};

# Constructor: Point(field1, field2, ...)
p = Point(3.0, 4.0);
p.x                     # → 3.0 — field access
p.y                     # → 4.0

# Mutable fields
struct MutablePoint {
    mut x: Num,
    mut y: Num
};
mp = MutablePoint(1.0, 2.0);
mp.x = 10.0;             # Field mutation
mp.y += 5.0;             # Compound field assignment
mp.x + mp.y              # → 15.0

# Operator overloading — define add/subtract/etc functions
struct Adder {
    val: Int
};
func add(a: Adder, b: Adder): Adder {
    Adder(a.val + b.val)
};
Adder(3) + Adder(4)      # → Adder(7)

# Nested structs and function composition
struct Pair { first: Int, second: Int }
func concat(a: Pair, b: Pair): Pair {
    Pair(concat(a.first, b.first), concat(a.second, b.second))
};
```

### 8. Enums

```gema
# Plain enum — numbered variants
enum Grade { a, b, c }
Grade.a    # → 0
Grade.b    # → 1

# Tagged enum — variants with associated values
enum Number {
    integer: Int,
    decimal: Num,
}
Number.integer(5i)    # → { $tag: 0, $val: 5n }
Number.decimal(3.14)  # → { $tag: 1, $val: 3.14 }

# Mixed enum — some variants tagged, some plain
enum OptionalInt {
    value: Num,
    missing
}
OptionalInt.value(42)  # → { $tag: 0, $val: 42 }
OptionalInt.missing    # → { $tag: 1, $val: null }
```

### 9. Match Expressions

```gema
# Match on a plain enum
match Grade.a {
    a { 100 },
    b { 200 },
    else { 0 }
}

# Match on a tagged enum — destructure the value
match Number.integer(5i) {
    integer(i) i,
    decimal(d) toInt(d)
}

# Match on Maybe type
opt = 1..3 | head;      # returns Maybe[Num]
match opt {
    some(v) { v * 2 },
    none { 0 }
}
```

### 10. Generics and Traits

```gema
# Traits define required function signatures
trait Comparable {
    eq[(a: Self, b: Self): Bool],
    lt[(a: Self, b: Self): Bool]
};

# Generic function with trait bound
func lte(a: T, b: T): Bool where T is Comparable {
    lt(a, b) or eq(a, b)
};

# Implement the trait for Num
func eq(a: Num, b: Num): Bool { a == b };
func lt(a: Num, b: Num): Bool { a < b };

lte(2, 3)   # → true
lte(3, 3)   # → true
lte(4, 3)   # → false

# Generic identity function
trait Any {}
func id(x: T): T where T is Any { x };
id(42)      # → 42
id("hello") # → "hello"

# Generic functions work with structs
struct Point { x: Num, y: Num };
p = Point(1, 2);
q = id(p);      # T = Point
q.x + q.y       # → 3

# Generic structs — type params in square brackets
struct Pair[T] { a: T, b: T }
Pair(1, 2)              # → Pair[Num]
Pair(1i, 2i)            # → Pair[Int]
p = Pair(10, 20);
p.a + p.b               # → 30

# Generic structs with multiple type params
struct Triple[T, U, V] { a: T, b: U, c: V }

# Nested generic structs
Pair(Pair(1, 2), Pair(3, 4))

# Generic structs in function params / return types
func first(p: Pair[T]): T where T is Any { p.a }

# Generic enums
enum Option[T] { some: T, nothing }
Option[Int].some(1i)     # → { $tag: 0, $val: 5n }
Option[Str].some("hi")

# Match on a generic enum variant
x = Option[Str].some("hello");
match x {
    some(v) { v },
    nothing { "empty" }
}

# Generic enums with multiple type params
enum Result[T, E] { value: T, error: E }
Result[Int, Str].value(42i)
Result[Int, Str].error("oops")
```

### 11. Tuples

```gema
# Tuple literals group values of different types
t = (1, "hello", 3.0);
t(0)            # → 1
t(1)            # → "hello"

# Nested tuples
nested = (1, (2, 3));
nested(1)(0)    # → 2

# Tuple unpacking
(a, b, c) = (10, 20, 30);
a + b + c       # → 60

# Mutable unpacking
(mut i, mut j) = (1, 2);
i = i + j;
i               # → 3

# Zip — combine multiple iterables
collect(zip([1, 2, 3], ["a", "b", "c"]))
# → [(1, "a"), (2, "b"), (3, "c")]
```

### 10. Dictionaries and Sets

```gema
# Dict — created from array of key-value tuples
d = Dict([("a", 1), ("b", 2)]);
d("a")          # → 1 (returns Maybe[Int])
d("x")          # → null (missing key)

# Mutable Dict
md = trans(Dict([("a", 1), ("b", 2)]));
put(md, "c", 3);
remove(md, "a");
d = detrans(md);

# Set
s = Set([1, 2, 3]);
contains(2, s)  # → true
union(Set([1,2]), Set([2,3]))       # → Set([1,2,3])
intersect(Set([1,2,3]), Set([2,3,4])) # → Set([2,3])

# Mutable Set
ms = trans(Set([1, 2, 3]));
push(ms, 4);
remove(ms, 1);
s = detrans(ms);
```

### 11. Mutable Arrays

```gema
# trans creates a mutable copy
mutarr = trans([1, 2, 3]);
push(mutarr, 4);       # append
put(mutarr, 0, 99);    # set element at index

# detrans freezes back to immutable
detrans(mutarr)        # → [99, 2, 3, 4]

# unsafeTrans shares the reference (no copy)
x = [1, 2, 3];
y = unsafeTrans(x);
put(y, 0, 99);
x                      # → [99, 2, 3] — original also modified

# After detrans, the mutable variable is consumed
d = detrans(mutarr);
# mutarr is no longer usable — compile error
```

### 12. Modules and JS Interop

```gema
# Import a gema module (all top-level definitions are exported)
use "math.gema"

# Selective import from a gema module
use (add, sub) from "utils.gema"

# Import symbols from a JavaScript module — type annotations required
use (
    double: Func[Num: Num],
    greet: Func[Str: Str],
) from "utils.js"

# Imported JS functions work naturally in gema code
5 | double      # → 10
greet("world") # → "Hello, world!"

# Multiple JS modules
use (PI: Num) from "constants.js"
use (log: Func[Str: Str]) from "logger.js"
```

JS imports generate proper ES module `import` statements. Type annotations are trusted as-is — this is an "unsafe" operation with no runtime verification.

### 13. For Loops

```gema
# Iterate over a range
for i = 1..5 {
    print(i)
};

# Iterate over an array
for x = [10, 20, 30] {
    print(x)
};

# break exits early
mut sum = 0;
for i = 1.. {
    if i > 10 { break };
    sum += i
};
sum  # → 55 (sum of 1..10)
```

### 14. Maybe Type

```gema
# Array/iterator/string indexing returns Maybe[T]
arr = [10, 20, 30];
arr(0)          # → Maybe[Num] (wraps the value)
arr(99)         # → Maybe[Num] (none — out of bounds)

# Maybe values must be explicitly handled before use
unwrap(0, arr(0))     # → 10 — unwrap with default
unwrap(arr(0))        # → 10 — unwrap without fallback (throws if none)
isnone(arr(99))       # → true

# head/last return Maybe
head(1..3)            # → Maybe[Num]
last([]:Int)          # → Maybe[Int] (none for empty)

# Unsafe call ! bypasses Maybe wrapping
arr!(0)               # → 10 (Int, not Maybe[Int]) -- out-of-bounds is UB
```

### 15. Type Conversions

```gema
toStr(42)       # → "42"
toInt(3.14)     # → 3
toNum(3i)        # → 3.0
toBool(1)       # → true
toBool(0)       # → false

msg = "gema";
msg(0)          # → "g" — string indexing (returns Maybe[Str])
msg!(0)         # → "g" — unsafe access
"hello"(1..3)   # → "ell" — string slicing
length("hello") # → 5
split(",", "a,b,c")   # → ["a", "b", "c"]
replace("old", "new", "hello old world")  # → "hello new world"
```

### 16. Type Annotations

Gema uses `:` for type annotations:

| Syntax                 | Meaning                        |
| ---------------------- | ------------------------------ |
| `Int`                  | BigInt                         |
| `Num`                  | Number                         |
| `Str`                  | String                         |
| `Bool`                 | Boolean                        |
| `Null`                 | No value                       |
| `Arr[Num]`             | Array of Num                   |
| `Iter[Num]`            | Lazy iterator of Num           |
| `MutArr[Num]`          | Mutable array of Num           |
| `Func[Num: Str]`       | Function: Num → Str            |
| `Func[Num, Str: Bool]` | Function: (Num, Str) → Bool    |
| `Tup[Num, Str, Bool]`  | Tuple of (Num, Str, Bool)      |
| `Dict[Str, Num]`       | Dict with Str keys, Num values |
| `MutDict[Str, Num]`    | Mutable dict                   |
| `Set[Num]`             | Immutable set of Num           |
| `MutSet[Num]`          | Mutable set of Num             |
| `Maybe[Num]`           | Optional Num (null or number)  |

## Project Structure

```
gema/
├── compile.ts            # CLI entry point for compiling .gema files
├── server.ts             # Dev server for the playground
├── src/
│   ├── compiler.ts       # Main compile() API (single-file and multi-file modes)
│   ├── scan.ts           # Lexer
│   ├── parse.ts          # Pratt parser
│   ├── tokens.ts         # Token types and keywords
│   ├── builtins.ts       # Runtime JS helpers (iterators, mutability)
│   ├── write-js.ts       # Code generator
│   ├── tree-shake.ts     # Dead-code elimination for unreachable definitions
│   └── ast/              # AST nodes and type checker
│       ├── index.ts      # Re-exports
│       ├── types.ts      # Type system (Type, FuncType, ArrayType, etc.)
│       ├── expression.ts # Base Expression class
│       ├── literals.ts   # Literal nodes
│       ├── operators.ts  # Unary/Binary operators
│       ├── nodes.ts      # Control flow, functions, variables, RangeIter, tuples
│       ├── calls.ts      # Call/DirectCall + builtin codegen
│       ├── caller.ts     # findCaller/findBuiltin dispatch
│       ├── set-parent-pointers.ts # Parent pointer assignment on AST
│       ├── structs.ts    # StructDef, ArrLit, FieldAccess, FieldAssignment
│       ├── traits.ts     # Trait node
│       ├── type-utils.ts # Type comparison utilities
│       └── reachability.ts  # Reachability analysis for tree-shaking
├── frontend/
│   ├── index.html         # Playground page
│   ├── styles.css         # Playground styling
│   ├── editor.js          # CodeMirror editor + presets
│   ├── editor-presets.js  # Example programs for the playground
│   ├── gema-language.js   # CodeMirror syntax highlighting for .gema
│   ├── get-worker.js      # Web worker for compilation
│   └── dist/
│       └── bundle.js      # Bundled frontend assets
├── tests/                 # Test suite (20 test files)
│   ├── helpers.ts
│   ├── basics.test.ts
│   ├── functions.test.ts
│   ├── structs.test.ts
│   ├── enums.test.ts
│   ├── generics-structs.test.ts
│   ├── generics-enums.test.ts
│   ├── modules.test.ts
│   ├── js-interop.test.ts
│   ├── control-flow.test.ts
│   ├── arrays.test.ts
│   ├── iterators.test.ts
│   ├── variables.test.ts
│   ├── tuples.test.ts
│   ├── strings.test.ts
│   ├── mutable-arrays.test.ts
│   ├── misc-data-structures.test.ts
│   ├── maybe.test.ts
│   ├── anon-functions.test.ts
│   ├── advanced.test.ts
│   └── sandbox.test.ts
└── benchmarks/           # Performance benchmarks
```

## Running Tests

```bash
bun test              # Run all tests
bun eslint            # Lint check
bun tsc               # Typescript check
bun run prettier . --write  # Format code
```
