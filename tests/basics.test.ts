import { testCompile, testCompileError, testParse, testParseExpectError } from "./helpers";

test("compile literals", () => {
    testCompile(`1`, 1n);
    testCompile(`1.23`, 1.23);
    testCompile(`true`, true);
    testCompile(`false`, false);
    testCompile(`"hello"`, "hello");
});

test("compile binary expressions", () => {
    testCompile(`1 + 2`, 3n);
    testCompile(`1 - 2`, -1n);
    testCompile(`1 * 2`, 2n);
    testCompile(`1 / 2`, 0n);
    testCompile(`3 * (1 + 3) / 2`, 6n);
    testCompile(`5 % 3`, 2n);
    testCompile(`-5 % 3`, 1n);
    testCompile(`true and false`, false);
    testCompile(`true or false`, true);
    testCompile(`1 == 1`, true);
    testCompile(`1 != 1`, false);
    testCompile(`(1 > 2) and (3 < 4)`, false);
    testCompile(`(1 > 2) or (3 < 4)`, true);
});

test("compile block", () => {
    testCompile(`{ 1 }`, 1n);
    testCompile(`1 + { 1 }`, 2n);
    testCompile(`{ 1; }`, null);
    testCompile(
        `
            (-32 / 4) % { 1 + 2 } 
        `,
        1n
    );
});

test("compile exponentiation", () => {
    testCompile(`2 ^ 3`, 8n);
    testCompile(`2 ^ 3 ^ 2`, 512n); // Right-associative: 2^(3^2) = 2^9 = 512
    testCompile(`2 + 3 ^ 2 * 2`, 20n); // 2 + (9 * 2) = 20
    testCompile(`(-2) ^ 3`, -8n); // -2^3 = -8
    testCompile(`-2 ^ 2`, -4n); // Exponentiation takes precedence over unary -
    testCompile(`5 ^ 0`, 1n);
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
    testCompile(`toFloat(3)`, 3.0);
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
        6n
    );
    testCompile(
        `
        let = 10;
        let
    `,
        10n
    );
    testCompile(
        `
        class = 20;
        class
    `,
        20n
    );
    testCompile(
        `
        return = true;
        return
    `,
        true
    );
    testCompile(
        `
        func f(const: Int): Int {
            const
        };
        f(5)
    `,
        5n
    );
    testCompile(
        `
        const = 1;
        let = 2;
        const + let
    `,
        3n
    );
});

test("parse addition", () => {
    testParse(`1.22  + 1.23  + 8 + 3.13`);
    testParse(`"hello" + "hello"`);
    testParseExpectError("1.22 + false");
});

test("parse subtraction", () => {
    testParse(`1.22  - 1.23  - 8 - 3.13`);
    testParseExpectError("1.22 - false");
});

test("parse multiplication", () => {
    testParse(`1.22  * 1.23  * 8 * 3.13`);
    testParseExpectError("1.22 * false");
});

test("parse division", () => {
    testParse(`1.22  / 1.23  / 8 / 3.13`);
    testParseExpectError("1.22 / false");
});

test("parse modulo", () => {
    testParse(`1.22  % 1.23  % 8 % 3.13`);
    testParseExpectError("1.22 % false");
});

test("parse order of operations", () => {
    testParse(`1.22  + 1.23  * 8 / 3.13`);
    testParse(`123 * 123 / 123 % 123 * 123`);
    testParse(`123 + 456 == 123 + 456`);
    testParse(`123 + 456 != 123 + 456 or 123 + 456 == 123 + 456`);
});

test("parse parens", () => {
    testParse(`(1.22  + 1.23)  * 8 / 3.13`);
});

test("parse block", () => {
    testParse(`{ 1.22  + 1.23  * { 8 / 3.13 } + 2. }`);
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
    testParse(`return = true`);
    testParse(`func f(const: Int): Int { const }; f(5)`);
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
    testParse(`toFloat(3)`);
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
        add1 = func(x: Int) { x + 1 };
        1 | add1
        `,
        2n
    );
});

test("pipe: chained pipe", () => {
    testCompile(
        `
        add1 = func(x: Int) { x + 1 };
        5 | add1 | add1
        `,
        7n
    );
});

test("pipe: pipe to length", () => {
    testCompile("[1, 2, 3] | length", 3n);
});

test("pipe: pipe to last", () => {
    testCompile("[10, 20, 30] | last", 30n);
});

test("pipe: error non-identifier RHS", () => {
    testCompileError("1 | 2");
    testCompileError("true | false");
});
