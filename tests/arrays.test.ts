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
