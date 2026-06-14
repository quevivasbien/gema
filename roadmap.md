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

Note: this will be less important now that we have succinct lambda functions. `13 | \x foo(1, x)` is already quite concise.

## Return and continue keywords

These would be helpful to avoid deeply nested control flow.

## Concatenate iterators

Plus operator on iterators of the same type should concatenate them.

## Optimizations

When transing an expression that is not a variable, there is no need for a copy (it can be a no-op, behaving exactly like unsafeTrans);

We can completely omit branches of the AST that do not operate on pre-existing mutable variables (or have other side effects) and are dropped.

Optimizations for StepIterator: can be made more efficient when stepping over ranges or arrays.

Lots of other room for improvement here.

## More helpful error messages. There are still lots of cases where we emit very opaque error messages.

Maybe the best way to chase these down is to just generate a bunch of slightly misformed code and examine the error messages.
