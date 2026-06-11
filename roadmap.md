# Roadmap for `gema` development

## For loops

We should introduce for a for loop, something like:

```gema
func factorial(i: Int) {
    mut result = 1;
    # Syntax is <variable> = <iterator>
    # Loop runs until iterator is exhausted
    for j = range(2, i) {
        result *= j
    }
    result
}

# Alternative of same function
func factorial(i: Int) {
    mut result = 1;
    for j = iterate(func(k: Int){k+1}, 2) {
        if j > i {
            break;
        }
        result *= j
    }
    result
}
```

For loops have null value (you can't set something equal to a for loop or return a for loop from a function): since they are really only helpful for mutations or other operations with side effects, we don't need to force them into the functional framework.

## If statements (without else)

```
mut x = 1;
if x < 2 {
    x += 1;
}
```

This sort of thing should be possible, but if if statements don't have else blocks, they should evaluate to a null value.

## Tuples

We need some sort of data structure that (1) is both guaranteed to have a fixed length, (2) can hold multiple data types at the same time, and (3) doesn't require special declaration beforehand (so we can't just use structs for this purpose).

Proposed syntax:

```gema
tup = (1, 2.0, "hello");  # Creates a Tuple[Int, Float, Str]
first = tup(0);

func getThreeTypes(x: Int): Tuple[Int, Float, Str] {
    (x, toFloat(x), toStr(x))
}
```

It would be nice to have automatic unpacking, so we can do things like:

```gema
x = (1, 2, 3);
(a, b, c) = x;
# Or, if we want to be able to mutate one of the resulting vars:
(mut d, e, mut f) = x;
d = 0;  # Note that this won't impact x, since automatic unpacking will always copy values.
```

With this data type, we can support a zip iterator:

```gema
zipped = zip([1, 2, 3], range(1, 3));

zipped(0)  # Evaluates to (1, 1)
```

## Hash maps and sets

### Maps

All keys must be of the same type, and all values must be of the same type (type signature is `Map[K, V]`). (Open question, what types are allowed for keys? I think JS supports anything if we piggy-back on JS's `Map`, but we might want to limit it or have some concept of hashability?)

Example usage

```gema
# Construct maps with an array of key-value tuples
m = map([("a", 1), ("b", 2)]);  # m has type Map[Str, Int]

set(m, "c", 3);
get(m, "c")
```

### Sets

Example usage

```gema
mut s = set([1, 2, 3, 2]);  # s has type Set[Int]
s += set([2, 3, 4]);  # takes the union
s *= set([1, 3, 8]);  # takes the intersection
push(s, 4);
contains(s, 3)  # true!
```

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

## Pipe syntax

It could be nice to pipe values into functions like

```gema
func f(x: Int) { x + 1}
1 | f  # equivalent to f(1)
```

This of course would only work for functions with one parameter.

## Make builtins behave like normal functions

We already have this to some extent with the type conversion operations like `toStr`, but it is a bit awkward right now that we have a bunch of operations like `map`, `length`, `last`, etc. that look like functions and behave very similarly to functions but can't get overloaded.

## Tentative: Enums

It might be nice to have enums, maybe similar to how it is handled in Rust.

## Proper handling of null/undefined values.

It's possible to get null values with things like `x = { 1; };`. We probably should try to disallow these patterns (it's okay to have statements that aren't expressions, but being able to assign variables to them makes little sense). Right now it's not intended to be able to return a null value from a function, but it is technically possible, and it could make sense to do so given that we now support mutable variables (so we could have functions that are just meant to mutate something). I would say we probably should prohibit functions returning null values.

It is possible to get `undefined` values if we do out of bounds array or iterator access or try to use an empty iterator. This is not possible to prohibit at compile time.

If we have Rust-style enums, we could have a Maybe or Optional enum type; any expression that might give a null value would instead give a Maybe value. If we don't have enums like that, it could be reasonable to just make this a built-in type. `Maybe[Int]` would just mean a value that compiles to either a `BigInt` or `undefined`, and the `Maybe` syntax would just be a way for the type checker to force the user to check if the value is `undefined` or not.

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
arr(1) ??  # Abort the program if arr(1) is undefined
```

I actually kind of like `!` as an unsafe call, so maybe we could use it more generally to denote an unsafe call, for example, replace `unsafeTrans(arr)` with `trans ! arr`. More speculatively, we could have a concept of an unsafe function with `!` as the syntax to call those functions. At the same time, it might make sense to introduce `$` as the equivalent safe call operator (would work the same way as just parenthesis calls but have different precedence).

## No type annotations for anonymous functions.

It should be possible to infer type signatures of anonymous functions from usage. If you try to use an anonymous function, and it's not possible to infer the type signature, that's when we get an error.

```gema
func sum(arr: Arr[Int]) {
    reduce(func(acc, x){acc+x}, 0, arr)  # It's clear here that the anonymous function should have the signature Func[Int, Int]: Int
}
```

We can use the same annotated function syntax that we already have in place for non-anonymous functions when we're passing anonymous functions around like variables.

We probably should also not allow anonymous functions in the top-level scope.

### An extension to this: completely different syntax

We might want to change the syntax of anon functions so they're even less clunky to use.

E.g., something like `(x, y, z) { x + y + z }` instead of `func(x, y, z) {x + y + z}` (the `func` shouldn't really be needed, since it's not legal to have a tuple right next to a curly brace block without a semicolon in between). Probably to make it even more clear that it's an anon function, we could use Haskell-like syntax and do something like `\x, y, z { x + y + z }` or Rust-like syntax like `|x, y, z| { x + y + z }`. We could also copy JS and do `(x, y, z) => { x + y + z }`, but I'd prefer to keep the number of chars required for this at a minimum, since this language is so heavily functional.

```gema
func sum(arr: Arr[Int]) {
    f = \acc, x { acc + x };
    reduce(f, 0, arr)
}
```

## Tentative: list comprehensions

List comprehensions are super helpful as a succinct map + zip + filter. Could be nice to have.
