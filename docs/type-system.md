# Gema Type System

This document describes the type system that the Rust rewrite of Gema
implements. It covers the kinds of types, annotation syntax, inference
rules, and edge cases.

---

## 1. Internal Type Representation

**This section describes how types are represented inside the compiler.**
The Gema language syntax for these types is shown in the "Syntax" column;
the "TypeKind" column is the internal enum variant used by the compiler.

Gema has a fixed set of built-in type constructors and user-defined types
(structs, enums). Every type is interned in a `TypeArena` and identified
by a `TypeId` (a `Copy` `u32` index). Structurally identical types share
the same `TypeId` (hash consing).

### Primitives

| Syntax | TypeKind | Description                   | JS target             |
| ------ | -------- | ----------------------------- | --------------------- |
| `Int`  | `Int`    | Big integer                   | `BigInt`              |
| `Num`  | `Num`    | Floating-point                | `Number`              |
| `Str`  | `Str`    | String                        | `String`              |
| `Bool` | `Bool`   | Boolean                       | `Boolean`             |
| `Void` | `Void`   | Void / bottom type — no value | No JS output (erased) |

`Void` is Gema's bottom type. It is the type of expressions that do not
produce a value (e.g. a bare `return;`). It is distinct from `Maybe[T]`,
which produces JS's `null` at runtime. When a `Void`-typed expression
appears in a context that expects a value, it unifies with any type.

### Built-in compound types

| Syntax                   | TypeKind                           | Description               |
| ------------------------ | ---------------------------------- | ------------------------- |
| `Arr[T]`                 | `Arr(T)`                           | Immutable array           |
| `MutArr[T]`              | `MutArr(T)`                        | Mutable array             |
| `Iter[T]`                | `Iter(T)`                          | Lazy iterator             |
| `Set[T]`                 | `Set(T)`                           | Immutable set             |
| `MutSet[T]`              | `MutSet(T)`                        | Mutable set               |
| `Dict[K, V]`             | `Dict(K, V)`                       | Immutable dictionary      |
| `MutDict[K, V]`          | `MutDict(K, V)`                    | Mutable dictionary        |
| `Tup[T1, T2, ...]`       | `Tuple([T1, T2, ...])`             | Fixed-length tuple        |
| `Maybe[T]`               | `Maybe(T)`                         | Optional value (nullable) |
| `Func[P1, P2, ...: Ret]` | `Func { params: [...], ret: Ret }` | Function type             |

### User-defined types

| Syntax                       | TypeKind                |
| ---------------------------- | ----------------------- |
| Type name with optional args | `Custom { name, args }` |

```gema
Pair[Int, Str]      # Custom { name: "Pair", args: [Int, Str] }
Point               # Custom { name: "Point", args: [] }
```

### Generic type parameters

| Syntax                      | TypeKind                   |
| --------------------------- | -------------------------- |
| `T` in `func [T] foo(x: T)` | `Generic { name, bounds }` |

A type variable that will be substituted with a concrete type during
monomorphization. `bounds` are trait names that the concrete type must
satisfy.

### Special types

| TypeKind               | Meaning                              |
| ---------------------- | ------------------------------------ |
| `SelfType`             | `Self` in trait/impl contexts        |
| `InferVar { id: u32 }` | Unknown type — solved by unification |
| `Unknown`              | Error recovery sentinel              |

---

## 2. Type Annotations

Type annotations follow the name being annotated, separated by `:`:

```gema
x: Maybe[Int] = none       # variable declaration with type
func add(a: Num, b: Num): Num { a + b }  # param and return types
struct Point { x: Num, y: Num }          # field types
```

The annotation can be any type expression:

```gema
a: Int
b: Num
c: Str
d: Bool
e: Arr[Int]
f: Func[Int, Num: Bool]
g: Maybe[Str]
h: Dict[Str, Int]
i: Tup[Int, Str, Bool]
```

The `Func` type uses a colon to separate param types from the return type:

```gema
# Func[<params>: <return>]
f: Func[Int, Num: Bool]
```

Generic compound types use bracket notation with comma-separated args:

```gema
# Dict[<key>, <val>]
d: Dict[Str, Arr[Int]]
```

---

## 3. Variables

Variables are declared with the `name = value` syntax. An optional type
annotation and mutability flag can be added:

```gema
x = 5                      # immutable, type inferred from value
y: Num = 3.14              # immutable with explicit type
mut z = 0                  # mutable, type inferred
mut w: Int = 0             # mutable with explicit type
```

When a type annotation is present, the value's type is unified with the
annotation during inference. A mismatch produces a type error.

For the detailed rules on reassignment, shadowing, and the `mut` keyword,
see [`variables.md`](variables.md).

---

## 4. Functions

### Named functions

Named functions require type annotations on all parameters. The return
type annotation is optional — if omitted, it is inferred from the body:

```gema
func add(a: Num, b: Num): Num { a + b }   # explicit return type
func add(a: Num, b: Num) { a + b }         # inferred return type (Num)
```

### Anonymous functions

Anonymous functions (lambdas) support full type inference for both
parameters and return type. Type annotations on lambda parameters are
optional:

```gema
\a, b { a + b }              # both params inferred
\x: Num, y: Num { x + y }    # explicit param types
\x -> x + 1                  # arrow syntax, no block
```

When a lambda is passed to a function like `map`, the inference engine
uses the function's expected param types to fill in the lambda's params:

```gema
map(\x { x + 1 }, [1, 2, 3])   # x: Int inferred from the array
```

### Generic functions

Generic functions are declared with type parameter brackets before the
name. Type parameters can have optional trait bounds:

```gema
func [T] identity(x: T): T { x }
func [T: Hash + Eq] dedup(arr: Arr[T]): Arr[T] { ... }
```

At a call site, the type argument is inferred from the argument types.
Explicit type arguments are supported but rarely needed:

```gema
identity(42)                 # infers T = Int
identity("hello")            # infers T = Str
identity[Num](3.14)          # explicit — also valid
```

The same applies to struct construction and enum variant construction:

```gema
Pair(1, "hello")             # infers Pair[Int, Str]
Pair[Int, Str](1, "hello")   # explicit — also valid

Option::some(42)             # infers Option[Int]
Option[Int]::some(42)        # explicit — also valid
```

---

## 5. Structs

Structs are defined with named fields, each annotated with a type:

```gema
struct Point { x: Num, y: Num }
struct Pair[T] { a: T, b: T }
```

Construction uses positional arguments matching field order:

```gema
Point(3.14, 2.72)
Pair(1, "hello")             # Pair[Int, Str] — both inferred from args
```

Generic struct type arguments are inferred from the argument types
whenever possible. If the context provides additional constraints (e.g.
a type annotation on the variable the value is assigned to), those are
also used. Explicit template arguments (like `Pair[Int, Str](1, "hello")`)
are never required at the call site.

---

## 6. Enums

Enums have named variants, optionally carrying data:

```gema
enum Option[T] { some: T, nothing }
enum Result[T, E] { value: T, error: E }
enum Color { red, green, blue }
```

Variant construction uses the `::` syntax:

```gema
Option::some(42)             # Option[Int] — T inferred from argument
Result::value(1)             # Result[Int, ?E] — E inferred from context
Result::error("msg")         # Result[?T, Str] — T inferred from context
Color::red                   # plain variant, no data
```

The inference engine uses the enum's variant type signature as a
constraint. If some type parameters remain unresolved after the argument
is checked, they are constrained by the surrounding context (e.g., a type
annotation on the receiving variable, or a pattern match).

Pattern matching destructs enum values and binds the inner data:

```gema
match x {
    some(v) -> v,
    nothing -> 0,        # binds nothing variant
    else -> -1           # else arm is the catch-all
}
```

Each match arm's variant name is resolved through the enum type of the
scrutinee. The binding variable in the arm (e.g., `v`) gets its type
from the variant's data type.

---

## 7. Traits and Impl Blocks

Traits define a set of requirements (function signatures and variable
declarations) that a type can satisfy:

```gema
trait HasZero {
    zero: Func[Self: Self],
}
trait Eq {
    equal: Func[Self, Self: Bool],
}
```

Traits can also require variable declarations in addition to functions:

```gema
trait Named {
    name: Func[Self: Str],
    default_name: Str,
}

impl Person: Named {
    func name(p: Person): Str { p.first_name + " " + p.last_name }
    default_name = "Unknown";
}
```

Explicit impl blocks connect a type to a trait:

```gema
impl Int: HasZero {
    func zero(): Int { 0 }
}
impl Num: HasZero {
    func zero(): Num { 0.0 }
}
```

Inside an impl block, `Self` resolves to the implementing type. Type
inference for impl functions works the same as for free functions.

---

## 8. Inference Algorithm

Type inference uses **Hindley-Milner unification** (Algorithm M / bottom-up
constraint generation with top-down context propagation).

### How it works

1. Each expression is assigned a fresh type variable (`InferVar`).
2. Constraints are generated based on how the expression is used:
   - `x = y` generates `typeof(x) = typeof(y)`
   - `x + y` generates `typeof(x) = Int`, `typeof(y) = Int`,
     `typeof(x + y) = Int`
   - `f(arg)` generates `typeof(f) = Func[typeof(arg): typeof(f(arg))]`
3. Constraints are **unified**: two types become the same type via
   substitution. If a conflict is found (e.g., `Int = Str`), an error is
   reported.
4. After all constraints are solved, any remaining `InferVar` that was
   never constrained is reported as "ambiguous type" (or defaults to a
   suitable type depending on the context).

### What is inferred

| Expression        | Inference                                                 |
| ----------------- | --------------------------------------------------------- |
| `42`              | Type is always `Int`                                      |
| `x = 5`           | `x` gets type `Int` from the value                        |
| `x: Num = 5`      | `5` is unified with `Num` — no error                      |
| `f(arg)`          | `f` must be a function type; arg types are constrained    |
| `\x { x + 1 }`    | `x` gets a fresh variable; `x + 1` constrains it to `Int` |
| `none`            | Gets a fresh `InferVar` unified with the expected type    |
| `[1, 2, 3]`       | Element type is `Int`; result is `Arr[Int]`               |
| `match x { ... }` | Scrutinee type determines variant types; arms must unify  |

### What requires explicit annotations

| Construct              | Why                                                                |
| ---------------------- | ------------------------------------------------------------------ |
| Named function params  | Explicit boundary; necessary for recursion and overload resolution |
| Struct field types     | Struct definitions are nominal — type must be recorded             |
| Generic enum type args | Required when the context cannot resolve all type params           |

Type inference is a separate pass that runs after name resolution. It
produces a `HashMap<NodeId, TypeId>` mapping every expression to its
type.
