import { bench, do_not_optimize, group, run } from "mitata";
import { scan } from "../src/scan";
import { parse } from "../src/parse";
import { resetRegistries } from "../src/ast";
import { writeJS } from "../src/write-js";

// ── Code samples ────────────────────────────────────────────────

const SMALL = `1 + 2 * 3`;

const STRUCTS = `
struct Point { x: Int, y: Int }
struct Line { a: Point, b: Point }
func add(a: Point, b: Point): Point { Point(a.x + b.x, a.y + b.y) }
func taxicab(a: Point, b: Point): Int { (b.x - a.x) + (b.y - a.y) }
`;

const TRAITS = `
trait Any {}
trait Adder { add[(a: Self, b: Self): Self] }
trait Comparable { eq[(a: Self, b: Self): Bool], lt[(a: Self, b: Self): Bool] }

func id(x: T): T where T is Any { x }
func add(a: Int, b: Int): Int { a + b }
func eq(a: Int, b: Int): Bool { a == b }
func lt(a: Int, b: Int): Bool { a < b }

func lte(a: T, b: T): Bool where T is Comparable { lt(a, b) or eq(a, b) }
struct Point { x: Int, y: Int }
func add(a: Point, b: Point): Point { Point(a.x + b.x, a.y + b.y) }
func foo(a: T, b: T): T where T is Adder { add(a, b) }
foo(Point(1, 2), Point(3, 4))
`;

const NESTED_GENERICS = `
trait Any {}
trait Summable { sum[(a: Self, b: Self): Self] }

func getLength(arr: Arr[T]): Int where T is Any {
    reduce(func(acc: Int, x: T) { acc + 1 }, 0, arr)
}

func computeSum(arr: Arr[T]): T where T is Summable {
    reduce(func(acc: T, x: T) { sum(acc, x) }, 0, arr)
}

func sum(iter: Iter[T], start: T): T where T is Summable {
    reduce(func(acc: T, x: T) { sum(acc, x) }, start, iter)
}

func sum(a: Int, b: Int): Int { a + b }

getLength([1,2,3])
computeSum([1,2,3])
sum([1, 2, 3], 0)
`;

const KEYWORD_ARGS = `
func foo(x: Int, y: Int): Int { x + y }
func bar(a: Int, b: Str, c: Float): Str { toStr(a) + b + toStr(c) }
result = foo(x=1, y=2) + foo(y=3, x=4) + bar(a=5, b="x", c=1.5)
`;

const MANDELBROT = `
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
    concat(strs) + "\\n"
}

grid = {
    xs = collect(linspace(-1.75, 0.25, 19));
    ys = collect(linspace(-1., 1., 19));
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
`;

const PRIMES_SIEVE = `
trait Any {}

func fill(x: T, n: Int) where T is Any {
  collect(take(n, iterate(func(ignore: T){ x }, x)))
}

func sieve(upto: Int) {
  isPrime = fill(true, upto) | unsafeTrans;
  primes = []:Int | trans;
  for i = range(2, upto) {
    if isPrime(i-1) {
      push(primes, i);
      if i * i < upto {
        for m = range(0, (upto - i*i) / i) {
          set(isPrime, m*i + i*i - 1, false);
        }
      }
    };
  }
  primes | detrans
}

100000 | sieve | last
`;

// ── Benchmark helpers ───────────────────────────────────────────

function compileCode(code: string): string {
    resetRegistries();
    const tokens = scan(code);
    const { ast } = parse(tokens);
    return writeJS(ast);
}

function scanOnly(code: string): ReturnType<typeof scan> {
    return scan(code);
}

function parseOnly(code: string): void {
    resetRegistries();
    const tokens = scan(code);
    parse(tokens);
}

// ── Scan benchmarks ─────────────────────────────────────────────

group("scan", () => {
    bench("small", () => do_not_optimize(scanOnly(SMALL)));
    bench("mandelbrot", () => do_not_optimize(scanOnly(MANDELBROT)));
});

// ── Parse benchmarks ────────────────────────────────────────────

group("parse", () => {
    bench("small", () => parseOnly(SMALL));
    bench("structs", () => parseOnly(STRUCTS));
    bench("traits", () => parseOnly(TRAITS));
    bench("mandelbrot", () => parseOnly(MANDELBROT));
});

// ── Full compile benchmarks ─────────────────────────────────────

group("compile", () => {
    bench("small", () => do_not_optimize(compileCode(SMALL)));
    bench("structs", () => do_not_optimize(compileCode(STRUCTS)));
    bench("traits", () => do_not_optimize(compileCode(TRAITS)));
    bench("nested generics", () => do_not_optimize(compileCode(NESTED_GENERICS)));
    bench("keyword args", () => do_not_optimize(compileCode(KEYWORD_ARGS)));
    bench("mandelbrot", () => do_not_optimize(compileCode(MANDELBROT)));
    bench("primes sieve", () => do_not_optimize(compileCode(PRIMES_SIEVE)));
});

await run();
