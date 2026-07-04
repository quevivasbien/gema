import { test } from "bun:test";
import { testCompile, testCompileMulti } from "./helpers";

// ============================================================
// Sandbox preset tests — extracted from frontend/editor.js
// ============================================================

test("sandbox: FizzBuzz", () => {
    testCompile(
        `# Classic FizzBuzz: print Fizz for multiples of 3,
# Buzz for multiples of 5, FizzBuzz for both.

func fizzBuzz(n: Num): Str {
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
1..20 | map(fizzBuzz[Num]) | collect`,
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
    match iter(0) {
        none { iter },
        some(pivot) {
            rest = (drop(1, iter));
            left = filter(\\x { x <= pivot }, rest);
            right = filter(\\x { x > pivot }, rest);
            quicksort(left) + toIter([pivot]) + quicksort(right)
        }
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
    mut is_prime = map(\\_ true, 0..n) | collect | trans;
    put(false, 0, is_prime);
    put(false, 1, is_prime);

    for i = (2..) {
        if i * i > n { break; }
        if (is_prime(i) | unwrap) {
            for j = step(i, (i * 2)..n) {
                put(false, j, is_prime)
            }
        }
    };

    (0..n) | filter(\\x { is_prime(x) | unwrap }) | collect
};

sieve(50)   # primes up to 50`,
        [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47]
    );
});

test("sandbox: Prime factorization", () => {
    testCompile(
        `# Prime factorization using recursion and iteration

func smallestFactor(n: Num): Num {
    if (n % 2 == 0) { 2 }
    else {
        (3..)
            | takeWhile(\\x { x * x <= n})
            | filter(\\x { n % x == 0 })
            | \\x x(0)
            | unwrap(n)
    }
};

func factors(n: Num): Arr[Num] {
    if (n <= 1) { []:Num }
    else {
        sf = smallestFactor(n);
        [sf] + factors(n / sf)
    }
};

factors(84)  # [2, 2, 3, 7]`,
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
        put(unwrap(0, count) + 1, w, freq)
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
func [T: Concatenatable] tacnoc(a: T, b: T): T {
  concat(b, a)
}

# Implement for strings
func concat(a: Str, b: Str) { a + b };
result_str = tacnoc("hello", "there");

# Implement for integers (digit concatenation)
func concat(a: Int, b: Int) {
  func getNDigits(x: Int, n: Int): Int {
    if x <= 0i { n }
    else { getNDigits(x // 10i, n + 1i) }
  };
  a * 10i ^ getNDigits(b, 0i) + b
};
result_int = tacnoc(123i, 45i);

# Implement for a struct
struct Pair { first: Int, second: Int }
func concat(a: Pair, b: Pair) {
  Pair(concat(a.first, b.first), concat(a.second, b.second))
};
result_pair = tacnoc(Pair(1i, 2i), Pair(34i, 56i));

(result_str, result_int, result_pair)`,
        ["therehello", 45123n, { first: 341n, second: 562n }]
    );
});

test("sandbox: Mandelbrot set", () => {
    testCompileMulti(
        {
            "main.gema": `# ASCII Mandelbrot set visualization

# Import module with definition and basic functions for a Complex type
use "complex.gema"

func mandelIter(z: Complex, c: Complex, i: Num): Bool {
    if (i <= 0) { return abs2(z) < 4.0 }
    mandelIter(z * c, c, i - 1)
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
    xs = collect(linspace(-1.5, 0.5, 19));
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
