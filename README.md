# gema

A simple programming language that transpiles to JavaScript.

## Setup

This project uses the [Bun](https://bun.sh) JavaScript runtime and package manager. You may also be able to use other runtimes with some minor tweaks.

To install dependencies:

```bash
bun install
```

To run, you can call functions exposed in `index.ts`, or use the code editor+compiler sandbox:

```bash
bun run build:frontend && bun run server.ts
```

This will serve a simple webpage on port 3000 that allows you to try writing and run Gema code.

## Language examples

### Assign variables

```
x = 1;
y = 2.17828;

z = x + y;
# z == 3.17828
```

### Conditional expressions

```
x = 2;

zeroIfOdd = if (x % 2 == 0) {
    x
} else {
    0
};

# zeroIfOdd == 2


x = 3;

zeroIfOdd = if (x % 2 == 0) {
    x
} else {
    0
};

# zeroIfOdd == 0
```

### Functions

```
func isOdd(x: Int): Bool {
    x % 2 != 0
}

isOdd(11)  # true
isOdd(12)  # false
```

### Iterators and functional programming

```
add1 = func(x: Int): Int {
    x + 1
};
iter = map(
    add1,
    map(add1, [1, 2, 3])
);

@iter  # [3, 4, 5]
```

### Custom struct types

```
struct Point {
    x: Float,
    y: Float
}

func taxicab(a: Point, b: Point): Float {
    (b.x - a.x) + (b.y - a.y)
}

taxicab(Point(8.0, 7.0), Point(-2.0, 2.0))  # -15.0
```

### Generic functions and traits

```
trait Comparable {
    eq[(a: Self, b: Self): Bool],
    lt[(a: Self, b: Self): Bool]
};

func lte(a: T, b: T): Bool where T is Comparable {
    lt(a, b) or eq(a, b)
}

func eq(a: Int, b: Int): Bool {
    a == b
}

func lt(a: Int, b: Int): Bool {
    a < b
}

[lte(2, 3), lte(3, 3), lte(4,3)]  # [true, true, false]
```

### Putting it all together

```
struct Complex {
    re: Float,
    im: Float,
}

func abs(z: Complex): Float {
    z.re * z.re + z.im * z.im
}

func mandelIter(z: Complex, c: Complex, i: Int): Bool {
    if (i <= 0) { abs(z) < 4.0 }
    else {
        re = c.re + z.re * z.re - z.im * z.im;
        im = c.im + 2.0 * z.re * z.im;
        mandelIter(Complex(re, im), c, i-1)
    }
}

func isMandel(c: Complex): Bool {
    mandelIter(Complex(0.0, 0.0), c, 20)
}

func linspace(a: Float, b: Float, n: Int): Iter[Float] {
    step = (b - a) / toFloat(n - 1);
    map(func(i: Int) { a + step * toFloat(i) }, range(0, n - 1))
}

func concat(strs: Iter[Str]) {
    reduce(func(acc:Str, x:Str){acc+x}, "", strs)
}

func toStr(arr: Iter[Bool]) {
    strs = map(func(x: Bool){ if x { "*" } else { " " }}, arr);
    concat(strs) + "\n"
}

grid = {
    xs = @linspace(-2.0, 1.0, 39);
    ys = @linspace(-1.5, 1.5, 39);
    concat(
        map(
            func(y: Float) {
                toStr(map(func(x: Float){ isMandel(Complex(x, y)) }, xs))
            },
            ys
        )
    )
};

grid
```

### Mutable variables

```
mut x = 0;
x = x + 1;   # x == 1
x += 2;      # x == 3 (compound assignment)
x *= 3;      # x == 9

# Non-mutable variables cannot be reassigned
y = 1;
# y = 2   — compile error!

# Closures capture mutable variables by reference
func makeCounter(): Func[:Int] {
    mut count = 0;
    func() { count = count + 1; count }
};
a = makeCounter();
b = makeCounter();
a();  # 1
a();  # 2
b();  # 1
```

### Mutable struct fields

```
struct Point {
    mut x: Int,
    mut y: Int,
};

p = Point(1, 2);
p.x = 10;       # Field mutation (field must be declared mut)
p.y += 5;       # Compound field assignment
p.x + p.y       # 15

struct HalfMut { mut a: Int, b: Int };
q = HalfMut(1, 2);
q.a = 3;        # OK — field is mutable
# q.b = 4       — compile error (field not mutable)
```

### Mutable arrays

```
# Create a mutable array from a regular array (deep copy)
mutarr = trans([1, 2, 3]);

# push appends an element, returns the array
push(mutarr, 4);

# set overwrites an element, returns the new value
set(mutarr, 0, 99);

# freeze back to a regular array
result = detrans(mutarr);   # [99, 2, 3, 4]

# unsafeTrans creates a mutable view without copying
x = [1, 2, 3];
y = unsafeTrans(x);
set(y, 0, 99);
x   # [99, 2, 3] — original is also modified!
```

### Tuples

```
# Tuple literals group multiple values of different types
t = (1, "hello", 3.0);

# Index with a literal to access elements
t(0)          # 1
t(1)          # "hello"
t(2)          # 3.0

# Nested tuples
nested = (1, (2, 3));
nested(1)(0)   # 2

# Tuple unpacking destructures into individual variables
(a, b, c) = (10, 20, 30);
a + b + c       # 60

# Unpacking works with any tuple-valued expression
func point(): Tuple[Int, Int] {
    (3, 4)
};
(x, y) = point();
x * x + y * y   # 25

# Mutable bindings in unpacking
(mut i, mut j) = (1, 2);
i = i + j;
i   # 3
```

### Zip iterator

```
# zip combines multiple iterables into an iterator of tuples
zipped = zip([1, 2, 3], ["a", "b", "c"]);
collect(zipped)   # [(1, "a"), (2, "b"), (3, "c")]

# Stops at the shortest input
collect(zip([1, 2], ["a", "b", "c"]))   # [(1, "a"), (2, "b")]

# Three or more iterables
collect(zip([1, 2], ["a", "b"], [true, false]))
# [(1, "a", true), (2, "b", false)]

# Combine with map and tuples
collect(map(
    func(pair: Tuple[Int, Int]) { pair(0) + pair(1) },
    zip([1, 2, 3], [10, 20, 30])
))   # [11, 22, 33]
```
