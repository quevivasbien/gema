import { test } from "bun:test";

import { testCompile, testParse, testParseExpectError } from "./helpers";

test("compile map iterator", () => {
    testCompile(`@map(func(x: Int) { x + 1 }, [1, 2, 3])`, [2n, 3n, 4n]);
    testCompile(
        `
        func foo(x: Int): Int {
            x
        };
        
        @map(foo, [1, 2, 3])
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

        @iter
        `,
        [3n, 4n, 5n]
    );
    testCompile(
        `
        arr = ["hello", "there"];
        iter = map(arr, [1, 1, 0]);
        @iter
        `,
        ["there", "there", "hello"]
    );
});

test("compile filter iterator", () => {
    testCompile(
        `
        func isEven(x: Int): Bool {
            x % 2 == 0
        };
        iter = filter(isEven, [1, 2, 3, 4, 5]);
        @iter
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
        func add(x: Int, y: Int): Int {
            x + y
        };
        reduce(add, 0, [1, 2, 3])
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
    testCompile("@take(3, range(0, 5))", [0n, 1n, 2n]);
    testCompile("@take(0, range(0, 5))", []);
    testCompile("@take(2, [1, 2, 3, 4])", [1n, 2n]);
    // Take more than available
    testCompile("@take(10, range(0, 3))", [0n, 1n, 2n, 3n]);
    // Chaining with other iterator ops
    testCompile("@take(2, map(func(x: Int){ x * 2 }, [1, 2, 3, 4]))", [2n, 4n]);
});

test("compile takeWhile", () => {
    // takeWhile(pred, iter) — elements while predicate is true
    testCompile(`@takeWhile(func(x: Int): Bool { x < 3 }, range(0, 10))`, [0n, 1n, 2n]);
    testCompile(`@takeWhile(func(x: Int): Bool { x < 3 }, [1, 2, 3, 4, 5])`, [1n, 2n]);
    // Predicate fails immediately
    testCompile(`@takeWhile(func(x: Int): Bool { x > 5 }, [1, 2, 3])`, []);
});

test("compile drop", () => {
    // drop(n, iter) — skip first n elements
    testCompile("@drop(2, range(0, 5))", [2n, 3n, 4n, 5n]);
    testCompile("@drop(2, [1, 2, 3, 4])", [3n, 4n]);
    testCompile("@drop(0, [1, 2, 3])", [1n, 2n, 3n]);
    // Drop more than available
    testCompile("@drop(10, range(0, 3))", []);
});

test("compile dropWhile", () => {
    // dropWhile(pred, iter) — skip elements while predicate is true
    testCompile(`@dropWhile(func(x: Int): Bool { x < 3 }, [1, 2, 3, 4, 5])`, [3n, 4n, 5n]);
    testCompile(`@dropWhile(func(x: Int): Bool { x < 2 }, range(0, 5))`, [2n, 3n, 4n, 5n]);
    // Predicate fails immediately — nothing dropped
    testCompile(`@dropWhile(func(x: Int): Bool { x > 5 }, [1, 2, 3])`, [1n, 2n, 3n]);
});

test("compile iterate", () => {
    // iterate(f, start) — start, f(start), f(f(start)), ...
    const take5 = `take(5, iterate(func(x: Int): Int { x + 1 }, 0))`;
    testCompile(`@${take5}`, [0n, 1n, 2n, 3n, 4n]);

    const take3 = `take(3, iterate(func(x: Int): Int { x * 2 }, 1))`;
    testCompile(`@${take3}`, [1n, 2n, 4n]);
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

        @x;
        @x
    `,
        [1n, 2n, 3n]
    );
    testCompile(
        `
        x = range(1, 3);
        y = map(func(i: Int){ i + 1 }, x);

        @x;
        @y
    `,
        [2n, 3n, 4n]
    );
    testCompile(
        `
        x = range(1, 3);
        y = map(func(i: Int){ i + 1 }, x);

        @y;
        @x
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
        @filter(myFilter, [1, 2, 3])
    `);
});

test("parse reduce expression", () => {
    testParseExpectError(`
        func add(x: Int, y: Int): Int {
            x + y
        };
        @filter(myFilter, [1., 2., 3.], 0)
    `);
    testParseExpectError(`
        func add(x: Int, y: Int): Int {
            x + y
        };
        @filter(myFilter, [1, 2, 3], false)
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
