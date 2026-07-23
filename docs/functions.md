# Functions

## Named functions

Named (non-anonymous) functions use the following syntax:

```gema
func foo(x: Num): Num {
  x + 1
}

# Argument type annotations are required, but the return type is optional unless the function is recursive
func foo(x: Int) {
  x + 1i
}
```

Named functions can be overloaded with different argument type signatures. When compiling to JS, each overload of a function name gets a unique JS name based on a counter of the order in which the functions are defined. The above example would compile to something like:

```js
function foo$0(x) {
  return x + 1;
}

function foo$1(x) {
  return x + 1n;
}
```

To disambiguate function overloads, named functions must always be annotated by their argument type signature when being referenced as a variable:

```gema
f = foo[Num];  # Save the overload of foo that takes a single Num argument to a variable f
bar(foo[Num, Num])  # Pass the overload of foo that takes two Num arguments to another function bar
```

Argument type annotations are optional when calling named functions (usually the intended overload can be easily inferred based on the arguments themselves): `foo[Num](1)` would be equivalent to `foo(1)`.

## Generic functions

Generic functions use the following syntax:

```gema
# Example with generic type with no trait bounds
func [T] toArray(x: T): Arr[T] {
  [x]
}

trait Foo {
  foo: Func[Self, Self: Self]
}

trait Bar {
  bar: Self
}

# Example with generic type with trait bounds
func [T: Foo] applyFoo(x: T, y: T): T {
  T::foo(x, y)  # This syntax denotes that foo is a function associated with a trait of T; it is required when using trait-associated functions or variables
}

# Example with generic type with multiple trait bounds
func [T: Foo + Bar] applyFooWithBar(x: T) {
  T::foo(x, T::bar)
}

# Example with multiple generic types
func [T: Foo, U: Foo] createFooTuple(x: T, y: U): Tup[T, U] {
  (T::foo(x, x), U::foo(y, y))
}

# Example with generic appearing in nested type of argument
func [T] firstOrDefault(arr: Arr[T], default: T): T {
  unwrap(default, arr(0))
}
```

Note that any generic types listed in the `[...]` in a generic function definition _must_ be used by at least one argument of the function.

### Dictionary passing

Generic functions work using dictionary passing for implementations of traits required for generic types.

Gema code like

```gema
trait Foo {
  foo: Func[Self, Self: Self]
}

trait Bar {
  bar: Self
}

func [T: Foo + Bar] applyFooWithBar(x: T) {
  T::foo(x, T::bar)
}

impl Num: Foo {
  func foo(x: Num, y: Num) {
    x + y
  }
}

impl Num: Bar {
  bar = 0;
}

applyFooWithBar(1)
```

would compile to something like

```js
const result = (() => {
  function applyFooWithBar(x, $impl_T_Foo, $impl_T_Bar) {
    return $impl_T_Foo.foo(x, $impl_T_Bar.bar);
  }

  const $impl_Num_Foo = (() => {
    function foo$0(x, y) {
      return x + y;
    }
    return { foo: foo$0 };
  })();

  const $impl_Num_Bar = (() => {
    const bar = 0;
    return { bar };
  })();

  return applyFooWithBar(1, $impl_Num_Foo, $impl_Num_Bar);
})();
```

### Overloading generic functions is not allowed

Note that it is _not_ legal to overload a generic function or to have a generic function overload an existing non-generic function. (Though it is legal to shadow a generic in an enclosing scope, and vice versa.) Because of this, when compiled to JS, generic function names aren't suffixed with overload indices like non-generic functions are.

### Edge case: multiple traits have the same requirement

If a type implements multiple traits which have the same requirement, it is an error to try to use that requirement. Example:
```gema
trait Foo {
  f: Func[Self: Self]
}
trait Bar {
  f: Func[Self: Self]
}
impl Num: Foo {
  func f(x: Num) { x }
}
impl Num: Bar {
  func f(x: Num) { x + 1 }
}
Num::f(1)  # Error -- which impl of `f` should we use? The one for `Foo` or the one for `Bar`?
```

In the future, we may add a way to disambiguate such cases.

## Anonymous functions

Anonymous functions use the following syntax:

```gema
# Anon function with a single argument
\x: Num -> x + 1

# Another valid syntax (if the anon function body is a block expression, the arrow is optional)
\x: Num { x + 1 }

# Anon function with multiple arguments (must be in parentheses)
\(x: Num, y: Num) -> x + y

# Type annotations on arguments are optional, but if they cannot be successfully inferred from context, this is a compile-time error
\(x, y) -> x + y
```

Anonymous functions can assigned to variables and passed to functions

```gema
addOne = \x -> x + 1;

func apply(f: Func[Num: Num], x: Num) {
  f(x)
}

apply(addOne, 1)  # Equivalent to apply(\x -> x + 1, 1)
```

Anonymous functions can also be directly called:

```gema
(\x -> x + 1)(1)  # == 2
```

Anonymous functions can be used to satisfy trait requirements:

```gema
trait Foo {
  foo: Func[Self: Self]
}

impl Num: Foo {
  foo = \x: Num -> x + 1;
}
```

Anonymous functions compile in a straightforward way to JS anonymous functions. `\x -> x + 1` would compile to something like `(x) => { return x + 1; }`. `\x { y = x + 1; y }` would compile to something like `(x) => { const y = x + 1; return y; }`
