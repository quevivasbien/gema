import { test } from "bun:test";

import {
    testCompile,
    testCompileExpectRuntimeError,
    testParse,
    testParseExpectError,
} from "./helpers";

test("compile arrays", () => {
    testCompile(
        `
            [1, 2, 3]
        `,
        [1, 2, 3]
    );

    testCompile(
        `
            ["1", "2", "3"]
        `,
        ["1", "2", "3"]
    );

    testCompile(
        `
            []: Num + [1, 2, 3] + [1]
        `,
        [1, 2, 3, 1]
    );
});

test("compile array indexed access", () => {
    testCompile(
        `
            x = [1, 2, 3];
            x(0)
        `,
        1
    );
    testCompile(
        `
            x = [[1, 2], [3, 4]];
            x(0, 1)
        `,
        2
    );
    testCompile(
        `
            [1, 2, 3](0)
        `,
        1
    );
});

test("compile nested array indexed access", () => {
    testCompile(
        `
            [[1, 2], [3, 4]](0, 1)
        `,
        2
    );

    testCompile(
        `
            x = [[1, 2], [3, 4]]; x(0, 1)
        `,
        2
    );
});

test("compile unwrapping on nested array indexed access", () => {
    testCompile(
        `
            1 + ([[1, 2], [3, 4]](0, 1) | unwrap)
        `,
        3
    );

    testCompile(
        `
            x = [[1, 2], [3, 4]]; x!(0, 1)
        `,
        2
    );
});

// This test case is making me think we maybe should just not allow this syntax for nested array access
test.todo("compile out of bounds unwrapping on nested array indexed access", () => {
    testCompileExpectRuntimeError(
        `
            1 + ([[1, 2], [3, 4]](2, 1) | unwrap)
        `,
        "vs"
    );
});

test("parse array literal", () => {
    testParseExpectError(`[]`);
    testParseExpectError(`[1, 2]: Str`);
    testParseExpectError(`[1, "2"]`);
    testParse(`[]: Arr[Num]`);
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
    testCompile("arr = [0, 1, 2, 3, 4]; arr(1..3)", [1, 2, 3]);
    testCompile("arr = [10, 20, 30, 40]; arr(0..2)", [10, 20, 30]);
});

test("array slice: arr(a..)", () => {
    testCompile("arr = [0, 1, 2, 3]; arr(2..)", [2, 3]);
    testCompile("arr = [10, 20]; arr(0..)", [10, 20]);
    testCompile("arr = [1, 2, 3]; arr(5..)", []);
});

test("array slice: arr(..b) is not legal", () => {
    testParseExpectError("arr = [0, 1, 2, 3]; arr(..2)");
});

test("array slice: with mutarr", () => {
    testCompile("arr = trans([0, 1, 2, 3]); arr(1..3)", [1, 2, 3]);
    testCompile("arr = trans([0, 1, 2]); arr(1..)", [1, 2]);
});

test("array slice: slice result of pipe", () => {
    // Pipe into collect, then slice the result
    testCompile("x = collect(1..5); x(1..3)", [2, 3, 4]);
});

test("array: contains", () => {
    testCompile("contains([1, 2, 3], 2)", true);
    testCompile("contains([1, 2, 3], 4)", false);
    testCompile('contains(["a", "b"], "c")', false);
});

test("array: find", () => {
    testCompile("unwrap(find(20, [10, 20, 30]))", 1);
    testCompile("isnone(find(99, [1, 2, 3]))", true);
    testCompile('unwrap(find("a", ["a", "b", "c"]))', 0);
});
