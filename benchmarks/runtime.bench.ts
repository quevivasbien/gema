import { bench, do_not_optimize, group, run } from "mitata";
import { scan } from "../src/scan";
import { parse } from "../src/parse";
import { resetRegistries } from "../src/ast/index";
import { writeJS } from "../src/write-js";

// ── Code samples ────────────────────────────────────────────────

const ARITHMETIC = `(1 + 2 * 3 - 4 / 2) ^ 3 % 5 + (10 - 3) * 2`;

const ITERATORS = `
result = reduce(
    func(acc: Int, x: Int) { acc + x },
    0,
    filter(func(x: Int): Bool { x % 2 == 0 }, map(func(x: Int): Int { x + 1 }, range(1, 100)))
);
result
`;

const FACTORIAL_REDUCE = `
reduce(func(acc: Int, x: Int): Int { acc * x }, 1, range(1, 10))
`;

const STRUCT_OPS = `
struct Point { x: Int, y: Int }
struct Rect { a: Point, b: Point }

func area(r: Rect): Int {
    w = r.b.x - r.a.x;
    h = r.b.y - r.a.y;
    w * h
}

func translate(r: Rect, dx: Int, dy: Int): Rect {
    Rect(Point(r.a.x + dx, r.a.y + dy), Point(r.b.x + dx, r.b.y + dy))
}

r = Rect(Point(0, 0), Point(10, 10));
area(translate(r, 5, 5))
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

/** Compile once, return a function that evals the compiled JS. */
// eslint-disable-next-line collect(typescript)-eslint/no-explicit-any
function makeRunner(code: string): () => any {
    resetRegistries();
    const tokens = scan(code);
    const { ast } = parse(tokens);
    const js = writeJS(ast);
    return () => eval(js);
}

const runArithmetic = makeRunner(ARITHMETIC);
const runIterators = makeRunner(ITERATORS);
const runFactorial = makeRunner(FACTORIAL_REDUCE);
const runStructs = makeRunner(STRUCT_OPS);
const runMandelbrot = makeRunner(MANDELBROT);
const runPrimesSieve = makeRunner(PRIMES_SIEVE);

// ── Runtime benchmarks ──────────────────────────────────────────

group("run", () => {
    bench("arithmetic", () => do_not_optimize(runArithmetic()));
    bench("iterators", () => do_not_optimize(runIterators()));
    bench("factorial reduce", () => do_not_optimize(runFactorial()));
    bench("struct ops", () => do_not_optimize(runStructs()));
    bench("mandelbrot", () => do_not_optimize(runMandelbrot()));
    bench("primes sieve", () => do_not_optimize(runPrimesSieve()));
});

await run();
