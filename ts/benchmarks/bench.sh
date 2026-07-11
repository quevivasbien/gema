mkdir -p compiled

bun ../compile.ts -m mandelbrot/*.gema -o compiled/mandelbrot.js
bun ../compile.ts -m primes_sieve_ints.gema -o compiled/primes_sieve_ints.js
bun ../compile.ts -m primes_sieve_nums.gema -o compiled/primes_sieve_nums.js
bun ../compile.ts -m quicksort_arr.gema -o compiled/quicksort_arr.js
bun ../compile.ts -m quicksort_iter.gema -o compiled/quicksort_iter.js
bun ../compile.ts -m quicksort_mutarr.gema -o compiled/quicksort_mutarr.js

bun run runtime.bench.ts