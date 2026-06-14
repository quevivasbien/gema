import { test } from "bun:test";
import { testCompile } from "./helpers";

// ============================================================
// Sandbox preset tests — extracted from frontend/editor.js
// ============================================================

test("sandbox: FizzBuzz", () => {
    testCompile(
        `
        # Classic FizzBuzz: print Fizz for multiples of 3,
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
        `# Fibonacci sequence shown three ways

# 1. Recursive
func fibRec(n: Int): Int {
    if (n <= 1) { n }
    else { fibRec(n - 1) + fibRec(n - 2) }
};

# 2. With iterate
# iterate(fn, start) produces: start, fn(start), fn(fn(start)), ...
# We iterate a pair (a,b) → (b, a+b) to generate Fibonacci
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

# All produce the same sequence
[fibRec(9), fibs(9) | unwrap, loop10(9) | unwrap]   # all 34`,
        [34n, 34n, 34n]
    );
});

test("sandbox: Quicksort", () => {
    testCompile(
        `# Quicksort using functional style
func quicksort(arr: Arr[Int]): Arr[Int] {
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

unsorted = [3, 7, 8, 5, 2, 1, 9, 5, 4];
quicksort(unsorted)   # [1, 2, 3, 4, 5, 5, 7, 8, 9]`,
        [1n, 2n, 3n, 4n, 5n, 5n, 7n, 8n, 9n]
    );
});

test("sandbox: Sieve of Eratosthenes", () => {
    testCompile(
        `# Sieve of Eratosthenes using mutable arrays

func sieve(n: Int): Arr[Int] {
    mut isPrime = map(\\_ { true} 0..n) | collect | trans;
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

sieve(50)   # primes up to 50`,
        [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n, 41n, 43n, 47n]
    );
});

test("sandbox: Functional pipeline", () => {
    testCompile(
        `# A functional pipeline: compute sum of squares of even
# numbers from 1..100, using pipe and lambdas.

result = 1..100
    | filter(\\x { x % 2 == 0 })    # keep evens
    | map(\\x { x * x })              # square them
    | reduce(\\acc, x { acc + x }, 0) # sum

# Same thing expressed more concisely:
result2 = reduce(\\acc, x {
    if x % 2 == 0 { acc + x * x } else { acc }
}, 0, 1..100);

result == result2   # true (both are 171700)`,
        true
    );
});

test("sandbox: Prime factorization", () => {
    testCompile(
        `# Prime factorization using recursion and iteration

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

factors(84)   # [2, 2, 3, 7]`,
        [2n, 2n, 3n, 7n]
    );
});

test("sandbox: Word frequency", () => {
    testCompile(
        `# Count word frequencies using Dict and functional combinators

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

# Access individual frequencies
(
  freq("the") | unwrap,   # 3
  freq("fox") | unwrap,   # 2
)`,
        [3n, 2n]
    );
});

test("sandbox: Generic functions", () => {
    testCompile(
        `# Generic functions with trait bounds — concatenate in reverse

trait Concatenatable {
  concat[(a: Self, b: Self): Self],
}

# Generic: works with any Concatenatable type
func tacnoc(a: T, b: T): T where T is Concatenatable {
  concat(b, a)
}

# Implement for strings
func concat(a: Str, b: Str) { a + b };
tacnoc("hello", "there")                     # "therehello"

# Implement for integers (digit concatenation)
func concat(a: Int, b: Int) {
  func getNDigits(x: Int, n: Int): Int {
    if x <= 0 { n }
    else { getNDigits(x / 10, n + 1) }
  };
  a * 10 ^ getNDigits(b, 0) + b
};
tacnoc(123, 45)                              # 45123

# Implement for a struct
struct Pair { first: Int, second: Int }
func concat(a: Pair, b: Pair) {
  Pair(concat(a.first, b.first), concat(a.second, b.second))
};
func toStr(p: Pair) {
  "(" + toStr(p.first) + ", " + toStr(p.second) + ")"
};
toStr(tacnoc(Pair(1, 2), Pair(34, 56)))      # (341, 562)`,
        "(341, 562)"
    );
});

test("sandbox: Closures and state", () => {
    testCompile(
        `# Closures capture mutable variables by reference,
# enabling stateful function objects.

func makeCounter(): Func[:Int] {
    mut count = 0;
    func() { count = count + 1; count }
};

a = makeCounter();
b = makeCounter();
indep_state = [a(), a(), b(), b()];   # [1, 2, 1, 2] — independent state

# Higher-order: a function that takes a predicate
# and returns a filtered counter
func makeFilteredCounter(pred: Func[Int: Bool]): Func[:Int] {
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
            [1n, 2n, 1n, 2n],
            [0n, 2n, 0n],
        ]
    );
});
