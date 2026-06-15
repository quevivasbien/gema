import { bench, do_not_optimize, group, run } from "mitata";
import { scan } from "../src/scan";
import { parse } from "../src/parse";
import { resetRegistries } from "../src/ast/index";
import { writeJS } from "../src/write-js";

// ── Code samples ────────────────────────────────────────────────

const MANDELBROT = await Bun.file("mandelbrot.gema").text();
const PRIMES_SIEVE = await Bun.file("primes_sieve.gema").text();
const QUICKSORT_ITERS = await Bun.file("quicksort_iters.gema").text();

// ── Benchmark helpers ───────────────────────────────────────────

function compileCode(code: string): string {
    resetRegistries();
    const tokens = scan(code);
    const { ast } = parse(tokens);
    return writeJS(ast);
}

group("compile", () => {
    bench("mandelbrot", () => do_not_optimize(compileCode(MANDELBROT)));
    bench("primes sieve", () => do_not_optimize(compileCode(PRIMES_SIEVE)));
    bench("quicksort iters", () => do_not_optimize(compileCode(QUICKSORT_ITERS)));
});

await run();
