# Roadmap for `gema` development

## IO

We need some form of IO capabilities. The form this takes really depends a lot on whether the language is intended to be executed purely with the browser or not.

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

## Tentative: Enums

It might be nice to have enums, maybe implemented as tagged unions/sum types.

## Tentative: remove `:` from type annotations.

The `:` that we have as part of our type annotations is not really needed--it's just an extra character to type. We could just have go-style type annotations like `func(a Int, b Float) Float { toFloat(a) + b }`

## Misc improvements and bug fixes

Don't require param types when referencing functions in a context where it's inferable (e.g. in map).

Cleanup: type conversions shouldn't be handled separately from builtins.

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

Optimizations for StepIterator: can be made more efficient when stepping over ranges or arrays.

Small gain: if iterators are dropped, they don't need to reset.

Small improvement for for loops: When we use for loops where the iterator is just a range iterator, it should be possible to just compile this to something like (let i = start; i !== stop; i += step) instead of having to create and check a new iterator object.

When chaining some operations, there are some efficiency improvements to be made. For example, arr1 + arr2 + arr3 would probably be more efficiently compiled as `[...arr1, ...arr2, ...arr3]` instead of `arr1.concat(arr2).concat(arr3)`.

For loops on ranges could be made more efficient if iterated var is not actually used.

Lots of other room for improvement here.

## More helpful error messages. There are still lots of cases where we emit very opaque error messages.

Maybe the best way to chase these down is to just generate a bunch of slightly misformed code and examine the error messages.

Example: if a user creates a recursive function, the function must have an annotated return type. Currently, if users don't annotate the return type, the error messages produced will be very misleading.
