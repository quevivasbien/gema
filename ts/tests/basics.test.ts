import { test } from "bun:test";

import { testCompile, testParse, testParseExpectError } from "./helpers";

test("compile literals", () => {
    testCompile(`1`, 1);
    testCompile(`1.23`, 1.23);
    testCompile(`1.`, 1);
    testCompile(`true`, true);
    testCompile(`false`, false);
    testCompile(`"hello"`, "hello");
    testCompile(`1i`, 1n);
});

test("compile ints with leading zeros, and no decimals", () => {
    testCompile("01i", 1n);
    testCompile("0152i", 152n);
    testCompile("00152i", 152n);
});

test("compile nums with leading zeros, and no decimals", () => {
    testCompile("01", 1);
    testCompile("0152", 152);
    testCompile("00152", 152);
});

test("compile floats with leading zeros", () => {
    testCompile("00.1", 0.1);
    testCompile("01.52", 1.52);
    testCompile("000152.", 152);
    testCompile("0.", 0);
});

test("compile binary expressions", () => {
    testCompile(`1 + 2`, 3);
    testCompile(`1 - 2`, -1);
    testCompile(`1 * 2`, 2);
    testCompile(`1 / 2`, 0.5);
    testCompile(`3 * (1 + 3) / 2`, 6);
    testCompile(`5 % 3`, 2);
    testCompile(`-5 % 3`, -2); // JS truncating %
    testCompile(`true and false`, false);
    testCompile(`true or false`, true);
    testCompile(`1 == 1`, true);
    testCompile(`1 != 1`, false);
    testCompile(`(1 > 2) and (3 < 4)`, false);
    testCompile(`(1 > 2) or (3 < 4)`, true);
});

test("compile integer division // and Euclidean %%", () => {
    testCompile(`7 // 2`, 3);
    testCompile(`7 %% 3`, 1);
    testCompile(`-7 // 2`, -4);
    testCompile(`-7 %% 3`, 2);
    testCompile(`8 // 3`, 2);
    testCompile(`8 %% 3`, 2);
});

test("compile block", () => {
    testCompile(`{ 1 }`, 1);
    testCompile(`1 + { 1 }`, 2);
    testParseExpectError(`{ 1; }`);
    testCompile(
        `
            (-32 / 4) % { 1 + 2 } 
        `,
        -2 // JS truncating: (-8) % 3 = -2
    );
});

test("compile exponentiation", () => {
    testCompile(`2 ^ 3`, 8);
    testCompile(`2 ^ 3 ^ 2`, 512);
    testCompile(`2 + 3 ^ 2 * 2`, 20);
    testCompile(`(-2) ^ 3`, -8);
    testCompile(`-2 ^ 2`, -4);
    testCompile(`5 ^ 0`, 1);
    testCompile(`2.0 ^ 3.0`, 8.0);
});

test("compile string indexing", () => {
    testCompile(`"hello"(0)`, "h");
    testCompile(`"hello"(1)`, "e");
    testCompile(`"hello"(4)`, "o");
    testCompile(`x = "hello"; x(0)`, "h");
});

test("compile type conversion builtins", () => {
    testCompile(`toStr(152)`, "152");
    testCompile(`toStr(true)`, "true");
    testCompile(`toStr(3.14)`, "3.14");
    testCompile(`toInt(3.14)`, 3n);
    testCompile(`toInt(-3.14)`, -3n);
    testCompile(`toInt(-3.8)`, -3n);
    testCompile(`toInt(true)`, 1n);
    testCompile(`toNum(3i)`, 3.0);
    testCompile(`toBool(1)`, true);
    testCompile(`toBool(0)`, false);
    testCompile(`"The number is " + toStr(152)`, "The number is 152");
});

test("compile variables named with JS reserved words", () => {
    testCompile(
        `
        const = 5;
        const + 1
    `,
        6
    );
    testCompile(
        `
        let = 10;
        let
    `,
        10
    );
    testCompile(
        `
        class = 20;
        class
    `,
        20
    );
    testCompile(
        `
        func f(const: Num): Num {
            const
        };
        f(5)
    `,
        5
    );
    testCompile(
        `
        const = 1;
        let = 2;
        const + let
    `,
        3
    );
});

test("parse addition", () => {
    testParse(`1.22  + 1.23  + 8.0 + 3.13`);
    testParse(`"hello" + "hello"`);
    testParseExpectError("1.22 + false");
});

test("parse subtraction", () => {
    testParse(`1.22  - 1.23  - 8.0 - 3.13`);
    testParseExpectError("1.22 - false");
});

test("parse multiplication", () => {
    testParse(`1.22  * 1.23  * 8.0 * 3.13`);
    testParseExpectError("1.22 * false");
});

test("parse division", () => {
    testParse(`1.22  / 1.23  / 8.0 / 3.13`);
    testParseExpectError("1.22 / false");
});

test("parse modulo", () => {
    testParse(`1.22  % 1.23  % 8.0 % 3.13`);
    testParseExpectError("1.22 % false");
});

test("parse order of operations", () => {
    testParse(`1.22  + 1.23  * 8.0 / 3.13`);
    testParse(`123 * 123 / 123 % 123 * 123`);
    testParse(`123 + 456 == 123 + 456`);
    testParse(`123 + 456 != 123 + 456 or 123 + 456 == 123 + 456`);
});

test("parse parens", () => {
    testParse(`(1.22  + 1.23)  * 8.0 / 3.13`);
});

test("parse block", () => {
    testParse(`{ 1.22  + 1.23  * { 8.0 / 3.13 } + 2. }`);
    testParse(`1 + 1; x = -2; -x`);
    testParse(`
        1 + 1;
        (2)
    `);
    testParseExpectError(`
        1 + 1
        (2)
    `);
});

test("parse exponentiation", () => {
    testParse(`2 ^ 3`);
    testParse(`2 ^ 3 ^ 4`);
    testParse(`2 + 3 ^ 4 * 5`);
    testParse(`-2 ^ 3`);
    testParseExpectError(`true ^ false`);
    testParseExpectError(`"hello" ^ 2`);
});

test("parse string indexing", () => {
    testParse(`"hello"(0)`);
    testParse(`"hello"(1)`);
    testParse(`x = "hello"; x(0)`);
});

test("parse variables named with JS reserved words", () => {
    testParse(`const = 5`);
    testParse(`let = 10`);
    testParse(`class = 20`);
    testParse(`func f(const: Num): Num { const }; f(5)`);
    testParse(`
        const = 1;
        let = 2;
        const + let
    `);
});

test("parse type conversion builtins", () => {
    testParse(`toStr(152)`);
    testParse(`toStr(true)`);
    testParse(`toStr(3.14)`);
    testParse(`toInt(3.14)`);
    testParse(`toInt(true)`);
    testParse(`toNum(3i)`);
    testParse(`toBool(1)`);
    testParse(`toBool(0)`);
    testParse(`"The number is " + toStr(152)`);
    testParseExpectError(`toStr(true, false)`);
    testParseExpectError(`toStr(Point(1, 2))`);
});

// ── Pipe syntax ──

test("pipe: basic pipe", () => {
    testCompile(
        `
        add1 = func(x: Num) { x + 1 };
        1 | add1
        `,
        2
    );
});

test("pipe: chained pipe", () => {
    testCompile(
        `
        add1 = func(x: Num) { x + 1 };
        5 | add1 | add1
        `,
        7
    );
});

test("pipe: pipe to length", () => {
    testCompile("[1, 2, 3] | length", 3);
});

test("pipe: pipe to last", () => {
    testCompile("[10, 20, 30] | last", 30);
});

test("pipe: error non-identifier RHS", () => {
    testParseExpectError("1 | 2");
    testParseExpectError("true | false");
});

test("pipe: non-function callable RHS", () => {
    testCompile("struct Point { x: Num } (2 | Point).x", 2);
    testCompile("x = [1,2,3]; 1 | x", 2);
});

test("pipe: backslash RHS", () => {
    testCompile("5 | \\x { x + 1 }", 6);
});

test("pipe: func RHS", () => {
    testCompile("3 | (func(x: Num) { x + 1 })", 4);
    testCompile("3 | func(x: Num) { x + 1 }", 4);
});

test.todo("pipe: array RHS", () => {
    testCompile("1 | [0, 2, 4]", 2);
});
