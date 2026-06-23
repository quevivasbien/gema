# Roadmap for `gema` development

## IO

We need some form of IO capabilities. The form this takes really depends a lot on whether the language is intended to be executed purely with the browser or not.

## Explicit creation and improved handling of Maybe type

We should allow users to explicitly create these instead of just having them as the result of indexing operations.

Example of proposed syntax:

```gema
func retainIfEven(x: Int): Maybe[Int] {
  if x % 2 == 0 {
    some(x)   # This is just a no-op in JS -- the Maybe type exists purely as a type-checking construct to check for the presence of `undefined` values
  } else {
    none:Int  # Requires a new `none` keyword, also uses the same type annotation that we have in use currently for empty lists; otherwise "none" on its own would have an ambiguous type
  }
}
```

It would be helpful to have a new matching syntax:

```gema
func sumMaybes(iter: Iter[Maybe[Int]]) {
  reduce(
    \(acc, x) {
      match x {
        some(value) value,  # syntax is some(<var>) <expression that can use var> -- {} is optional around the expression
        none 0,  # syntax is <none> <expression>
      }
    },
    0,
    iter
  )
}
```

this example would be functionally equivalent to the currently possible

```gema
func sumMaybes(iter: Iter[Maybe[Int]]) {
  reduce(
    \(acc, x) {
      if isnone(x) {
        0
      } else {
        unwrap(value)
      }
    },
    0,
    iter
  )
}
```

(but would compile slightly differently, since the latter has an unnecessary check for `undefined` on the `unwrap`).

(When we implement enums later, we can reuse this match syntax there.)

## Error handling

I think my preferred way to do this would be to have a `Result` type, like in Rust. We could also have a `panic` builtin that aborts the program with an error message.

## JS Interoperability

It would be really helpful to be able to have bindings to JS modules or libraries. This could serve as an easy way to build out a good standard library for the language.

## 64-bit ndarray types based on JS's TypedArray

TBD

## Tentative: list comprehensions

List comprehensions are helpful as a succinct map + zip + filter. Could be nice to have.

## Stdlib

This needs to wait until after we have the ability to import JS code and/or import other modules, but we should have some sort of standard library of helpful, optimized functions beyond those built in to the language

## Builtin traits

Maybe should wait until once we have some sort of Stdlib, but it would be nice to have standard traits like

```gema
trait Summable {
  add[(a: Self, b: Self): Self],
}
```

which would be a formalization of how operator overloading already works, but could also be useful in other cases. E.g., users could create functions like

```gema
func sumFrom(iter: Iter[T], start: T) where T is Summable {
  reduce(\(acc, x) { acc + x }, start, iter)
}
```

As an extension to this, it could also be useful to allow traits to require functions that don't require any `Self` arguments. The syntax could be something like

```gema
trait Summable {
  add[(a: Self, b: Self): Self],
  Self.zero[:Self]
}

func sum(iter: T) where T is Summable {
  reduce(\(acc, x) { acc + x }, T.zero(), iter)
}

# Example implementation:
struct S { s: Int }

func sum(a: S, b: S) {
  S(a.s + b.s)
}

func S.zero() {
  S(0)
}

# Then we can do
sum([S(1), S(2), S(3)])
```

## Tentative: allow structs to have generic fields

Something like:

```gema
struct S[T] where T is Foo {
  a: T,
  b: T
}
```

## Enums

Enum syntax is:

```gema
enum Grade {
  a,
  b,
  c
}

grade = Grade.a;
```

In JS, this sort of enum would compile to just a number (i.e., `Grade.a` would be represented as 0, `Grade.b` would be represented as 1, and so on).

Enums can also be tagged unions:

```gema
enum Number {
  integer: Int,
  decimal: Float,
}

num = Number.integer(1);
```

In JS, this would be represented as a JS object with a `$tag` field:

```
Number.integer(1) -> { "$tag": 0, "$val": 1n }
Number.decimal(1.0) -> { "$tag": 1, "$val": 1 }
```

In the future, it would be nice to allow enums to be parameterized by generic types, but we'll leave this out of the MVP:

```gema
enum Result[T, E] {
  value: T,
  error: E
}

res = Result[Int, Str].value(1);  # Ideally, we would have a way to avoid the clunky syntax required to make it clear what all the generic types should be.
```

Not all variants must have contents:

```gema
enum OptionalInt {
  value: Int,
  missing
}

a = OptionalInt.value(1);
b = OptionalInt.missing;
```

If at least one variant has contents, we need to represent the enum in the tagged object format:

```
OptionalInt.value(1) -> { "$tag": 0, "$val": 1n }
OptionalInt.missing -> { "$tag": 1, "$val": null }
```

For now, we are supporting only one value per tag, but in the future we might support something like this:

```gema
enum Shape {
  circle: { radius: Float },
  rectangle: { width: Float, height: Float }
}

# For now, the way to do something like this would be:
struct Circle { radius: Float }
struct Rectangle { width: Float, height: Float }
enum Shape {
  circle: Circle,
  rectangle: Rectangle,
}
```

We will have a match statement syntax to help deal with the different enum variants:

```gema
enum Number {
  integer: Int,
  decimal: Float,
}

func toInt(n: Number): Int {
  match n {
    integer(i) i,  // mimics the match syntax we already have in place for the Maybe type
    decimal(d) toInt(d),
  }  # Match statement has value of whatever path we go down
}

func square(n: Number): Number {
  match n {
    integer(i) Number.integer(i * i),
    decimal(d) Number.decimal(d * d),
  }
}

enum OptionalInt {
  value: Int,
  missing
}

func unwrapOptional(oi: OptionalInt, fallback: Int) {
  match oi {
    value(i) { i },
    missing { fallback }
  }
}
```

This would be handled via JS switch statements.

If match statements do not match all the possible values, they automatically have type Null. Match statements can include an `else` clause to catch any other possible values (acts as the default switch fallthrough).

```gema
enum Grade { a, b, c }

g = Grade.a;
score = match g {
  a { 100 },
  else { 50 }
};

# This is not legal, since we can't assign a variable to a Null value
sklore = match g {
  a { 100 }
};
```

## Tentative: remove `:` from type annotations.

The `:` that we have as part of our type annotations is not really needed--it's just an extra character to type. We could just have go-style type annotations like `func(a Int, b Float) Float { toFloat(a) + b }`

## Misc improvements and bug fixes

Don't require param types when referencing functions in a context where it's inferable (e.g. in map).

Go back to allowing generic types in functions to not specify a trait bound.

Fix weird error message when trying to compile an empty program: "Error in main.gema at line 1, column 1: can't access property "line", Z is undefined"

if/else exprs should not require {}

Make sure all the builtins follow the `f(<func>, <values>..., <container>)` idiom so they are easily chainable.

range index syntax needs to work for iterators (can maybe get rid of take and drop syntax), probably should also add tail iterator -- on second thought here, the `take` and `drop` ops are better suited to functional semantics, and a tail operation would be rather expensive. If users really do want to take the tail of an iterator, they can collect the iterator or use something like

```gema
trait Any {}

func tail(n: Int, iter: Iter[T]) where T is Any {
    mut arr_out = []:T;
    for i = iter {
        if length(arr_out) < n {
            arr_out += [i];
        } else {
            arr_out = arr_out(1..) + [i];
        }
    }
    toIter(arr_out)
}

tail(3, 1..10)  # result is 8, 9, 10
```

## Scoped TypeEnv

Replace the remaining ancestors parameter with a TypeEnv scope object that maintains a symbol table. Variable.cascadeTypes becomes a simple env.lookup instead of walking up the tree and scanning siblings. Eliminates Assignment.findDefiningAssignment(), findOuterDefinition(), findStructTypedVariable(), findStringTypedVariable(), and all sibling-scanning code.

Complication: Call's keyword-arg reordering digs through ancestor blocks for function definitions — this needs careful design to port to TypeEnv.

## Optimizations

When transing an expression that is not a variable, there is no need for a copy (it can be a no-op, behaving exactly like unsafeTrans); (revisiting this later, it might actually be quite complicated to ensure that something is safe not to copy--variables aren't the only case that could cause problems--so maybe this should be kept until later -- this is not actually a super important optimization, since it usually won't matter, and users can use `unsafeTrans` in cases where it does)

We can completely omit branches of the AST that do not operate on pre-existing mutable variables (or have other side effects) and are dropped.

Relatively easy win: Block expressions that contain only a single expression do not need to be wrapped in an IIFE.

Optimizations for StepIterator: can be made more efficient when stepping over ranges or arrays.

Small gain: if iterators are dropped, they don't need to reset.

Small improvement for for loops: When we use for loops where the iterator is just a range iterator, it should be possible to just compile this to something like (let i = start; i !== stop; i += step) instead of having to create and check a new iterator object.

When chaining some operations, there are some efficiency improvements to be made. For example, arr1 + arr2 + arr3 would probably be more efficiently compiled as `[...arr1, ...arr2, ...arr3]` instead of `arr1.concat(arr2).concat(arr3)`.

Lots of other room for improvement here.

## More helpful error messages. There are still lots of cases where we emit very opaque error messages.

Maybe the best way to chase these down is to just generate a bunch of slightly misformed code and examine the error messages.

Example: if a user creates a recursive function, the function must have an annotated return type. Currently, if users don't annotate the return type, the error messages produced will be very misleading.
