import { test } from "bun:test";

import { testCompile, testParse, testParseExpectError } from "./helpers";

test("compile arrays", () => {
    testCompile(
        `
            [1, 2, 3]
        `,
        [1n, 2n, 3n]
    );

    testCompile(
        `
            ["1", "2", "3"]
        `,
        ["1", "2", "3"]
    );

    testCompile(
        `
            []: Int + [1, 2, 3] + [1]
        `,
        [1n, 2n, 3n, 1n]
    );
});

test("compile array indexed access", () => {
    testCompile(
        `
            x = [1, 2, 3];
            x(0)
        `,
        1n
    );
    testCompile(
        `
            x = [[1, 2], [3, 4]];
            x(0, 1)
        `,
        2n
    );
    testCompile(
        `
            [1, 2, 3](0)
        `,
        1n
    );
    testCompile(
        `
            [[1, 2], [3, 4]](0, 1)
        `,
        2n
    );
});

test("parse array literal", () => {
    testParseExpectError(`[]`);
    testParseExpectError(`[1, 2]: Str`);
    testParseExpectError(`[1, "2"]`);
    testParse(`[]: Arr[Int]`);
    testParseExpectError(`[]: Arr`);
    testParseExpectError(`[]: Arr[Int, Str]`);
});

test("parse array indexed access", () => {
    testParseExpectError(`x = [1, 2, 3]; x()`);
    testParseExpectError(`x = [1, 2, 3]; x("hello")`);
    testParseExpectError(`x = [1, 2, 3]; x(0, 1)`);
    testParseExpectError(`[1, 2, 3]()`);
    testParseExpectError(`[1, 2, 3]("hello")`);
    testParseExpectError(`[1, 2, 3](0, 1)`);
});

// ============================================================
// Array slicing with range syntax
// ============================================================

test("array slice: arr(a..b)", () => {
    testCompile("arr = [0, 1, 2, 3, 4]; arr(1..3)", [1n, 2n, 3n]);
    testCompile("arr = [10, 20, 30, 40]; arr(0..2)", [10n, 20n, 30n]);
});

test("array slice: arr(a..)", () => {
    testCompile("arr = [0, 1, 2, 3]; arr(2..)", [2n, 3n]);
    testCompile("arr = [10, 20]; arr(0..)", [10n, 20n]);
    testCompile("arr = [1, 2, 3]; arr(5..)", []);
});

test("array slice: arr(..b)", () => {
    testCompile("arr = [0, 1, 2, 3]; arr(..2)", [0n, 1n, 2n]);
    testCompile("arr = [10, 20, 30]; arr(..0)", [10n]);
});

test("array slice: arr(..)", () => {
    testCompile("arr = [0, 1, 2]; arr(..)", [0n, 1n, 2n]);
});

test("array slice: with mutarr", () => {
    testCompile("arr = trans([0, 1, 2, 3]); arr(1..3)", [1n, 2n, 3n]);
    testCompile("arr = trans([0, 1, 2]); arr(1..)", [1n, 2n]);
});

test("array slice: slice result of pipe", () => {
    // Pipe into collect, then slice the result
    testCompile("x = collect(1..5); x(1..3)", [2n, 3n, 4n]);
});
