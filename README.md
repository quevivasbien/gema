# gema

A simple programming language that transpiles to JavaScript.


## Setup

This project uses the [Bun](https://bun.sh) JavaScript runtime and package manager, though you should also be able to use Node + NPM (or similar) with some minor tweaks.

To install dependencies:

```bash
bun install
```

To run, you can call functions exposed in `index.ts`, or use:

```bash
bun run server.ts
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
    x: Float
    y: Float
}

func taxicab(a: Point, b: Point): Float {
    (b("x") - a("x")) + (b("y") - a("y"))
}

taxicab(Point(8.0, 7.0), Point(-2.0, 2.0))  # -15.0
```

### Generic functions and traits
```
trait Comparable {
    eq[Self, Self: Bool],
    lt[Self, Self: Bool]
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
    reduce(func(acc:Str, x:Str){acc+x}, strs, "")
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
