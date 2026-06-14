# gema

A statically-typed functional programming language that transpiles to JavaScript.

## Quick Start

```bash
bun install              # Install dependencies
bun build:frontend   # Bundle the web playground
bun run server.ts        # Start dev server on port 3000
```

Or use the static site directly: `open frontend/static-site/index.html` -- this will give you the same code sandbox that is hosted [here](https://quevivasbien.github.io/gema).

## Language Tour

### 1. Expressions and Values

Everything in Gema is an expression — every piece of code produces a value.

```gema
42              # Integer (compiles to JS BigInt)
3.14            # Float (compiles to JS Number)
"hello"         # String
true            # Boolean

# Blocks: the last expression is the return value
{ 1 + 2 }       # → 3

# Semicolons discard values
{ 1; }          # → null (the 1 is computed but discarded)
```

**Operators** follow standard precedence:

| Category   | Operators                                              |
| ---------- | ------------------------------------------------------ |
| Arithmetic | `+`, `-`, `*`, `/`, `%` (modulo), `^` (exponentiation) |
| Comparison | `==`, `!=`, `<`, `<=`, `>`, `>=`                       |
| Logical    | `and`, `or`                                            |
| Unary      | `-` (negate), `!` (not)                                |
| Range      | `..` (inclusive range)                                 |
| Pipe       | `\|` (forward pipe)                                    |

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
func add(a: Int, b: Int): Int {
    a + b
};
add(3, 4)  # → 7

# Anonymous function (func syntax — requires type annotations)
f = func(x: Int, y: Int): Int { x + y };
f(10, 20)  # → 30

# Lambda syntax (backslash — types inferred from context)
map(\x { x + 1 }, [1, 2, 3])     # → iter of [2, 3, 4]
filter(\x { x > 2 }, [1, 2, 3, 4])  # → iter of [3, 4]
reduce(\acc, x { acc + x }, 0, [1, 2, 3])  # → 6

# Keyword arguments — args can be named in any order
func greet(name: Str, greeting: Str): Str {
    greeting + ", " + name + "!"
};
greet(greeting="Hello", name="Gema")  # → "Hello, Gema!"

# Functions can be passed as values
func apply(fn: Func[Int: Int], x: Int): Int { fn(x) };
apply(\x { x * 3 }, 5)  # → 15
```

### 4. Conditionals

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

### 5. Arrays

```gema
arr = [1, 2, 3];        # Array literal
arr(0)                  # → 1 — indexed access
arr(1)                  # → 2

# Multi-dimensional
matrix = [[1, 2], [3, 4]];
matrix(0, 1)            # → 2

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
..5                     # from 0 to 5

# Pipe syntax: value | function
1..10 | filter(\x { x % 2 == 0 })
      | map(\x { x * x })
      | collect          # → [4, 16, 36, 64, 100]

# Iterator combinators
map(\x { x * 2 }, [1, 2, 3])           # transform
filter(\x { x > 2 }, [1, 2, 3, 4])     # filter
reduce(\acc, x { acc + x }, 0, [1, 2, 3])   # fold → 6
take(3, 1..)                             # first 3 of infinite range → [1, 2, 3]
drop(2, 1..5)                            # skip first 2 → [3, 4, 5]
takeWhile(\x { x < 4 }, 1..10)           # → [1, 2, 3]
dropWhile(\x { x < 4 }, 1..10)           # → [4, 5, 6, 7, 8, 9, 10]
iterate(\x { x * 2 }, 1)                 # infinite: 1, 2, 4, 8, ...
step(1..10, 2)                           # every 2nd → [1, 3, 5, 7, 9]
zip([1, 2, 3], ["a", "b", "c"])          # → iter of [(1,"a"), (2,"b"), (3,"c")]

# Collect: materialize an iterator into an array
collect(1..5)           # → [1, 2, 3, 4, 5]

# Array slicing with ranges
arr = [0, 10, 20, 30, 40];
arr(1..3)               # → [10, 20, 30] — slice from index 1 to 3 inclusive
arr(2..)                # → [20, 30, 40] — slice to end
arr(..2)                # → [0, 10, 20]  — slice from start
arr(..)                 # → copy of entire array

# last / length — optimized for arrays
last([10, 20, 30])      # → 30
length([1, 2, 3])       # → 3
```

### 7. Structs

```gema
struct Point {
    x: Float,
    y: Float
};

# Constructor: Point(field1, field2, ...)
p = Point(3.0, 4.0);
p.x                     # → 3.0 — field access
p.y                     # → 4.0

# Mutable fields
struct MutablePoint {
    mut x: Float,
    mut y: Float
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

### 8. Generics and Traits

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

# Implement the trait for Int
func eq(a: Int, b: Int): Bool { a == b };
func lt(a: Int, b: Int): Bool { a < b };

lte(2, 3)   # → true
lte(3, 3)   # → true
lte(4, 3)   # → false

# Generic identity function
trait Any {}
func id(x: T): T where T is Any { x };
id(42)      # → 42
id("hello") # → "hello"

# Generic functions work with structs
struct Point { x: Int, y: Int };
p = Point(1, 2);
q = id(p);      # T = Point
q.x + q.y       # → 3
```

### 9. Tuples

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
d("x")          # → undefined (missing key)

# Mutable Dict
md = trans(Dict([("a", 1), ("b", 2)]));
put(md, "c", 3);
remove(md, "a");
d = detrans(md);

# Set
s = Set([1, 2, 3]);
contains(s, 2)  # → true
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

### 12. For Loops

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

### 13. Type Conversions

```gema
toStr(42)       # → "42"
toInt(3.14)     # → 3
toFloat(3)      # → 3.0
toBool(1)       # → true
toBool(0)       # → false

msg = "gema";
msg(0)          # → "g" — string indexing
```

### 14. Type Annotations

Gema uses `:` for type annotations:

| Syntax                  | Meaning                          |
| ----------------------- | -------------------------------- |
| `Int`                   | BigInt                           |
| `Float`                 | Number                           |
| `Str`                   | String                           |
| `Bool`                  | Boolean                          |
| `Null`                  | null/undefined                   |
| `Arr[Int]`              | Array of Int                     |
| `Iter[Int]`             | Lazy iterator of Int             |
| `MutArr[Int]`           | Mutable array of Int             |
| `Func[Int: Str]`        | Function: Int → Str              |
| `Func[Int, Str: Bool]`  | Function: (Int, Str) → Bool      |
| `Tuple[Int, Str, Bool]` | Tuple of (Int, Str, Bool)        |
| `Dict[Str, Int]`        | Dict with Str keys, Int values   |
| `MutDict[Str, Int]`     | Mutable dict                     |
| `Set[Int]`              | Immutable set of Int             |
| `MutSet[Int]`           | Mutable set of Int               |
| `Maybe[Int]`            | Optional Int (undefined allowed) |

## Project Structure

```
gema/
├── index.ts              # Public API (compile, compileWithRawErrors)
├── server.ts             # Dev server for the playground
├── src/
│   ├── scan.ts           # Lexer
│   ├── parse.ts          # Pratt parser
│   ├── tokens.ts         # Token types and keywords
│   ├── types.ts          # Type system (Type, FuncType, ArrayType, etc.)
│   ├── builtins.ts       # Runtime JS helpers (iterators, mutability)
│   ├── deep-equals.ts    # Structural type equality (browser-compatible)
│   ├── write-js.ts       # Code generator
│   └── ast/              # AST nodes and type checker
│       ├── index.ts      # Re-exports
│       ├── expression.ts # Base Expression class
│       ├── literals.ts   # Literal nodes
│       ├── operators.ts  # Unary/Binary operators
│       ├── nodes.ts      # Control flow, functions, variables, RangeIter, tuples
│       ├── calls.ts      # Call/DirectCall + builtin codegen
│       ├── caller.ts     # findCaller/findBuiltin dispatch
│       ├── structs.ts    # StructDef, ArrLit, FieldAccess, FieldAssignment
│       ├── traits.ts     # Trait node
│       ├── registries.ts # Global registries (struct, trait, function, monomorphized)
│       ├── type-utils.ts # Type comparison utilities
│       └── caller-utils.ts # Monomorphization helpers
├── frontend/
│   ├── index.html        # Playground page
│   ├── styles.css         # Playground styling
│   ├── editor.js          # CodeMirror editor + presets
│   ├── compiler.js        # Browser compiler wrapper
│   ├── gema-language.js   # CodeMirror language support
│   └── dist/              # Built bundles
│       └── static-site/   # Self-contained static site deployment
├── tests/                 # Test suite (300+ tests)
└── benchmarks/            # Performance benchmarks
```

## Running Tests

```bash
bun test              # Run all tests
bun eslint            # Lint check
bun tsc               # Typescript check
bun run prettier . --write  # Format code
```
