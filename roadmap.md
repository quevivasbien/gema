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

### Potential future extension

We could have some sort of intelligent type inference where if you do something like call `Arr.empty` and it doesn't find any such function defined for an un-templated `Arr`, it will match to the first templated `Arr[T].empty` (or generally speaking, `Arr[T, U, ...].empty`) that it finds and try to use that.

For example, if I call `Arr.zeros(3)` it will start by finding a function with a signature like `func Arr.zeros(_: Int) { ... }` and it it doesn't find that it will try to use the first `func Arr[...].zeros(_: Int) { ... }` that it finds.

As an extension to this, it could also be useful to

## Tentative: allow structs to have generic fields

Something like:

```gema
struct S[T] where T is Foo {
  a: T,
  b: T
}
```

## Very tentative: templated traits?

This seems like probably too far down the rabbit hole...

## Tentative: Improvements to enums

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

## Tentative: remove `:` from type annotations.

The `:` that we have as part of our type annotations is not really needed--it's just an extra character to type. We could just have go-style type annotations like `func(a Int, b Float) Float { toFloat(a) + b }`

## Misc improvements and bug fixes

### Tail-call optimization for if / else branching. Currently, this will use TCO:

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

### Add a proper name registry so we can get rid of all the weird name mangling and be sure to avoid name collisions

Should just have a "what am I called" in JS helper which simultaneously ensures that variables are valid JS and that they don't unintentionally collide with something else.

### Have module imports keep their own scope

We currently have a weird hybrid variable resolution where some things look in scope and some things look in the function registry. Everything needs to happen within the scope system. I think there is a lot of weirdness here with generic functions and TAFs, too.

### Others

- Don't require param types when referencing functions in a context where it's inferable (e.g. in map).

- Allow lambdas not just in builtin functions -- if there is a function that _could_ match, we take that match (will need to think through the details here more).

- When resolving callers, keep track of the closest match so far, so this can be reported in the error message if no match is found.

- Go back to allowing generic types in functions to not specify a trait bound.

- Fix weird error message when trying to compile an empty program: "Error in main.gema at line 1, column 1: can't access property "line", Z is undefined"

- if/else exprs should not require {}

- Make sure all the builtins follow the `f(<func>, <values>..., <container>)` idiom so they are easily chainable.

- Allow underscores in numeric literals

- Do not allow functions to take arguments of type null. Something like this should not compile: `func foo(x: Null) {1;} foo({1;}); 1`

- Nodes should have their module names in addition to their lines and cols

### range index syntax needs to work for iterators (can maybe get rid of take and drop syntax), probably should also add tail iterator

-- on second thought here, the `take` and `drop` ops are better suited to functional semantics, and a tail operation would be rather expensive. If users really do want to take the tail of an iterator, they can collect the iterator or use something like

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
