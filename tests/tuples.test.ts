import { test } from "bun:test";

import { testCompile, testParse, testParseExpectError } from "./helpers";

// ============================================================
// Tuple literals
// ============================================================

test("tuple literal basic", () => {
    testParse('(1, "a", 3.0)');
});

test("tuple compile basic", () => {
    // A tuple that is immediately indexed must produce a literal value.
    // (1, "a")(0) should produce 1
    // We test via a simple variable first.
    testCompile('x = (1, "a", 3.0); x', [1n, "a", 3.0]);
});

test("tuple access by literal index", () => {
    testCompile('(1, "a", 3.0)(0)', 1n);
    testCompile('(1, "a", 3.0)(1)', "a");
    testCompile('(1, "a", 3.0)(2)', 3.0);
});

test("tuple access variable by literal index", () => {
    testCompile('t = (1, "a", 3.0); t(0)', 1n);
    testCompile('t = (1, "a", 3.0); t(1)', "a");
    testCompile('t = (1, "a", 3.0); t(2)', 3.0);
});

test("nested tuple", () => {
    testCompile("t = (1, (2, 3)); t(1)(1)", 3n);
});

test("tuple: function with tuple parameter", () => {
    testCompile(
        `
        func foo(t: Tuple[Int, Float, Str]) {
            toStr(t(0)) + toStr(t(1)) + t(2)
        }
        foo((1, 2.0, "3"))
        `,
        "123"
    );
});

// ============================================================
// Tuple unpacking
// ============================================================

test("tuple unpacking basic", () => {
    testCompile('(a, b) = (1, "hello"); a', 1n);
    testCompile('(a, b) = (1, "hello"); b', "hello");
});

test("tuple unpacking from variable", () => {
    testCompile('x = (1, "hello"); (a, b) = x; a', 1n);
    testCompile('x = (1, "hello"); (a, b) = x; b', "hello");
});

test("tuple unpacking with mut", () => {
    testCompile('(mut a, mut b) = (1, "hello"); a = 2; a', 2n);
    testCompile('x = (1, "hello"); (mut a, mut b) = x; a = 2; a', 2n);
    testCompile('x = (1, "hello"); (a, mut b) = x; b = "bye"; b', "bye");
});

test("tuple unpacking as expression", () => {
    // Tuple unpacking expressions should evaluate to the tuple
    testCompile('(a, b) = (1, "hello")', [1n, "hello"]);
    testCompile('(a, b) = (1, "hello")', [1n, "hello"]);
    testCompile('(mut a, mut b) = (1, "hello")', [1n, "hello"]);
});

test("assign variable equal to tuple unpacking", () => {
    // Tuple unpacking expressions should evaluate to the tuple
    testCompile('x = {(a, b) = (1, "hello")}', [1n, "hello"]);
    testCompile('x = {(a, b) = (1, "hello")}; x', [1n, "hello"]);
});

test("dropped tuple unpacking", () => {
    testParseExpectError("(a, b) = (1, 2);"); // Cannot end program on a dropped value
});

test("reassign var in tuple unpacking", () => {
    testCompile("mut x = 1; (x, y) = (2, 3); x", 2n);
    testCompile("mut x = 1; { (x, y) = (2, 3) }; x", 2n);
    testParseExpectError("x = 1; (x, y) = (2, 3); x");
});

test("tuple unpacking three elements", () => {
    testCompile("(a, b, c) = (1, 2, 3); a + b + c", 6n);
});

test("tuple unpacking on nested scope", () => {
    testCompile("(a, b, c) = { (1, 2, 3) }; a + b + c", 6n);
});

test("tuple unpacking from function", () => {
    testCompile("func foo() { (1, 2, 3) } (a, b, c) = foo(); a + b + c", 6n);
});

test.todo("tuple unpacking on nested tuple", () => {
    testCompile("t = (1, (2, 3)); (a, (b, c)) = t; c", 3n);
});

test("tuple unpacking error on non-tuple rhs", () => {
    testParseExpectError("(a, b) = 42");
});

test("tuple unpacking error on type mismatch", () => {
    testParseExpectError("(a, b) = (1, 2, 3)");
});

test("tuple: unpack tuple within body of for loop", () => {
    testCompile(
        `
        out = []:Int | trans;
        for tup = zip(range(1,3), range(3,5)) {
            (a, b) = tup;
            push(out, a + b)
        }
        out
        `,
        [4n, 6n, 8n]
    );
});

test.todo("tuple: unpack tuple in for loop declaration", () => {
    testCompile(
        `
        out = []:Int | trans;
        for (a, b) = zip(range(1,3), range(3,5)) {
            push(out, a + b)
        }
        out
        `,
        [4n, 6n, 8n]
    );
});

// ============================================================
// Zip iterator
// ============================================================

test("zip basic two iterators", () => {
    testParse('zip([1, 2, 3], ["a", "b", "c"])');
});

test("zip collect two arrays", () => {
    testCompile(`collect(zip([1, 2, 3], ["a", "b", "c"]))`, [
        [1n, "a"],
        [2n, "b"],
        [3n, "c"],
    ]);
});

test("zip stops at shortest", () => {
    testCompile(`collect(zip([1, 2], ["a", "b", "c", "d"]))`, [
        [1n, "a"],
        [2n, "b"],
    ]);
});

test("zip three iterators", () => {
    testCompile(`collect(zip([1, 2], ["a", "b"], [true, false]))`, [
        [1n, "a", true],
        [2n, "b", false],
    ]);
});

test("zip with collect on array and range", () => {
    testCompile(`collect(zip([10, 20, 30], range(0, 3)))`, [
        [10n, 0n],
        [20n, 1n],
        [30n, 2n],
    ]);
});

test("zip with map", () => {
    testCompile(
        `collect(map(func(pair: Tuple[Int, Int]) { pair(0) + pair(1) }, zip([1, 2, 3], [10, 20, 30])))`,
        [11n, 22n, 33n]
    );
});

// ============================================================
// Tuples in other data types
// ============================================================

test("tuple: list of tuples", () => {
    testCompile("x = [(1,2,3), (4,5,6)]; x!(1)(1)", 5n);
    testParseExpectError("x = [(1,2,3), (4,6)];"); // Can't have mismatching tuple types in the same array
    testParseExpectError("x = [(1,2,3), (4,5,6.0)];"); // Can't have mismatching tuple types in the same array
});

test("tuple: operations on list of tuples", () => {
    testCompile("x = trans([]:Tuple[Int]); push(x, (1,)); x!(0)(0)", 1n);
    testCompile("([]:Tuple[Int] + [(1,)])!(0)(0)", 1n);
    testCompile("([(1,)] + [(2,)])!(1)(0)", 2n);
});

test("tuple: struct with tuple field", () => {
    testCompile("struct P { p: Tuple[Float, Float] } P((1.0,2.0)).p(0)", 1.0);
});
