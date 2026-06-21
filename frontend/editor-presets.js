/**
 * Preset programs for the Gema playground.
 *
 * Each preset has:
 *   label     — Display name in the dropdown
 *   files     — Record of filename → source content (multi-file support)
 */
export const PRESETS = {
    blank: {
        label: "Blank",
        files: {
            "main.gema": `# Write your code here, or choose a preset above`,
        },
    },
    fizzbuzz: {
        label: "FizzBuzz",
        files: {
            "main.gema": `# Classic FizzBuzz: print Fizz for multiples of 3,
# Buzz for multiples of 5, FizzBuzz for both.

func fizzbuzz(n: Int): Str {
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
1..20 | map(fizzbuzz[Int]) | collect`,
        },
    },
    fibonacci: {
        label: "Fibonacci",
        files: {
            "main.gema": `# Fibonacci sequence shown three ways

# 1. Recursive
func fibRec(n: Int): Int {
    if (n <= 1) { n }
    else { fibRec(n - 1) + fibRec(n - 2) }
};

# 2. With iterate
fibs = iterate(\\pair { (pair(1), pair(0) + pair(1)) }, (0, 1))
       | map(\\p { p(0) })
       | take(10)
       | collect;

# 3. Imperative with mutable vars
func fibLoop(n: Int): Int {
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

loop10 = 0..9 | map(fibLoop[Int]) | collect;

[fibRec(9), fibs(9) | unwrap, loop10(9) | unwrap]`,
        },
    },
    quicksort: {
        label: "Quicksort",
        files: {
            "main.gema": `# Quicksort using functional style
func quicksort(iter: Iter[Int]): Iter[Int] {
    first = iter(0);
    if isnone(first){
        iter
    } else {
        pivot = unwrap(first);
        rest = (drop(1, iter));
        left = filter(\\x { x <= pivot }, rest);
        right = filter(\\x { x > pivot }, rest);
        quicksort(left) + [pivot] + quicksort(right)
    }
};

unsorted = [3, 7, 8, 5, 2, 1, 9, 6, 4];
quicksort(unsorted) | collect`,
        },
    },
    sieve: {
        label: "Sieve of Eratosthenes",
        files: {
            "main.gema": `# Sieve of Eratosthenes using mutable arrays

func sieve(n: Int): Arr[Int] {
    mut isPrime = map(\\_ true, 0..n) | collect | trans;
    put(isPrime, 0, false);
    put(isPrime, 1, false);

    for i = (2..) {
        if i * i > n { break; }
        if (isPrime(i) | unwrap) {
            for j = step((i * 2)..n, i) {
                put(isPrime, j, false)
            }
        }
    };

    (0..n) | filter(\\x { isPrime(x) | unwrap }) | collect
};

sieve(50)`,
        },
    },
    fbpipeline: {
        label: "Functional Pipeline",
        files: {
            "main.gema": `# A functional pipeline: compute sum of squares of even
# numbers from 1..100, using pipe and lambdas.

result = 1..100
    | filter(\\x { x % 2 == 0 })    # keep evens
    | map(\\x { x * x })              # square them
    | reduce(\\(acc, x) { acc + x }, 0) # sum

# Same thing expressed more concisely:
result2 = reduce(\\(acc, x) {
    if x % 2 == 0 { acc + x * x } else { acc }
}, 0, 1..100);

result == result2`,
        },
    },
    primeFactors: {
        label: "Prime Factorization",
        files: {
            "main.gema": `# Prime factorization using recursion and iteration

func smallestFactor(n: Int): Int {
    if (n % 2 == 0) { 2 }
    else {
        factors = (3..)
            | takeWhile(\\x { x * x <= n})
            | filter(\\x { n % x == 0 });
        unwrap(factors(0), n)
    }
};

func factors(n: Int): Arr[Int] {
    if (n <= 1) { []:Int }
    else {
        sf = smallestFactor(n);
        [sf] + factors(n / sf)
    }
};

factors(84)`,
        },
    },
    wordCount: {
        label: "Word Frequency",
        files: {
            "main.gema": `# Count word frequencies using Dict and functional combinators

# Sample text as an array of words
words = ["the", "quick", "brown", "fox", "jumps", "over",
         "the", "lazy", "dog", "the", "fox"];

# Build a frequency dict manually
func countWords(words: Arr[Str]): Dict[Str, Int] {
    freq = trans(Dict([]:Tuple[Str, Int]));
    for w = words {
        count = freq(w);
        put(freq, w, (if isnone(count) { 0 } else { unwrap(count) }) + 1)
    };
    detrans(freq)
};

freq = countWords(words);

(
  freq("the") | unwrap,   # 3
  freq("fox") | unwrap,   # 2
)`,
        },
    },
    generics: {
        label: "Generic Functions",
        files: {
            "main.gema": `# Generic functions with trait bounds

trait Concatenatable {
  concat[(a: Self, b: Self): Self],
}

# Generic: works with any Concatenatable type
func tacnoc(a: T, b: T): T where T is Concatenatable {
  concat(b, a)
}

# Implement for strings
func concat(a: Str, b: Str) { a + b };
tacnoc("hello", "there")

# Implement for integers (digit concatenation)
func concat(a: Int, b: Int) {
  func getNDigits(x: Int, n: Int): Int {
    if x <= 0 { n }
    else { getNDigits(x / 10, n + 1) }
  };
  a * 10 ^ getNDigits(b, 0) + b
};
tacnoc(123, 45)

# Implement for a struct
struct Pair { first: Int, second: Int }
func concat(a: Pair, b: Pair) {
  Pair(concat(a.first, b.first), concat(a.second, b.second))
};
tacnoc(Pair(1, 2), Pair(34, 56))`,
        },
    },
    mandelbrot: {
        label: "Mandelbrot set",
        files: {
            "main.gema": `# ASCII Mandelbrot set visualization

# Import module with definition and basic functions for a Complex type
use "complex.gema"

func mandelIter(z: Complex, c: Complex, i: Int): Bool {
    if (i <= 0) { abs2(z) < 4.0 }
    else { mandelIter(z * c, c, i - 1) }
}

func isMandel(c: Complex): Bool {
    mandelIter(Complex(0.0, 0.0), c, 20)
}

func linspace(a: Float, b: Float, n: Int): Iter[Float] {
    step = (b - a) / toFloat(n - 1);
    map(\\i { a + step * toFloat(i) }, 0..(n - 1))
}

func concat(strs: Iter[Str]) {
    reduce(\\(acc, x) { acc + x }, "", strs)
}

func toStr(arr: Iter[Bool]) {
    strs = map(\\x { if x { "*" } else { " " } }, arr);
    concat(strs) + "\\n"
}

grid = concat(map(\\y {
    xs = collect(linspace(-1.75, 0.25, 39));
    toStr(map(\\x { isMandel(Complex(x, y)) }, xs))
}, collect(linspace(-1., 1., 39))));
grid`,
        "complex.gema": `struct Complex { re: Float, im: Float }

func add(a: Complex, b: Complex): Complex {
    Complex(a.re + b.re, a.im + b.im)
}

func multiply(z: Complex, c: Complex): Complex {
    Complex(c.re + z.re * z.re - z.im * z.im,
            c.im + 2.0 * z.re * z.im)
}

func abs2(z: Complex): Float { z.re * z.re + z.im * z.im }`
        },
    },
};
