# Roadmap for `gema` development

## Change tuple type signature from `Tuple[A, B, C, ...]` to `(A, B, C, ...)`

This one is pretty self-explanatory -- it would make it a bit less clunky to work with tuples or do things like creating an empty `Dict`.

## Tentative: remove `:` from type annotations.

The `:` that we have as part of our type annotations is not really needed--it's just an extra character to type. We could just have go-style type annotations like `func(a Int, b Float) Float { toFloat(a) + b }`

## Modules

We need to be able to create projects across multiple files. TBD what the best way to approach this is.

One potential way to do this is to continue to treat every file like a script that returns whatever the last expression is in the file, and module files just have their exported members listed at the end, something like

```gema
func exportedFunction(x: Int) { x + 1 }
struct ExportedStruct { x: Int, y: Int }
trait ExportedTrait { foo{Self: Int} }
exportedConstant = 11;

exports(exportedFunction, ExportedStruct, ExportedTrait, exportedConstant)
```

## IO

We need some form of IO capabilities. The form this takes really depends a lot on whether the language is intended to be executed purely with the browser or not.

## Error handling

I think my preferred way to do this would be to have a `Result` type, like in Rust. We could also have a `panic` builtin that aborts the program with an error message.

## JS Interoperability

It would be really helpful to be able to have bindings to JS modules or libraries. This could serve as an easy way to build out a good standard library for the language.

## Tentative: Enums

It might be nice to have enums, maybe similar to how it is handled in Rust.

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

## Return and continue keywords

These would be helpful to avoid deeply nested control flow.

## Misc improvements and bug fixes

Don't require param types when referencing functions in a context where it's inferable (e.g. in map).

range index syntax needs to work for iterators (can maybe get rid of take and drop syntax), probably should also add tail iterator

Add naked for loop (equivalent to while true)

Make dicts and sets from iterators; conversely, make iterators from dicts and sets

Tentative: Cartesian product iterator, permutations iterator, combinations iterator

Both put and push should return the value, not the data structure that the value was added to

.. syntax for ranges should not continue into a curly brace block (most relevant in context of for loop)

## Optimizations

When transing an expression that is not a variable, there is no need for a copy (it can be a no-op, behaving exactly like unsafeTrans);

We can completely omit branches of the AST that do not operate on pre-existing mutable variables (or have other side effects) and are dropped.

Optimizations for StepIterator: can be made more efficient when stepping over ranges or arrays.

Small gain: if iterators are dropped, they don't need to reset.

When chaining some operations, there are some efficiency improvements to be made. For example, arr1 + arr2 + arr3 would probably be more efficiently compiled as `[...arr1, ...arr2, ...arr3]` instead of `arr1.concat(arr2).concat(arr3)`.

For loops on ranges could be made more efficient if iterated var is not actually used.

Blocks that contain only a single expression can usually be brought up into the enclosing block.

Lots of other room for improvement here.

## More helpful error messages. There are still lots of cases where we emit very opaque error messages.

Maybe the best way to chase these down is to just generate a bunch of slightly misformed code and examine the error messages.
