import { test } from "bun:test";

import { testCompile, requireIdenticalCompilation, testParseExpectError } from "./helpers";

// ============================================================
// Mutable arrays (MutArr[T])
// ============================================================

// ── Creating mutable arrays ──

test("mutarr: create empty", () => {
    testCompile("mutarr = trans([]:Num); detrans(mutarr)", []);
});

test("mutarr: create from array", () => {
    testCompile("mutarr = trans([1, 2, 3]); detrans(mutarr)", [1, 2, 3]);
});

test("mutarr: create from array with strings or bools", () => {
    testCompile('mutarr = trans(["a", "b"]); detrans(mutarr)', ["a", "b"]);
    testCompile("mutarr = trans([true, false]); detrans(mutarr)", [true, false]);
});

// ── push elements ──

test("mutarr: push elements", () => {
    testCompile(
        `
        mutarr = trans([]:Num);
        push(mutarr, 1);
        push(mutarr, 2);
        push(mutarr, 3);
        detrans(mutarr)
        `,
        [1, 2, 3]
    );
});

test("mutarr: push returns the array", () => {
    testCompile(`mutarr = trans([]:Num); push(mutarr, 10); detrans(mutarr)`, [10]);
    testCompile(`mutarr = trans([1, 2]); push(mutarr, 3); detrans(mutarr)`, [1, 2, 3]);
});

// ── set element ──

test("mutarr: set element", () => {
    testCompile(
        `
        mutarr = trans([1, 2, 3]);
        put(mutarr, 1, 99);
        detrans(mutarr)
        `,
        [1, 99, 3]
    );
});

test("mutarr: put returns mutarr", () => {
    testCompile("mutarr = trans([1, 2, 3]); put(mutarr, 0, 99)", [99, 2, 3]);
});

// ── Element access (indexing) ──

test("mutarr: element access via indexing", () => {
    testCompile("mutarr = trans([10, 20, 30]); mutarr(0)", 10);
    testCompile("mutarr = trans([10, 20, 30]); mutarr(2)", 30);
});

test("mutarr: length on MutArr", () => {
    testCompile("mutarr = trans([1, 2, 3]); length(mutarr)", 3);
    testCompile("mutarr = trans([]:Num); length(mutarr)", 0);
});

test("mutarr: last on MutArr", () => {
    testCompile("mutarr = trans([10, 20, 30]); last(mutarr)", 30);
    testCompile("mutarr = trans([42]); last(mutarr)", 42);
});

// ── trans() makes a deep copy ──

test("mutarr: trans creates deep copy", () => {
    // Make a mutable copy, mutate it
    testCompile(`x = [1, 2, 3]; y = trans(x); put(y, 0, 99); detrans(y)`, [99, 2, 3]);
    // Original should be unaffected
    testCompile(`x = [1, 2, 3]; y = trans(x); put(y, 0, 99); x`, [1, 2, 3]);
});

// ── unsafeTrans — no copy ──

test("mutarr: unsafeTrans shares the array", () => {
    testCompile(`x = [1, 2, 3]; y = unsafeTrans(x); put(y, 0, 99); detrans(y)`, [99, 2, 3]);
    // With unsafeTrans, the original is also affected
    testCompile(`x = [1, 2, 3]; y = unsafeTrans(x); put(y, 0, 99); x`, [99, 2, 3]);
});

// ── detrans then use as regular array ──

test("mutarr: detransed array can be used normally", () => {
    testCompile(
        `mutarr = trans([1, 2, 3]); arr = detrans(mutarr); map(func(x: Num){ x + 1 }, arr) | collect`,
        [2, 3, 4]
    );
    testCompile(`mutarr = trans([1, 2, 3]); arr = detrans(mutarr); arr(0)`, 1);
});

// ── unsafeTrans and detrans should both compile to no-ops ──
test("mutarr: unsafeTrans is a no-op", () => {
    requireIdenticalCompilation("unsafeTrans([1,2,3])", "[1,2,3]");
    requireIdenticalCompilation("[1,2,3] | unsafeTrans", "[1,2,3]");
    requireIdenticalCompilation("x = [1,2,3]; unsafeTrans(x)", "x = [1,2,3]; x");
});

test("mutarr: unsafeTrans and detrans are no-ops", () => {
    requireIdenticalCompilation("detrans(unsafeTrans([1,2,3]))", "[1,2,3]");
    requireIdenticalCompilation("x = trans([1,2,3]); detrans(x)", "x = trans([1,2,3]); x");
    requireIdenticalCompilation("x = trans([1,2,3]); x | detrans", "x = trans([1,2,3]); x");
});

// ── Multiple operations chained ──

test("mutarr: push after set after push", () => {
    testCompile(
        `
        mutarr = trans([]:Num);
        push(mutarr, 1);
        push(mutarr, 2);
        put(mutarr, 0, 99);
        push(mutarr, 3);
        detrans(mutarr)
        `,
        [99, 2, 3]
    );
});

// ── MutArr as function parameter ──

test("mutarr: pass mutarr to function", () => {
    testCompile(
        `
        func addOne(mutarr: MutArr[Num]) {
            put(mutarr, 0, mutarr!(0) + 1)
        };
        mutarr = trans([1, 2, 3]);
        addOne(mutarr);
        detrans(mutarr)
        `,
        [2, 2, 3]
    );
});

// ── Scope tests ──

test("mutarr: mutate via nested block", () => {
    testCompile(
        `
        mutarr = trans([1, 2, 3]);
        {
            put(mutarr, 0, 99)
        };
        detrans(mutarr)
        `,
        [99, 2, 3]
    );
});

test("mutarr: mutate via closure", () => {
    testCompile(
        `
        mutarr = trans([1, 2, 3]);
        f = func() { put(mutarr, 0, 99) };
        f();
        detrans(mutarr)
        `,
        [99, 2, 3]
    );
});

test("mutarr: pass mutarr into function and push", () => {
    testCompile(
        `
        func addOne(m: MutArr[Num]) {
            push(m, 1)
        };
        mutarr = trans([]:Num);
        addOne(mutarr);
        addOne(mutarr);
        detrans(mutarr)
        `,
        [1, 1]
    );
});

// ── Use-after-detrans error ──

test("mutarr: error use after detrans", () => {
    testParseExpectError(`
        mutarr = trans([1, 2, 3]);
        arr = detrans(mutarr);
        push(mutarr, 4)
    `);
    testParseExpectError(`
        mutarr = trans([1, 2, 3]);
        arr = detrans(mutarr);
        put(mutarr, 0, 99)
    `);
    testParseExpectError(`
        mutarr = trans([1, 2, 3]);
        arr = detrans(mutarr);
        mutarr(0)
    `); // not even non-mutating operations are allowed
    testParseExpectError(`
        mutarr = trans([1, 2, 3]);
        arr = detrans(mutarr);
        mutarr2 = mutarr;
    `);
    testParseExpectError(`
        mutarr = trans([1, 2, 3]);
        arr = detrans(mutarr);
        mutarr
    `); // cannot even reference the variable
});

// ── Error cases ──

test("mutarr: error trans on non-array", () => {
    testParseExpectError("trans(1)");
    testParseExpectError('trans("hello")');
    testParseExpectError("trans(true)");
});

test("mutarr: error unsafeTrans on non-array", () => {
    testParseExpectError("unsafeTrans(1)");
});

test("mutarr: error detrans on non-mut-array", () => {
    testParseExpectError("detrans([1, 2, 3])");
    testParseExpectError("detrans(1)");
});

test("mutarr: error push on non-mut-array", () => {
    testParseExpectError("push([1, 2], 3)");
});

test("mutarr: error set on non-mut-array", () => {
    testParseExpectError("put([1, 2], 0, 99)");
});

test("mutarr: error push type mismatch", () => {
    testParseExpectError(`mutarr = trans([1, 2]); push(mutarr, "hello")`);
});

test("mutarr: error set type mismatch", () => {
    testParseExpectError(`mutarr = trans([1, 2]); put(mutarr, 0, "hello")`);
});

test("mutarr: error set non-integer index", () => {
    testParseExpectError(`mutarr = trans([1, 2]); put(mutarr, "x", 99)`);
});

test("mutarr: error trans on non-array variable", () => {
    testParseExpectError("x = 1; trans(x)");
});

test("mutarray: contains", () => {
    testCompile("contains([1, 2, 3] | trans, 2)", true);
    testCompile("contains([1, 2, 3] | trans, 4)", false);
    testCompile('contains(["a", "b"] | trans, "c")', false);
});

test("mutarray: find", () => {
    testCompile("unwrap(find(20, [10, 20, 30] | trans))", 1);
    testCompile("isnone(find(99, [1, 2, 3] | trans))", true);
    testCompile('unwrap(find("a", ["a", "b", "c"] | trans))', 0);
});
