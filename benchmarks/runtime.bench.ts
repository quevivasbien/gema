import { bench, do_not_optimize, group, run } from "mitata";

import { main as mandelbrot } from "./compiled/mandelbrot.js";
import { main as primes_sieve } from "./compiled/primes_sieve.js";
import { main as quicksort_iter } from "./compiled/quicksort_iter.js";
import { main as quicksort_arr } from "./compiled/quicksort_arr.js";

group("run", () => {
    bench("mandelbrot", () => do_not_optimize(mandelbrot()));
    bench("mandelbrot optimized", () => mandelbrot());
    bench("primes_sieve", () => do_not_optimize(primes_sieve()));
    bench("primes_sieve optimized", () => primes_sieve());
    bench("quicksort_iter", () => do_not_optimize(quicksort_iter()));
    bench("quicksort_iter optimized", () => quicksort_iter());
    bench("quicksort_arr", () => do_not_optimize(quicksort_arr()));
    bench("quicksort_arr optimized", () => quicksort_arr());
});

await run();
