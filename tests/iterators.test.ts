import { test } from "bun:test";

import {
    testCompile,
    testParse,
    testParseExpectError,
    requireIdenticalCompilation,
} from "./helpers";

test("compile map iterator", () => {
    testCompile(`collect(map(func(x: Num) { x + 1 }, [1, 2, 3]))`, [2, 3, 4]);
    testCompile(
        `
        func foo(x: Num): Num {
            x
        };
        
        collect(map(foo[Num], [1, 2, 3]))
        `,
        [1, 2, 3]
    );
    testCompile(
        `
        add1 = func(x: Num) {
            x + 1
        };
        iter = map(
            add1,
            map(add1, [1, 2, 3])
        );

        collect(iter)
        `,
        [3, 4, 5]
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
        iter = filter(func(x: Num): Bool { x % 2 == 0 }, [1, 2, 3, 4, 5]);
        collect(iter)
        `,
        [2, 4]
    );
});

test("compile reduce expression", () => {
    testCompile(
        `
        reduce(
            func(x: Num, y: Num) {
                x * y    
            },
            1,
            [1, 2, 3]
        )
        `,
        6
    );
    testCompile(
        `
        reduce(func(x: Num, y: Num): Num { x + y }, 0, [1, 2, 3])
        `,
        6
    );
    testCompile(
        `
        func sum(x: Iter[Num]): Num {
            reduce(func(a: Num, b: Num) { a + b }, 0, x)
        }

        sum(range(0, 100))
        `,
        5050
    );
});

test("compile iterator indexed access", () => {
    testCompile("x = range(0, 1); x(0)", 0);
    testCompile("x = range(0, 1)(0)", 0);
    testCompile("map(func(x: Num){x}, [1,2,3])(1)", 2);
});

test("compile take", () => {
    // take(n, iter) — first n elements
    testCompile("collect(take(3, range(0, 5)))", [0, 1, 2]);
    testCompile("collect(take(0, range(0, 5)))", []);
    testCompile("collect(take(2, [1, 2, 3, 4]))", [1, 2]);
    // Take more than available
    testCompile("collect(take(10, range(0, 3)))", [0, 1, 2, 3]);
    // Chaining with other iterator ops
    testCompile("collect(take(2, map(func(x: Num){ x * 2 }, [1, 2, 3, 4])))", [2, 4]);
});

test("compile takeWhile", () => {
    // takeWhile(pred, iter) — elements while predicate is true
    testCompile(`collect(takeWhile(func(x: Num): Bool { x < 3 }, range(0, 10)))`, [0, 1, 2]);
    testCompile(`collect(takeWhile(func(x: Num): Bool { x < 3 }, [1, 2, 3, 4, 5]))`, [1, 2]);
    // Predicate fails immediately
    testCompile(`collect(takeWhile(func(x: Num): Bool { x > 5 }, [1, 2, 3]))`, []);
});

test("compile drop", () => {
    // drop(n, iter) — skip first n elements
    testCompile("collect(drop(2, range(0, 5)))", [2, 3, 4, 5]);
    testCompile("collect(drop(2, [1, 2, 3, 4]))", [3, 4]);
    testCompile("collect(drop(0, [1, 2, 3]))", [1, 2, 3]);
    // Drop more than available
    testCompile("collect(drop(10, range(0, 3)))", []);
});

test("compile dropWhile", () => {
    // dropWhile(pred, iter) — skip elements while predicate is true
    testCompile(`collect(dropWhile(func(x: Num): Bool { x < 3 }, [1, 2, 3, 4, 5]))`, [3, 4, 5]);
    testCompile(`collect(dropWhile(func(x: Num): Bool { x < 2 }, range(0, 5)))`, [2, 3, 4, 5]);
    // Predicate fails immediately — nothing dropped
    testCompile(`collect(dropWhile(func(x: Num): Bool { x > 5 }, [1, 2, 3]))`, [1, 2, 3]);
});

test("compile iterate", () => {
    // iterate(f, start) — start, f(start), f(f(start)), ...
    const take5 = `take(5, iterate(func(x: Num): Num { x + 1 }, 0))`;
    testCompile(`collect(${take5})`, [0, 1, 2, 3, 4]);

    const take3 = `take(3, iterate(func(x: Num): Num { x * 2 }, 1))`;
    testCompile(`collect(${take3})`, [1, 2, 4]);
});

test("compile last", () => {
    // last(iter) — last element
    testCompile("last([1, 2, 3])", 3);
    testCompile("last([42])", 42);
    testCompile("last(range(0, 5))", 5);
    testCompile("last([]:Num) | unwrap(0)", 0);
});

test("compile head", () => {
    // last(iter) — last element
    testCompile("head([1, 2, 3])", 1);
    testCompile("head([42])", 42);
    testCompile("head(range(0, 5))", 0);
    testCompile("head([]:Num) | unwrap(0)", 0);
});

test("compile length", () => {
    // length(iter) — number of elements
    testCompile("length([1, 2, 3])", 3);
    testCompile("length([]: Num)", 0);
    testCompile("length(range(0, 5))", 6);
    testCompile("length(range(100, 0))", 0);
});

test("compile repeated use of iterator", () => {
    testCompile(
        `
        x = range(1, 3);

        [x(0), x(2), x(1)]
    `,
        [1, 3, 2]
    );
    testCompile(
        `
        x = range(1, 3);

        collect(x);
        collect(x)
    `,
        [1, 2, 3]
    );
    testCompile(
        `
        x = range(1, 3);
        y = map(func(i: Num){ i + 1 }, x);

        collect(x);
        collect(y)
    `,
        [2, 3, 4]
    );
    testCompile(
        `
        x = range(1, 3);
        y = map(func(i: Num){ i + 1 }, x);

        collect(y);
        collect(x)
    `,
        [1, 2, 3]
    );
    testCompile(
        `
        x = range(1, 3);
        y = reduce(func(acc: Num, x: Num){acc+x}, 0, x);

        y + reduce(func(acc: Num, x: Num){acc+x}, 0, x)
    `,
        12
    );
});

test("compile fallback on functions with Iter params when calling with Arr", () => {
    // Tests the combination of both features:
    //   1. Nested generic type Iter[T] in the signature
    //   2. Auto array-to-iterator conversion (Arr[Num] → Iter[Num])
    testCompile(
        `
        func foo(x: Iter[Num]) { reduce(func(acc: Num, x: Num){acc+x}, 0, [1,2,3]) }

        foo([1,2,3])
     `,
        6
    );
    // If Arr signature is available, this is the one that should be used
    testCompile(
        `
        func matches(x: Arr[Num]) { true }

        func matches(x: Iter[Num]) { false }

        matches([1])
    `,
        true
    );
});

test("compile function with nested generic type", () => {
    testCompile(
        `
        trait Any {}

        func getLength(arr: Arr[T]): Num where T is Any {
            reduce(func(acc: Num, x: T) { acc + 1 }, 0, arr)
        }

        getLength([1,2,3])
    `,
        3
    );
    testCompile(
        `
        trait Summable {
            sum[(a: Self, b: Self): Self],
        }

        func computeSum(arr: Arr[T]): T where T is Summable {
            reduce(func(acc: T, x: T) { sum(acc, x) }, 0, arr)
        }

        func sum(x: Num, y: Num): Num {
            x + y
        }

        computeSum([1,2,3])
    `,
        6
    );
    // Tests the combination of both features:
    //   1. Nested generic type Iter[T] in the signature
    //   2. Auto array-to-iterator conversion (Arr[Num] → Iter[Num])
    testCompile(
        `
        trait Summable {
            sum[(a: Self, b: Self): Self],
        }

        func sum(iter: Iter[T], start: T): T where T is Summable {
            reduce(func(acc: T, x: T) { sum(acc, x) }, start, iter)
        }

        func sum(a: Num, b: Num): Num {
            a + b
        }

        sum([1, 2, 3], 0)
    `,
        6
    );
    testCompile(
        `
        trait Concat {
            concat[(a: Self, b: Self): Self],
        }

        func join(iter: Iter[T], start: T): T where T is Concat {
            reduce(func(acc: T, x: T) { concat(acc, x) }, start, iter)
        }

        func concat(a: Arr[Num], b: Arr[Num]): Arr[Num] {
            a + b
        }

        join([[1,2], [3,4], [5,6]], []: Num)
    `,
        [1, 2, 3, 4, 5, 6]
    );
});

test("parse filter iterator", () => {
    testParseExpectError(`
        func myFilter(x: Num): Num {
            x + 1
        };
        collect(filter(myFilter, [1, 2, 3]))
    `);
});

test("parse reduce expression", () => {
    testParseExpectError(`
        func add(x: Num, y: Num): Num {
            x + y
        };
        collect(filter(myFilter, [1., 2., 3.], 0))
    `);
    testParseExpectError(`
        func add(x: Num, y: Num): Num {
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
    testCompile("collect(1..5)", [1, 2, 3, 4, 5]);
    testCompile("collect(0..3)", [0, 1, 2, 3]);
});

test("range syntax: a..b inclusive matches range(a, b)", () => {
    requireIdenticalCompilation("collect(1..5)", "collect(range(1, 5))");
    requireIdenticalCompilation("collect(0..10)", "collect(range(0, 10))");
});

test("range syntax: a..b with expression bounds", () => {
    testCompile("x = 2; collect(x..x + 2)", [2, 3, 4]);
});

test("range syntax: precedence i..i*2+1", () => {
    // Should parse as i..(i*2+1), not (i..i)*2+1
    testCompile("i = 3; collect(i..i*2+1)", [3, 4, 5, 6, 7]);
});

test("range syntax: ..b (with no start value) is not legal", () => {
    testParseExpectError("..5");
    testParseExpectError("(..5)");
});

test("range syntax: a.. (infinite from a, take n)", () => {
    testParse("3..");
    testCompile("collect(take(3, 3..))", [3, 4, 5]);
});

test("range syntax: a..b in map/filter/reduce", () => {
    testCompile("collect(map(\\x { x * 2 }, 1..3))", [2, 4, 6]);
    testCompile("collect(filter(\\x { x > 2 }, 1..5))", [3, 4, 5]);
    testCompile("reduce(\\(acc, x) { acc + x }, 0, 1..5)", 15);
});

test("range syntax: a..b in pipe", () => {
    testCompile("1..5 | collect", [1, 2, 3, 4, 5]);
    testCompile("1..5 | map(\\x { x * 2 }) | collect", [2, 4, 6, 8, 10]);
});

test("range syntax: step(stepSize, iter)", () => {
    testCompile("collect(step(2, 1..10))", [1, 3, 5, 7, 9]);
    testCompile("collect(step(3, 0..10))", [0, 3, 6, 9]);
    testCompile("collect(step(3, range(0, 10)))", [0, 3, 6, 9]);
});

test("range syntax: error a..b where a > b", () => {
    // Should produce empty range
    testCompile("collect(5..1)", []);
});

test("iterator concatenation with + operator", () => {
    testCompile("(0..2) + (0..2) | collect", [0, 1, 2, 0, 1, 2]);
    testCompile("(0..2) + map(\\x x, 0..2) | collect", [0, 1, 2, 0, 1, 2]);
    testParseExpectError("(0..2) + map(\\x toNum(x), 0..2)");
});

test("iter: contains", () => {
    testCompile("contains(3, range(0, 5))", true);
    testCompile("contains(99, range(0, 5))", false);
});

test("iter: find", () => {
    testCompile("unwrap(find(3, 1..5))", 2);
    testCompile("isnone(find(99, 1..5))", true);
});

// ============================================================
// New iterator builtins
// ============================================================

test("repeat: basic repeat", () => {
    testCompile("collect(repeat(2, [1, 2, 3]))", [1, 2, 3, 1, 2, 3]);
    testCompile("collect(repeat(1, [1, 2]))", [1, 2]);
});

test("repeat: infinite repeat (n <= 0), take n", () => {
    testCompile("collect(take(5, repeat(0, [1, 2])))", [1, 2, 1, 2, 1]);
});

test("repeatInner: basic repeat inner", () => {
    testCompile("collect(repeatInner(3, [1, 2, 3]))", [1, 1, 1, 2, 2, 2, 3, 3, 3]);
    testCompile("collect(repeatInner(1, [1, 2]))", [1, 2]);
});

test("cartesian: two iterators", () => {
    testCompile("collect(cartesian([1, 2], [3, 4]))", [
        [1, 3],
        [1, 4],
        [2, 3],
        [2, 4],
    ]);
});

test("cartesian: three iterators", () => {
    testCompile("collect(cartesian([1, 2], [3], [4, 5]))", [
        [1, 3, 4],
        [1, 3, 5],
        [2, 3, 4],
        [2, 3, 5],
    ]);
});

test("permutations: small set", () => {
    testCompile("collect(permutations([1, 2, 3]))", [
        [1, 2, 3],
        [1, 3, 2],
        [2, 1, 3],
        [2, 3, 1],
        [3, 1, 2],
        [3, 2, 1],
    ]);
});

test("permutations: single element", () => {
    testCompile("collect(permutations([42]))", [[42]]);
});

test("combinations: pick 2 from 4", () => {
    testCompile("collect(combinations(2, [1, 2, 3, 4]))", [
        [1, 2],
        [1, 3],
        [1, 4],
        [2, 3],
        [2, 4],
        [3, 4],
    ]);
});

test("combinations: pick 1 from 3", () => {
    testCompile("collect(combinations(1, [1, 2, 3]))", [[1], [2], [3]]);
});

test("combinations: pick 1 (Int) from 3", () => {
    testCompile("collect(combinations(1i, [1, 2, 3]))", [[1], [2], [3]]);
});

test("combinations: pick all", () => {
    testCompile("collect(combinations(3, [1, 2, 3]))", [[1, 2, 3]]);
});

test("toIter: array to iterator", () => {
    testCompile("collect(toIter([1, 2, 3]))", [1, 2, 3]);
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
x | filter(\\i contains(i, x)) | collect`,
        [1, 2, 3]
    );
});

test("toIter Dict", () => {
    testCompile('collect(toIter(Dict([(1, "a"), (2, "b")])))', [
        [1, "a"],
        [2, "b"],
    ]);
});

test("toIter Set", () => {
    testCompile("collect(toIter(Set([1, 2, 3])))", [1, 2, 3]);
});

test("toArr Dict", () => {
    testCompile('toArr(Dict([(1, "a"), (2, "b")]))', [
        [1, "a"],
        [2, "b"],
    ]);
});

test("toArr Set", () => {
    testCompile("toArr(Set([1, 2, 3]))", [1, 2, 3]);
});

test("toArr Str", () => {
    testCompile('toArr("abc")', ["a", "b", "c"]);
});
