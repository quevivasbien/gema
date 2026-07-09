# Roadmap for `gema` development

### Outstanding bugs with reworked caller dispatch:

```gema
func [T] foo(x: T) {
    func bar(y: T) {
        y
    }
    bar(x)
}

foo(1)
# fails with error `function bar[T[[]]: unknown] not found`
```

## IO

We should have some form of IO capabilities. The form this takes really depends a lot on whether the language is intended to be executed purely with the browser or not.

## Error handling

I think my preferred way to do this would be to have a `Result` type, like in Rust. We could also have a `panic` builtin that aborts the program with an error message.

## 64-bit ndarray types based on JS's TypedArray

This could be implemented as a JS extension to the language, maybe doesn't need to be built-in.

## Stdlib

This needs to wait until after we have the ability to import JS code and/or import other modules, but we should have some sort of standard library of helpful, optimized functions beyond those built in to the language.

If we do this along with good JS interoperability, we probably could dump a lot of the functions that are currently built into the compiler.

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

## Metaprogramming

It could be cool to support some simple template metaprogramming.

### Potential future extension

We could have some sort of intelligent type inference where if you do something like call `Arr.empty` and it doesn't find any such function defined for an un-templated `Arr`, it will match to the first templated `Arr[T].empty` (or generally speaking, `Arr[T, U, ...].empty`) that it finds and try to use that.

For example, if I call `Arr.zeros(3)` it will start by finding a function with a signature like `func Arr.zeros(_: Int) { ... }` and it it doesn't find that it will try to use the first `func Arr[...].zeros(_: Int) { ... }` that it finds.

As an extension to this, it could also be useful to

## Misc improvements and bug fixes

### Tentative: Tail-call optimization for if / else branching. Currently, this will use TCO:

```gema
func f(n: Int, res: Int): Int {
    if n <= 0 { return res };
    f(n - 1, res + n)
};
```

but this will not:

```gema
func f(n: Int, res: Int): Int {
    if n <= 0 { res }
    else { f(n - 1, res + n) }
};
```

Maybe the most straightforward way to support this and any other deep recursion case is to detect any other case where we have a recursive function (beside the easily TCO-optimized case we already support) and use trampoline functions in these cases.

This is maybe not a huge priority, since usually the iterate iterator is a better way to solve this sort of problem, anyway.

### Others

- Separate more things from the giant `nodes.ts` file

- Don't require param types when referencing functions in a context where it's inferable (e.g. in map).

- Allow lambdas not just in builtin functions -- if there is a function that _could_ match, we take that match (will need to think through the details here more).

- When resolving callers, keep track of the closest match so far, so this can be reported in the error message if no match is found.

- Fix weird error message when trying to compile an empty program: "Error in main.gema at line 1, column 1: can't access property "line", Z is undefined"

- if/else exprs should not require {} -- or, places where {} is not currently required (like lambdas and matches) _should_ -- we just ought to be consistent

- Allow underscores in numeric literals

- Do not allow functions to take arguments of type null. Something like this should not compile: `func foo(x: Null) {1;} foo({1;}); 1`

- Nodes should have their module names in addition to their lines and cols, set during parsing instead of as a post-parsing step

- Return does not seem to work inside an anonymous function defined within another function (it tries to return out of the outer function)

- Related to previous point, it could be good to have a shorthand for the `toIter` conversion. Should probably also have a shorthand for the `collect` builtin (maybe `toArr` should also work for that purpose or should replace `collect`)? We would bring back the `@` symbol for collection (but treat it as a special function name) and maybe introduce another special name for `toIter` (if we do this, top candidates would be either `*` or `~`).

- We could often figure out the type of un-annotated empty arrays or `none`s from context.

- Fix layouts forced before content fully loaded in frontend

- Only allow integer literals for accessing tuples.

- Generic functions defined in a different module won't correctly capture variables if monomorphized from another module. The easiest way to avoid this would probably just be to prohibit generics from capturing variables, but that would be a bit awkward... Maybe there's a way to give the original definition a unique name that won't clash with anything else, make sure it's not removed by tree-shaking, and reference the original definition in the monomorphized version.

- Allow traits to have Self in a nested position, like `trait Foo { foo[(a: Arr[Self]): Maybe[Self]] }`

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

## Tentative items

### Allow structs to have generic fields

Something like:

```gema
struct S[T] where T is Foo {
  a: T,
  b: T
}
```

### Struct fields that are the same type as the struct itself

This would enable nested data structures like linked lists and trees

Something like:

```gema
struct Node {
  data: Num,
  next: Maybe[Self],
}

struct LinkedList {
  head: Maybe[Node],
}
```

### Structs, traits, enums, and (non-anonymous) functions can be declared out of order

This would require a substantial adjustment to how name resolution and type checking works, but it could be a convenient feature, and it would also allow for types to reference each other in a circular way, like

```gema
struct Edge {
  cost: Num,
  destination: Node,
}

struct Node {
  edges: Arr[Edge],
}
```

### Very tentative: templated traits?

This seems like probably too far down the rabbit hole...

### Improvements to enums

In the future, it might be nice to allow enums to be parameterized by generic types:

```gema
enum Result[T, E] {
  value: T,
  error: E
}

res = Result[Int, Str].value(1);  # Ideally, we could figure out a way to avoid the clunky syntax required to make it clear what all the generic types should be.
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

## Remove `:` from type annotations.

The `:` that we have as part of our type annotations is not really needed--it's just an extra character to type. We could just have go-style type annotations like `func(a Int, b Float) Float { toFloat(a) + b }`

## Tentative: list comprehensions

List comprehensions are helpful as a succinct map + zip + filter. Could be nice to have.
