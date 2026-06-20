import { test } from "bun:test";

import {
    testCompile,
    testParse,
    testParseExpectError,
    requireIdenticalCompilation,
} from "./helpers";

test("compile map iterator", () => {
    testCompile(`collect(map(func(x: Int) { x + 1 }, [1, 2, 3]))`, [2n, 3n, 4n]);
    testCompile(
        `
        func foo(x: Int): Int {
            x
        };
        
        collect(map(foo[Int], [1, 2, 3]))
        `,
        [1n, 2n, 3n]
    );
    testCompile(
        `
        add1 = func(x: Int) {
            x + 1
        };
        iter = map(
            add1,
            map(add1, [1, 2, 3])
        );

        collect(iter)
        `,
        [3n, 4n, 5n]
    );
    testCompile(
        `
        arr = ["hello", "there"];
        iter = map(arr, [1, 1, 0]);
        collect(iter)
        `,
        ["there", "there", "hello"]
    );
});

test("compile filter iterator", () => {
    testCompile(
        `
        iter = filter(func(x: Int): Bool { x % 2 == 0 }, [1, 2, 3, 4, 5]);
        collect(iter)
        `,
        [2n, 4n]
    );
});

test("compile reduce expression", () => {
    testCompile(
        `
        reduce(
            func(x: Int, y: Int) {
                x * y    
            },
            1,
            [1, 2, 3]
        )
        `,
        6n
    );
    testCompile(
        `
        reduce(func(x: Int, y: Int): Int { x + y }, 0, [1, 2, 3])
        `,
        6n
    );
    testCompile(
        `
        func sum(x: Iter[Int]): Int {
            reduce(func(a: Int, b: Int) { a + b }, 0, x)
        }

        sum(range(0, 100))
        `,
        5050n
    );
});

test("compile iterator indexed access", () => {
    testCompile("x = range(0, 1); x(0)", 0n);
    testCompile("x = range(0, 1)(0)", 0n);
    testCompile("map(func(x: Int){x}, [1,2,3])(1)", 2n);
});

test("compile take", () => {
    // take(n, iter) — first n elements
    testCompile("collect(take(3, range(0, 5)))", [0n, 1n, 2n]);
    testCompile("collect(take(0, range(0, 5)))", []);
    testCompile("collect(take(2, [1, 2, 3, 4]))", [1n, 2n]);
    // Take more than available
    testCompile("collect(take(10, range(0, 3)))", [0n, 1n, 2n, 3n]);
    // Chaining with other iterator ops
    testCompile("collect(take(2, map(func(x: Int){ x * 2 }, [1, 2, 3, 4])))", [2n, 4n]);
});

test("compile takeWhile", () => {
    // takeWhile(pred, iter) — elements while predicate is true
    testCompile(`collect(takeWhile(func(x: Int): Bool { x < 3 }, range(0, 10)))`, [0n, 1n, 2n]);
    testCompile(`collect(takeWhile(func(x: Int): Bool { x < 3 }, [1, 2, 3, 4, 5]))`, [1n, 2n]);
    // Predicate fails immediately
    testCompile(`collect(takeWhile(func(x: Int): Bool { x > 5 }, [1, 2, 3]))`, []);
});

test("compile drop", () => {
    // drop(n, iter) — skip first n elements
    testCompile("collect(drop(2, range(0, 5)))", [2n, 3n, 4n, 5n]);
    testCompile("collect(drop(2, [1, 2, 3, 4]))", [3n, 4n]);
    testCompile("collect(drop(0, [1, 2, 3]))", [1n, 2n, 3n]);
    // Drop more than available
    testCompile("collect(drop(10, range(0, 3)))", []);
});

test("compile dropWhile", () => {
    // dropWhile(pred, iter) — skip elements while predicate is true
    testCompile(`collect(dropWhile(func(x: Int): Bool { x < 3 }, [1, 2, 3, 4, 5]))`, [3n, 4n, 5n]);
    testCompile(`collect(dropWhile(func(x: Int): Bool { x < 2 }, range(0, 5)))`, [2n, 3n, 4n, 5n]);
    // Predicate fails immediately — nothing dropped
    testCompile(`collect(dropWhile(func(x: Int): Bool { x > 5 }, [1, 2, 3]))`, [1n, 2n, 3n]);
});

test("compile iterate", () => {
    // iterate(f, start) — start, f(start), f(f(start)), ...
    const take5 = `take(5, iterate(func(x: Int): Int { x + 1 }, 0))`;
    testCompile(`collect(${take5})`, [0n, 1n, 2n, 3n, 4n]);

    const take3 = `take(3, iterate(func(x: Int): Int { x * 2 }, 1))`;
    testCompile(`collect(${take3})`, [1n, 2n, 4n]);
});

test("compile last", () => {
    // last(iter) — last element
    testCompile("last([1, 2, 3])", 3n);
    testCompile("last([42])", 42n);
    testCompile("last(range(0, 5))", 5n);
});

test("compile length", () => {
    // length(iter) — number of elements
    testCompile("length([1, 2, 3])", 3n);
    testCompile("length([]: Int)", 0n);
    testCompile("length(range(0, 5))", 6n);
    testCompile("length(range(100, 0))", 0n);
});

test("compile repeated use of iterator", () => {
    testCompile(
        `
        x = range(1, 3);

        [x(0), x(2), x(1)]
    `,
        [1n, 3n, 2n]
    );
    testCompile(
        `
        x = range(1, 3);

        collect(x);
        collect(x)
    `,
        [1n, 2n, 3n]
    );
    testCompile(
        `
        x = range(1, 3);
        y = map(func(i: Int){ i + 1 }, x);

        collect(x);
        collect(y)
    `,
        [2n, 3n, 4n]
    );
    testCompile(
        `
        x = range(1, 3);
        y = map(func(i: Int){ i + 1 }, x);

        collect(y);
        collect(x)
    `,
        [1n, 2n, 3n]
    );
    testCompile(
        `
        x = range(1, 3);
        y = reduce(func(acc: Int, x: Int){acc+x}, 0, x);

        y + reduce(func(acc: Int, x: Int){acc+x}, 0, x)
    `,
        12n
    );
});

test("compile fallback on functions with Iter params when calling with Arr", () => {
    // Tests the combination of both features:
    //   1. Nested generic type Iter[T] in the signature
    //   2. Auto array-to-iterator conversion (Arr[Int] → Iter[Int])
    testCompile(
        `
        func foo(x: Iter[Int]) { reduce(func(acc: Int, x: Int){acc+x}, 0, [1,2,3]) }

        foo([1,2,3])
     `,
        6n
    );
    // If Arr signature is available, this is the one that should be used
    testCompile(
        `
        func matches(x: Arr[Int]) { true }

        func matches(x: Iter[Int]) { false }

        matches([1])
    `,
        true
    );
});

test("compile function with nested generic type", () => {
    testCompile(
        `
        trait Any {}

        func getLength(arr: Arr[T]): Int where T is Any {
            reduce(func(acc: Int, x: T) { acc + 1 }, 0, arr)
        }

        getLength([1,2,3])
    `,
        3n
    );
    testCompile(
        `
        trait Summable {
            sum[(a: Self, b: Self): Self],
        }

        func computeSum(arr: Arr[T]): T where T is Summable {
            reduce(func(acc: T, x: T) { sum(acc, x) }, 0, arr)
        }

        func sum(x: Int, y: Int): Int {
            x + y
        }

        computeSum([1,2,3])
    `,
        6n
    );
    // Tests the combination of both features:
    //   1. Nested generic type Iter[T] in the signature
    //   2. Auto array-to-iterator conversion (Arr[Int] → Iter[Int])
    testCompile(
        `
        trait Summable {
            sum[(a: Self, b: Self): Self],
        }

        func sum(iter: Iter[T], start: T): T where T is Summable {
            reduce(func(acc: T, x: T) { sum(acc, x) }, start, iter)
        }

        func sum(a: Int, b: Int): Int {
            a + b
        }

        sum([1, 2, 3], 0)
    `,
        6n
    );
    testCompile(
        `
        trait Concat {
            concat[(a: Self, b: Self): Self],
        }

        func join(iter: Iter[T], start: T): T where T is Concat {
            reduce(func(acc: T, x: T) { concat(acc, x) }, start, iter)
        }

        func concat(a: Arr[Int], b: Arr[Int]): Arr[Int] {
            a + b
        }

        join([[1,2], [3,4], [5,6]], []: Int)
    `,
        [1n, 2n, 3n, 4n, 5n, 6n]
    );
});

test("parse filter iterator", () => {
    testParseExpectError(`
        func myFilter(x: Int): Int {
            x + 1
        };
        collect(filter(myFilter, [1, 2, 3]))
    `);
});

test("parse reduce expression", () => {
    testParseExpectError(`
        func add(x: Int, y: Int): Int {
            x + y
        };
        collect(filter(myFilter, [1., 2., 3.], 0))
    `);
    testParseExpectError(`
        func add(x: Int, y: Int): Int {
            x + y
        };
        collect(filter(myFilter, [1, 2, 3], false))
    `);
});

test("parse fallback on functions with Iter params when calling with Arr", () => {
    testParse(`
        func toStr(iter: Iter[Bool]) {
            strs = map(func(x: Bool){ if x { "*" } else { " " }}, iter);
            reduce(func(acc:Str, x:Str){acc+x}, "", strs)
        }

        toStr([false, true, false, true])
    `);
});

// ============================================================
// Range syntax (..)
// ============================================================

test("range syntax: basic a..b", () => {
    testParse("1..5");
    testCompile("collect(1..5)", [1n, 2n, 3n, 4n, 5n]);
    testCompile("collect(0..3)", [0n, 1n, 2n, 3n]);
});

test("range syntax: a..b inclusive matches range(a, b)", () => {
    requireIdenticalCompilation("collect(1..5)", "collect(range(1, 5))");
    requireIdenticalCompilation("collect(0..10)", "collect(range(0, 10))");
});

test("range syntax: a..b with expression bounds", () => {
    testCompile("x = 2; collect(x..x + 2)", [2n, 3n, 4n]);
});

test("range syntax: precedence i..i*2+1", () => {
    // Should parse as i..(i*2+1), not (i..i)*2+1
    testCompile("i = 3; collect(i..i*2+1)", [3n, 4n, 5n, 6n, 7n]);
});

test("range syntax: empty ..b (from 0 to b)", () => {
    testParse("..5");
    testCompile("collect(..5)", [0n, 1n, 2n, 3n, 4n, 5n]);
});

test("range syntax: a.. (infinite from a, take n)", () => {
    testParse("3..");
    testCompile("collect(take(3, 3..))", [3n, 4n, 5n]);
});

test("range syntax: .. (infinite from 0, take n)", () => {
    testParse("..");
    testCompile("collect(take(3, ..))", [0n, 1n, 2n]);
});

test("range syntax: a..b in map/filter/reduce", () => {
    testCompile("collect(map(\\x { x * 2 }, 1..3))", [2n, 4n, 6n]);
    testCompile("collect(filter(\\x { x > 2 }, 1..5))", [3n, 4n, 5n]);
    testCompile("reduce(\\(acc, x) { acc + x }, 0, 1..5)", 15n);
});

test("range syntax: a..b in pipe", () => {
    testCompile("1..5 | collect", [1n, 2n, 3n, 4n, 5n]);
    testCompile("1..5 | map(\\x { x * 2 }) | collect", [2n, 4n, 6n, 8n, 10n]);
});

test("range syntax: step(iter, stepSize)", () => {
    testCompile("collect(step(1..10, 2))", [1n, 3n, 5n, 7n, 9n]);
    testCompile("collect(step(0..10, 3))", [0n, 3n, 6n, 9n]);
    testCompile("collect(step(range(0, 10), 3))", [0n, 3n, 6n, 9n]);
});

test("range syntax: error a..b where a > b", () => {
    // Should produce empty range
    testCompile("collect(5..1)", []);
});

test("iterator concatenation with + operator", () => {
    testCompile("(0..2) + (0..2) | collect", [0n, 1n, 2n, 0n, 1n, 2n]);
    testCompile("(0..2) + map(\\x x, 0..2) | collect", [0n, 1n, 2n, 0n, 1n, 2n]);
    testParseExpectError("(0..2) + map(\\x toFloat(x), 0..2)");
});

test("iterator concatenation with + operator, one side is array", () => {
    // Iter plus Arr gives an iter
    testCompile("(0..2) + [0, 1, 2] | collect", [0n, 1n, 2n, 0n, 1n, 2n]);
    // Arr plus Iter is not legal -- intended pattern is to collect the RHS first to get an array or swap order if you do want an iterator
    testParseExpectError("[0, 1, 2] + (0..2) | collect");
});

test("iter: contains", () => {
    testCompile("contains(range(0, 5), 3)", true);
    testCompile("contains(range(0, 5), 99)", false);
});

test("iter: find", () => {
    testCompile("unwrap(find(1..5, 3))", 2n);
    testCompile("isnone(find(1..5, 99))", true);
});

// ============================================================
// New iterator builtins
// ============================================================

test("repeat: basic repeat", () => {
    testCompile("collect(repeat(2, [1, 2, 3]))", [1n, 2n, 3n, 1n, 2n, 3n]);
    testCompile("collect(repeat(1, [1, 2]))", [1n, 2n]);
});

test("repeat: infinite repeat (n <= 0), take n", () => {
    testCompile("collect(take(5, repeat(0, [1, 2])))", [1n, 2n, 1n, 2n, 1n]);
});

test("repeatInner: basic repeat inner", () => {
    testCompile("collect(repeatInner(3, [1, 2, 3]))", [1n, 1n, 1n, 2n, 2n, 2n, 3n, 3n, 3n]);
    testCompile("collect(repeatInner(1, [1, 2]))", [1n, 2n]);
});

test("cartesian: two iterators", () => {
    testCompile("collect(cartesian([1, 2], [3, 4]))", [
        [1n, 3n],
        [1n, 4n],
        [2n, 3n],
        [2n, 4n],
    ]);
});

test("cartesian: three iterators", () => {
    testCompile("collect(cartesian([1, 2], [3], [4, 5]))", [
        [1n, 3n, 4n],
        [1n, 3n, 5n],
        [2n, 3n, 4n],
        [2n, 3n, 5n],
    ]);
});

test("permutations: small set", () => {
    testCompile("collect(permutations([1, 2, 3]))", [
        [1n, 2n, 3n],
        [1n, 3n, 2n],
        [2n, 1n, 3n],
        [2n, 3n, 1n],
        [3n, 1n, 2n],
        [3n, 2n, 1n],
    ]);
});

test("permutations: single element", () => {
    testCompile("collect(permutations([42]))", [[42n]]);
});

test("combinations: pick 2 from 4", () => {
    testCompile("collect(combinations([1, 2, 3, 4], 2))", [
        [1n, 2n],
        [1n, 3n],
        [1n, 4n],
        [2n, 3n],
        [2n, 4n],
        [3n, 4n],
    ]);
});

test("combinations: pick 1 from 3", () => {
    testCompile("collect(combinations([1, 2, 3], 1))", [[1n], [2n], [3n]]);
});

test("combinations: pick all", () => {
    testCompile("collect(combinations([1, 2, 3], 3))", [[1n, 2n, 3n]]);
});

test("toIter: array to iterator", () => {
    testCompile("collect(toIter([1, 2, 3]))", [1n, 2n, 3n]);
});

test("toIter: string to iterator", () => {
    testCompile('collect(toIter("abc"))', ["a", "b", "c"]);
});

test("iterator variable auto-clone: filter with contains", () => {
    // x is an iterator used both as the filter input and inside the predicate.
    // Without cloning, the inner use in contains() would consume the iterator and then reset
    // and we'd end up with an infinite loop
    testCompile(
        `x = 1..3;
x | filter(\\i contains(x, i)) | collect`,
        [1n, 2n, 3n]
    );
});
