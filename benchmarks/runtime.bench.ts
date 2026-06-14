import { bench, do_not_optimize, group, run } from "mitata";
import { scan } from "../src/scan";
import { parse } from "../src/parse";
import { resetRegistries } from "../src/ast/index";
import { writeJS } from "../src/write-js";

// ── Code samples ────────────────────────────────────────────────

const MANDELBROT = `struct Complex { re: Float, im: Float }

func add(a: Complex, b: Complex): Complex {
    Complex(a.re + b.re, a.im + b.im)
}

func mul(z: Complex, c: Complex): Complex {
    Complex(c.re + z.re * z.re - z.im * z.im,
            c.im + 2.0 * z.re * z.im)
}

func abs2(z: Complex): Float { z.re * z.re + z.im * z.im }

func mandelIter(z: Complex, c: Complex, i: Int): Bool {
    if (i <= 0) { abs2(z) < 4.0 }
    else { mandelIter(mul(z, c), c, i - 1) }
}

func isMandel(c: Complex): Bool {
    mandelIter(Complex(0.0, 0.0), c, 20)
}

func linspace(a: Float, b: Float, n: Int): Iter[Float] {
    step = (b - a) / toFloat(n - 1);
    map(\\i { a + step * toFloat(i) }, 0..(n - 1))
}

func concat(strs: Iter[Str]) {
    reduce(\\acc, x { acc + x }, "", strs)
}

func toStr(arr: Iter[Bool]) {
    strs = map(\\x { if x { "*" } else { " " } }, arr);
    concat(strs) + "\\n"
}

grid = concat(map(\\y {
    xs = collect(linspace(-1.75, 0.25, 39));
    toStr(map(\\x { isMandel(Complex(x, y)) }, xs))
}, collect(linspace(-1., 1., 39))));
grid
`;

const PRIMES_SIEVE = `
trait Any {}

func fill(x: T, n: Int) where T is Any {
  map(\\i x, 0..n-1) | collect
}

func sieve(upto: Int) {
  isPrime = fill(true, upto) | unsafeTrans;
  primes = []:Int | trans;
  for i = range(2, upto) {
    if isPrime(i-1)| unwrap {
      push(primes, i);
      if i * i < upto {
        for m = range(0, (upto - i*i) / i) {
          put(isPrime, m*i + i*i - 1, false);
        }
      }
    };
  }
  primes | detrans
}

100000 | sieve | last
`;

const QUICKSORT_W_ARRAYS = `func quicksort(arr: Arr[Int]): Arr[Int] {
    if (length(arr) <= 1) {
        arr
    } else {
        pivot = arr!(0);
        rest = arr(1..);
        left = collect(filter(\\x { x <= pivot }, rest));
        right = collect(filter(\\x { x > pivot }, rest));
        quicksort(left) + [pivot] + quicksort(right)
    }
};

unsorted = [69,72,9,39,14,14,37,34,91,4,56,53,22,59,31,67,10,95,31,56,48,58,68,22,9,5,91,56,2,49,91,42,42,25,94,41,94,54,14,51,49,57,89,28,20,73,86,2,13,64,86,2,40,93,50,65,69,59,44,59,32,84,38,33,2,11,2,51,95,21,53,74,54,16,58,77,53,57,28,24,73,77,14,53,64,85,67,44,19,9,95,1,85,45,44,45,60,84,13,10];
quicksort(unsorted)`;

const QUICKSORT_W_ITERS = `func quicksort(arr: Iter[Int]): Iter[Int] {
    first = arr(0);
    if isnone(first){
       arr
    } else {
        pivot = unwrap(first);
        rest = (drop(1, arr));
        left = filter(\\x { x <= pivot }, rest);
        right = filter(\\x { x > pivot }, rest);
        quicksort(left) + [pivot] + quicksort(right)
    }
};

unsorted = [69,72,9,39,14,14,37,34,91,4,56,53,22,59,31,67,10,95,31,56,48,58,68,22,9,5,91,56,2,49,91,42,42,25,94,41,94,54,14,51,49,57,89,28,20,73,86,2,13,64,86,2,40,93,50,65,69,59,44,59,32,84,38,33,2,11,2,51,95,21,53,74,54,16,58,77,53,57,28,24,73,77,14,53,64,85,67,44,19,9,95,1,85,45,44,45,60,84,13,10];
quicksort(unsorted) | collect`;

// ── Benchmark helpers ───────────────────────────────────────────

/** Compile once, return a function that evals the compiled JS. */
function makeRunner(code: string) {
    resetRegistries();
    const tokens = scan(code);
    const { ast } = parse(tokens);
    const js = writeJS(ast);
    return () => eval(js);
}

const runMandelbrot = makeRunner(MANDELBROT);
const runPrimesSieve = makeRunner(PRIMES_SIEVE);
const runQuicksortWArrays = makeRunner(QUICKSORT_W_ARRAYS);
const runQuicksortWIters = makeRunner(QUICKSORT_W_ITERS);

// ── Runtime benchmarks ──────────────────────────────────────────

group("run", () => {
    bench("mandelbrot", () => do_not_optimize(runMandelbrot()));
    bench("primes sieve", () => do_not_optimize(runPrimesSieve()));
    bench("quicksort w arrays", () => do_not_optimize(runQuicksortWArrays()));
    bench("quicksort w iters", () => do_not_optimize(runQuicksortWIters()));
});

await run();
