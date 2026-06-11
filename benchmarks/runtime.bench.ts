import { bench, do_not_optimize, group, run } from "mitata";
import { scan } from "../src/scan";
import { parse } from "../src/parse";
import { resetRegistries } from "../src/ast";
import { writeJS } from "../src/write-js";

// ── Code samples ────────────────────────────────────────────────

const ARITHMETIC = `(1 + 2 * 3 - 4 / 2) ^ 3 % 5 + (10 - 3) * 2`;

const ITERATORS = `
func add1(x: Int): Int { x + 1 }
func isEven(x: Int): Bool { x % 2 == 0 }
func sum(acc: Int, x: Int): Int { acc + x }

result = reduce(sum, filter(isEven, map(add1, range(1, 100))), 0)
result
`;

const FACTORIAL_REDUCE = `
func product(acc: Int, x: Int): Int { acc * x }

reduce(product, range(1, 10), 1)
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
struct Complex { re: Float, im: Float }

func abs(z: Complex): Float { z.re * z.re + z.im * z.im }

func mandelIter(z: Complex, c: Complex, i: Int): Bool {
    if (i <= 0) { abs(z) < 4.0 }
    else {
        re = c.re + z.re * z.re - z.im * z.im;
        im = c.im + 2.0 * z.re * z.im;
        mandelIter(Complex(re, im), c, i-1)
    }
}

func isMandel(c: Complex): Bool { mandelIter(Complex(0.0, 0.0), c, 20) }

func linspace(a: Float, b: Float, n: Int): Iter[Float] {
    step = (b - a) / toFloat(n - 1);
    map(func(i: Int) { a + step * toFloat(i) }, range(0, n - 1))
}

func concat(strs: Iter[Str]) {
    reduce(func(acc:Str, x:Str){acc+x}, strs, "")
}

func toStr(arr: Iter[Bool]) {
    strs = map(func(x: Bool){ if x { "*" } else { " " }}, arr);
    concat(strs) + "\\n"
}

grid = {
    xs = @linspace(-1.75, 0.25, 19);
    ys = @linspace(-1., 1., 19);
    concat(map(func(y: Float) { toStr(map(func(x: Float){ isMandel(Complex(x, y)) }, xs)) }, ys))
};
grid
`;

// ── Benchmark helpers ───────────────────────────────────────────

/** Compile once, return a function that evals the compiled JS. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

// ── Runtime benchmarks ──────────────────────────────────────────

group("run", () => {
    bench("arithmetic", () => do_not_optimize(runArithmetic()));
    bench("iterators", () => do_not_optimize(runIterators()));
    bench("factorial reduce", () => do_not_optimize(runFactorial()));
    bench("struct ops", () => do_not_optimize(runStructs()));
    bench("mandelbrot", () => do_not_optimize(runMandelbrot()));
});

await run();
