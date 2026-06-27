import { test } from "bun:test";
import { testCompile, testCompileMulti } from "./helpers";

// ============================================================
// Sandbox preset tests — extracted from frontend/editor.js
// ============================================================

test("sandbox: FizzBuzz", () => {
    testCompile(
        `
        # Classic FizzBuzz: print Fizz for multiples of 3,
# Buzz for multiples of 5, FizzBuzz for both.

func fizzbuzz(n: Num): Str {
    if (n % 15 == 0) {
        "FizzBuzz"
    } else if (n % 3 == 0) {
        "Fizz"
    } else if (n % 5 == 0) {
        "Buzz"
    } else {
        toStr(n)
    }
};

# Apply to range 1..20, collect into array
1..20 | map(fizzbuzz[Num]) | collect`,
        [
            "1",
            "2",
            "Fizz",
            "4",
            "Buzz",
            "Fizz",
            "7",
            "8",
            "Fizz",
            "Buzz",
            "11",
            "Fizz",
            "13",
            "14",
            "FizzBuzz",
            "16",
            "17",
            "Fizz",
            "19",
            "Buzz",
        ]
    );
});

test("sandbox: Fibonacci", () => {
    testCompile(
        `# Fibonacci sequence shown four ways

# 1. Naive recursion
func fibRec(n: Num): Num {
    if (n <= 1) { n }
    else { fibRec(n - 1) + fibRec(n - 2) }
};

# 2. More efficient recursion
func fibRecTCO(n: Num) {
    func f(i: Num, prev: Num, prevprev: Num): Num {
        if i == n { return prev }
        # Last expr in f is a call to itself; this is tail-call optimized, allowing infinite recursion depth
        f(i + 1, prev + prevprev, prev)
    };
    if (n <= 1) { n }
    else { f(1, 1, 0) }
}

# 3. With iterate (generates an infinite sequence of Fibonacci numbers)
fibs = iterate(\\pair { (pair(1), pair(0) + pair(1)) }, (0, 1))
       | map(\\p { p(0) });

# 4. Imperative with mutable vars
func fibLoop(n: Num): Num {
    if (n <= 1) { n }
    else {
        mut a = 0;
        mut b = 1;
        for i = 2..n {
            next = a + b;
            a = b;
            b = next
        };
        b
    }
};

(fibRec(9), fibRecTCO(9), fibs(9) | unwrap, fibLoop(9))`,
        [34, 34, 34, 34]
    );
});

test("sandbox: Quicksort", () => {
    testCompile(
        `# Quicksort using functional style
func quicksort(iter: Iter[Num]): Iter[Num] {
    first = iter(0);
    if isnone(first){
        iter
    } else {
        pivot = unwrap(first);
        rest = (drop(1, iter));
        left = filter(\\x { x <= pivot }, rest);
        right = filter(\\x { x > pivot }, rest);
        quicksort(left) + toIter([pivot]) + quicksort(right)
    }
};

unsorted = [3, 7, 8, 5, 2, 1, 9, 6, 4];
quicksort(unsorted) | collect   # [1, 2, 3, 4, 5, 6, 7, 8, 9]`,
        [1, 2, 3, 4, 5, 6, 7, 8, 9]
    );
});

test("sandbox: Sieve of Eratosthenes", () => {
    testCompile(
        `# Sieve of Eratosthenes using mutable arrays

func sieve(n: Num): Arr[Num] {
    mut isPrime = map(\\_ true, 0..n) | collect | trans;
    put(isPrime, 0, false);
    put(isPrime, 1, false);

    for i = (2..) {
        if i * i > n { break; }
        if (isPrime(i) | unwrap) {
            for j = step(i, (i * 2)..n) {
                put(isPrime, j, false)
            }
        }
    };

    (0..n) | filter(\\x { isPrime(x) | unwrap }) | collect
};

sieve(50)   # primes up to 50`,
        [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47]
    );
});

test("sandbox: Functional pipeline", () => {
    testCompile(
        `# A functional pipeline: compute sum of squares of even
# numbers from 1..100, using pipe and lambdas.

result = 1..100
    | filter(\\x { x % 2 == 0 })    # keep evens
    | map(\\x { x * x })              # square them
    | reduce(\\(acc, x) { acc + x }, 0) # sum

# Same thing expressed more concisely:
result2 = reduce(\\(acc, x) {
    if x % 2 == 0 { acc + x * x } else { acc }
}, 0, 1..100);

result == result2   # true (both are 171700)`,
        true
    );
});

test("sandbox: Prime factorization", () => {
    testCompile(
        `# Prime factorization using recursion and iteration

func smallestFactor(n: Num): Num {
    if (n % 2 == 0) { 2 }
    else {
        factors = (3..)
            | takeWhile(\\x { x * x <= n})
            | filter(\\x { n % x == 0 });
        unwrap(factors(0), n)
    }
};

func factors(n: Num): Arr[Num] {
    if (n <= 1) { []:Num }
    else {
        sf = smallestFactor(n);
        [sf] + factors(n / sf)
    }
};

factors(84)   # [2, 2, 3, 7]`,
        [2, 2, 3, 7]
    );
});

test("sandbox: Word frequency", () => {
    testCompile(
        `# Count word frequencies using Dict and functional combinators

# Sample text as an array of words
words = ["the", "quick", "brown", "fox", "jumps", "over",
         "the", "lazy", "dog", "the", "fox"];

# Build a frequency dict manually
func countWords(words: Arr[Str]): Dict[Str, Num] {
    freq = trans(Dict([]:Tup[Str, Num]));
    for w = words {
        count = freq(w);
        put(freq, w, (if isnone(count) { 0 } else { unwrap(count) }) + 1)
    };
    detrans(freq)
};

freq = countWords(words);

# Access individual frequencies
(
  freq("the") | unwrap,   # 3
  freq("fox") | unwrap,   # 2
)`,
        [3, 2]
    );
});

test("sandbox: Generic functions", () => {
    testCompile(
        `# Generic functions with trait bounds

trait Concatenatable {
  concat[(a: Self, b: Self): Self],
}

# Generic: works with any Concatenatable type
func tacnoc(a: T, b: T): T where T is Concatenatable {
  concat(b, a)
}

# Implement for strings
func concat(a: Str, b: Str) { a + b };
result_str = tacnoc("hello", "there");

# Implement for integers (digit concatenation)
func concat(a: Num, b: Num) {
  func getNDigits(x: Num, n: Num): Num {
    if x <= 0 { n }
    else { getNDigits(x // 10, n + 1) }
  };
  a * 10 ^ getNDigits(b, 0) + b
};
result_int = tacnoc(123, 45);

# Implement for a struct
struct Pair { first: Num, second: Num }
func concat(a: Pair, b: Pair) {
  Pair(concat(a.first, b.first), concat(a.second, b.second))
};
result_pair = tacnoc(Pair(1, 2), Pair(34, 56));

(result_str, result_int, result_pair)`,
        ["therehello", 45123, { first: 341, second: 562 }]
    );
});

test("sandbox: Closures and state", () => {
    testCompile(
        `# Closures capture mutable variables by reference,
# enabling stateful function objects.

func makeCounter(): Func[:Num] {
    mut count = 0;
    func() { count = count + 1; count }
};

a = makeCounter();
b = makeCounter();
indep_state = [a(), a(), b(), b()];   # [1, 2, 1, 2] — independent state

# Higher-order: a function that takes a predicate
# and returns a filtered counter
func makeFilteredCounter(pred: Func[Num: Bool]): Func[:Num] {
    mut count = 0;
    func() {
        count = count + 1;
        if pred(count) { count } else { 0 }
    }
};

evens = makeFilteredCounter(\\x { x % 2 == 0 });
mutating_state = [evens(), evens(), evens()];   # [0, 2, 0]

(indep_state, mutating_state)`,
        [
            [1, 2, 1, 2],
            [0, 2, 0],
        ]
    );
});

test("sandbox: Mandelbrot set", () => {
    testCompileMulti(
        {
            "main.gema": `# ASCII Mandelbrot set visualization

# Import module with definition and basic functions for a Complex type
use "complex.gema"

func mandelIter(z: Complex, c: Complex, i: Num): Bool {
    if (i <= 0) { abs2(z) < 4.0 }
    else { mandelIter(z * c, c, i - 1) }
}

func isMandel(c: Complex): Bool {
    mandelIter(Complex(0.0, 0.0), c, 20)
}

func linspace(a: Num, b: Num, n: Num): Iter[Num] {
    step = (b - a) / (n - 1);
    map(\\i { a + step * i }, 0..(n - 1))
}

func concat(strs: Iter[Str]) {
    reduce(\\(acc, x) { acc + x }, "", strs)
}

func toStr(arr: Iter[Bool]) {
    strs = map(\\x { if x { "*" } else { " " } }, arr);
    concat(strs) + "\\n"
}

grid = concat(map(\\y {
    xs = collect(linspace(-1.75, 0.25, 19));
    toStr(map(\\x { isMandel(Complex(x, y)) }, xs))
}, collect(linspace(-1., 1., 19))));
length(grid) > 0 # Just a basic assertion to check that the program ran`,
            "complex.gema": `struct Complex { re: Num, im: Num }

func add(a: Complex, b: Complex): Complex {
    Complex(a.re + b.re, a.im + b.im)
}

func multiply(z: Complex, c: Complex): Complex {
    Complex(c.re + z.re * z.re - z.im * z.im,
            c.im + 2.0 * z.re * z.im)
}

func abs2(z: Complex): Num { z.re * z.re + z.im * z.im }`,
        },
        "main.gema",
        true
    );
});
