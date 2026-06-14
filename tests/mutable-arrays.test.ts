import { test } from "bun:test";

import { testCompile, requireIdenticalCompilation, testParseExpectError } from "./helpers";

// ============================================================
// Mutable arrays (MutArr[T])
// ============================================================

// ── Creating mutable arrays ──

test("mutarr: create empty", () => {
    testCompile("mutarr = trans([]:Int); detrans(mutarr)", []);
});

test("mutarr: create from array", () => {
    testCompile("mutarr = trans([1, 2, 3]); detrans(mutarr)", [1n, 2n, 3n]);
});

test("mutarr: create from array with strings or bools", () => {
    testCompile('mutarr = trans(["a", "b"]); detrans(mutarr)', ["a", "b"]);
    testCompile("mutarr = trans([true, false]); detrans(mutarr)", [true, false]);
});

// ── push elements ──

test("mutarr: push elements", () => {
    testCompile(
        `
        mutarr = trans([]:Int);
        push(mutarr, 1);
        push(mutarr, 2);
        push(mutarr, 3);
        detrans(mutarr)
        `,
        [1n, 2n, 3n]
    );
});

test("mutarr: push returns the array", () => {
    testCompile(`mutarr = trans([]:Int); push(mutarr, 10); detrans(mutarr)`, [10n]);
    testCompile(`mutarr = trans([1, 2]); push(mutarr, 3); detrans(mutarr)`, [1n, 2n, 3n]);
});

// ── set element ──

test("mutarr: set element", () => {
    testCompile(
        `
        mutarr = trans([1, 2, 3]);
        put(mutarr, 1, 99);
        detrans(mutarr)
        `,
        [1n, 99n, 3n]
    );
});

test("mutarr: set returns new value", () => {
    testCompile("mutarr = trans([1, 2, 3]); put(mutarr, 0, 99)", 99n);
});

// ── Element access (indexing) ──

test("mutarr: element access via indexing", () => {
    testCompile("mutarr = trans([10, 20, 30]); mutarr(0)", 10n);
    testCompile("mutarr = trans([10, 20, 30]); mutarr(2)", 30n);
});

test("mutarr: length on MutArr", () => {
    testCompile("mutarr = trans([1, 2, 3]); length(mutarr)", 3n);
    testCompile("mutarr = trans([]:Int); length(mutarr)", 0n);
});

test("mutarr: last on MutArr", () => {
    testCompile("mutarr = trans([10, 20, 30]); last(mutarr)", 30n);
    testCompile("mutarr = trans([42]); last(mutarr)", 42n);
});

// ── trans() makes a deep copy ──

test("mutarr: trans creates deep copy", () => {
    // Make a mutable copy, mutate it
    testCompile(`x = [1, 2, 3]; y = trans(x); put(y, 0, 99); detrans(y)`, [99n, 2n, 3n]);
    // Original should be unaffected
    testCompile(`x = [1, 2, 3]; y = trans(x); put(y, 0, 99); x`, [1n, 2n, 3n]);
});

// ── unsafeTrans — no copy ──

test("mutarr: unsafeTrans shares the array", () => {
    testCompile(`x = [1, 2, 3]; y = unsafeTrans(x); put(y, 0, 99); detrans(y)`, [99n, 2n, 3n]);
    // With unsafeTrans, the original is also affected
    testCompile(`x = [1, 2, 3]; y = unsafeTrans(x); put(y, 0, 99); x`, [99n, 2n, 3n]);
});

// ── detrans then use as regular array ──

test("mutarr: detransed array can be used normally", () => {
    testCompile(
        `mutarr = trans([1, 2, 3]); arr = detrans(mutarr); map(func(x: Int){ x + 1 }, arr) | collect`,
        [2n, 3n, 4n]
    );
    testCompile(`mutarr = trans([1, 2, 3]); arr = detrans(mutarr); arr(0)`, 1n);
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
        mutarr = trans([]:Int);
        push(mutarr, 1);
        push(mutarr, 2);
        put(mutarr, 0, 99);
        push(mutarr, 3);
        detrans(mutarr)
        `,
        [99n, 2n, 3n]
    );
});

// ── MutArr as function parameter ──

test("mutarr: pass mutarr to function", () => {
    testCompile(
        `
        func addOne(mutarr: MutArr[Int]) {
            put(mutarr, 0, mutarr!(0) + 1)
        };
        mutarr = trans([1, 2, 3]);
        addOne(mutarr);
        detrans(mutarr)
        `,
        [2n, 2n, 3n]
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
        [99n, 2n, 3n]
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
        [99n, 2n, 3n]
    );
});

test("mutarr: pass mutarr into function and push", () => {
    testCompile(
        `
        func addOne(m: MutArr[Int]) {
            push(m, 1)
        };
        mutarr = trans([]:Int);
        addOne(mutarr);
        addOne(mutarr);
        detrans(mutarr)
        `,
        [1n, 1n]
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
