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

These would be helpful to avoid deeply nested control flow. We also need to fix currently existing bugs with the `break` statement.

These statements have the following type behavior:

- All of the `continue`, `break` and `return` statements have null type
- Yes, even the `return` statement has null type! This means that the following examples are not permitted.

```gema
# This is illegal! The if/else expression has type null because both branches end in return statements (which have type null)
func foo(x) {
  if true {
    return 1;
  } else {
    return 2;
  }
}

# The correct way to do this would be
func foo(x) {
  if true {
    return 1;
  }
  2
}

# Or just
func foo(x) {
  if true {
    1
  } else {
    2
  }
}
```

The way the type resolution needs to happen here is: the function needs to keep track of whether it has any return statements in it. (`Return` expressions will mark this on their most recent ancestor function during type resolution in `cascadeTypes` -- the `Return` expressions themselves, of course, have type `Null`, but that is distinguished from the type of the value they return).

Once the function expression is done cascading types to its own children and has resolved its own type, it checks each of the return statements within it and verifies that they are returning a type that matches the function's expected return type.

Other misc examples:

```gema
# This is illegal because the last expression in the function is a naked if, which has type Null.
# So it's not legal to try to return a value of type Int.
func foo() {
  if true {
    return 1;
  }
}

# This _would_ be legal
func foo() {
  if true {
    return 1;
  }
  1
}

# This is okay; this would be a useful pattern if you want a function that just mutates something or has side effects but doesn't return anything
func foo() {
  return
}
```

Something similar needs to happen with `break` and `continue` statements. (In this case, ofc, you don't need to check that the type of the value returned matches the type of the enclosing scope, since for loops always have type Null.) For example:

```gema
# This is fine
for i = 1..10 {
  if i % 2 = 0 {
    continue
  }
}

# But this is not fine, because the branches of an if/else statement need to have the same type
for i = 1..10 {
  if i % 2 = 0 {
    continue
  } else {
    i
  }
}

# This is fine
for i = 1..10 {
  if i % 2 = 0 {
    continue
  } else {
    i;  # Semicolon here discards the value
  }
}

# This is also fine
for i = 1..10 {
  if i % 2 = 0 {
    continue
  } else {
    break  # break and continue both have null type
  }
}
```

Here's an example combining return with continue

```gema
# This is fine! Everything has null value
func foo() {
  for i == 1..10 {
    if i % 2 == 0 {
      continue
    } else {
      return
    }
  }
}
```

## Misc improvements and bug fixes

Don't require param types when referencing functions in a context where it's inferable (e.g. in map).

range index syntax needs to work for iterators (can maybe get rid of take and drop syntax), probably should also add tail iterator

.. syntax for ranges should not continue into a curly brace block (most relevant in context of for loop) -- On second thought on this one, this would screw with a lot of our precedence rules, so maybe not a good idea.

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
