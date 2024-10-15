import { expect, test } from "bun:test";
import { scan } from "../src/scan";
import { parse } from "../src/parse";

export function testParse(text: string, checkSnapshot: boolean = true) {
    const tokens = scan(text);
    const { ast, errors } = parse(tokens);
    if (errors.length > 0) {
        console.log(errors);
    }
    expect(errors.length).toBe(0);
    // expect(ast).toMatchSnapshot();
    return ast;
}

function testParseExpectError(text: string) {
    const tokens = scan(text);
    const { ast, errors } = parse(tokens);
    expect(errors.length).toBeGreaterThan(0);
    // expect(errors).toMatchSnapshot();
}

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

test("parse variable assignment", () => {
    testParse(`
        x = 1.22
        y = { 1.23 }
        z = 3.13;
        x = 3.
    `);
    testParseExpectError(`x = 1.0; x = 1;`);
    testParseExpectError(`x = y = 2`);
    testParseExpectError(`x = y = 2;`);
    // testParseExpectError(`f = func foo(a: Int): Int { a };`);
});

test("parse if", () => {
    testParse(`if true { 1 } else { 2 }`);
    testParseExpectError(`if 1 { 1 } else { 2 }`);
    testParseExpectError(`if true { 1 }`);
    testParseExpectError(`if true { 1 } else { 2.0 }`);
    testParse(`x = 10; if x < 0 { 1 } else if x > 10 { 2 } else { 3 }`);
});

test("parse function", () => {
    testParseExpectError(`func foo() { 1 }`);
    testParse(`func add(a: Int, b: Int): Int { a + b }`);
    testParse(`
        func myFunc(a: Func[Int: Func[Int: Int]], b: Func[:Int]): Func[Int: Func[Int: Int]] {
            a
        }
    `);
    testParse(`func myFunc(a: Int): Int { a }; myFunc(1)`);
    testParseExpectError(`func myFunc(a: Int): Int { a }; myFunc(1.0)`);
    testParseExpectError(
        `
        func foo(a: Int): Int {
            a
        }
        x = foo;
        `
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

test("allow references to named functions", () => {
    testParse(`
        func foo(x: Int): Int {
            x
        };
        
        bar = foo[Int];

        bar(1)
    `);
});