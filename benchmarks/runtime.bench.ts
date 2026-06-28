import { bench, do_not_optimize, group, run } from "mitata";

import { main as mandelbrot } from "./compiled/mandelbrot.js";
import { main as primes_sieve_ints } from "./compiled/primes_sieve_ints.js";
import { main as primes_sieve_nums } from "./compiled/primes_sieve_nums.js";
import { main as quicksort_iter } from "./compiled/quicksort_iter.js";
import { main as quicksort_arr } from "./compiled/quicksort_arr.js";
import { main as quicksort_mutarr } from "./compiled/quicksort_mutarr.js";

group("run", () => {
    bench("mandelbrot", () => do_not_optimize(mandelbrot()));
    bench("mandelbrot optimized", () => mandelbrot());
    bench("primes_sieve_ints", () => do_not_optimize(primes_sieve_ints()));
    bench("primes_sieve_ints optimized", () => primes_sieve_ints());
    bench("primes_sieve_nums", () => do_not_optimize(primes_sieve_nums()));
    bench("primes_sieve_nums optimized", () => primes_sieve_nums());
    bench("quicksort_iter", () => do_not_optimize(quicksort_iter()));
    bench("quicksort_iter optimized", () => quicksort_iter());
    bench("quicksort_arr", () => do_not_optimize(quicksort_arr()));
    bench("quicksort_arr optimized", () => quicksort_arr());
    bench("quicksort_mutarr", () => do_not_optimize(quicksort_mutarr()));
    bench("quicksort_mutarr optimized", () => quicksort_mutarr());
});

await run();
