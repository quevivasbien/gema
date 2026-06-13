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

## Tentative: Enums

It might be nice to have enums, maybe similar to how it is handled in Rust.

## Proper handling of null/undefined values.

### Nulls

It's possible to get null values with things like `x = { 1; };`. We probably should try to disallow these patterns (it's okay to have statements that aren't expressions, but being able to assign variables to them makes little sense). Right now it's not intended to be able to return a null value from a function, but it is technically possible, and it could make sense to do so given that we now support mutable variables (so we could have functions that are just meant to mutate something).

Here are the rules I would like to enforce:

- It should never be possible to set a variable equal to a null value
- Non-anonymous function declarations, struct and trait definitions are all technically null, so we shouldn't be able to assign variables to them (I think this might already be the case, but let's check).

### `undefined` values

It is possible to get `undefined` values if we do out of bounds array or iterator access or try to use an empty iterator. This is not possible to prohibit at compile time.

The fix I want here is to have a built-in `Maybe` type. `Maybe[Int]` would just mean a value that compiles to either a `BigInt` or `undefined`, and the `Maybe` syntax would just be a way for the type checker to force the user to check if the value is `undefined` or not.

The syntax could look something like

```
arr = [1, 2, 3];
x = arr(1);  # this has type Maybe[Int], but it just compiles to x = arr[1n], no need to wrap it in anything in JS
x + 1  # not allowed! can't add a Maybe[Int] to an Int
unwrap(x, 0)  # converts to an Int, falling back on default value if x === undefined, analogous to Rust's unwrap_or_else
```

We could maybe introduce some new operators:

```
arr ! 1  # This is an unsafe access, for when the user knows the index is in bounds and doesn't want to bother with unwrapping
arr(1) ? 0  # This is semantic sugar for unwrap(arr(1), 0)
arr(1) ??  # Abort the program if arr(1) is undefined -- this would require some sort of ability to panic that I don't think we have right now, so maybe should wait until later.
```

I actually kind of like `!` as an unsafe call, so maybe we could use it more generally to denote an unsafe call, for example, replace `unsafeTrans(arr)` with `trans ! arr`. More speculatively, we could have a concept of an unsafe function with `!` as the syntax to call those functions. At the same time, it might make sense to introduce `$` as the equivalent safe call operator (would work the same way as just parenthesis calls but have different precedence).

## 64-bit ndarray types based on JS's TypedArray

TBD

## Tentative: list comprehensions

List comprehensions are helpful as a succinct map + zip + filter. Could be nice to have.

## Tentative: currying

Could be quite useful but possibly quite difficult to implement.

Maybe a simpler feature that would have most of the utility would be something like some special character or other syntax in a function call that means that the function call should actually generate a closure that takes the variable masked by the special char, something like:

```gema
func foo(a: Int, b:Int) {
    a + b
}

13 | foo(1, *Int)  # Would be equivalent to 13 | func(x:Int){foo(1, x)}
```

It should be quite straightforward to infer the type of `*` here, so this could be shortened to just something like `13 | foo(1, *)`.

## Return and continue keywords

These would be helpful to avoid deeply nested control flow.

## Language guide

We should put together a comprehensive guide for the language.

## Optimizations

When transing an expression that is not a variable, there is no need for a copy (it can be a no-op, behaving exactly like unsafeTrans);

We can completely omit branches of the AST that do not operate on pre-existing mutable variables (or have other side effects) and are dropped.

Lots of other room for improvement here.

## More helpful error messages. There are still lots of cases where we emit very opaque error messages.

Maybe the best way to chase these down is to just generate a bunch of slightly misformed code and examine the error messages.
