import { bench, group, run } from "mitata";
import { compile } from "../src/compiler";

// ── Code samples ────────────────────────────────────────────────

const MANDELBROT = {
    "main.gema": await Bun.file("mandelbrot/main.gema").text(),
    "complex.gema": await Bun.file("mandelbrot/complex.gema").text(),
};
const PRIMES_SIEVE_NUMS = await Bun.file("primes_sieve_nums.gema").text();
const QUICKSORT_ITERS = await Bun.file("quicksort_iter.gema").text();

// ── Benchmark helpers ───────────────────────────────────────────

group("compile", () => {
    bench("mandelbrot", () => compile(MANDELBROT));
    bench("primes sieve nums", () => compile(PRIMES_SIEVE_NUMS));
    bench("quicksort iters", () => compile(QUICKSORT_ITERS));
});

await run();
