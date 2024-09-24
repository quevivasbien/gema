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
    expect(ast).toMatchSnapshot();
    return ast;
}

function testParseExpectError(text: string) {
    const tokens = scan(text);
    const { ast, errors } = parse(tokens);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors).toMatchSnapshot();
}

test("parse addition", () => {
    testParse(`1.22  + 1.23  + 8 + 3.13`);
});

test("parse subtraction", () => {
    testParse(`1.22  - 1.23  - 8 - 3.13`);
});

test("parse multiplication", () => {
    testParse(`1.22  * 1.23  * 8 * 3.13`);
});

test("parse division", () => {
    testParse(`1.22  / 1.23  / 8 / 3.13`);
});

test("parse modulo", () => {
    testParse(`1.22  % 1.23  % 8 % 3.13`);
});

test("parse order of operations", () => {
    testParse(`1.22  + 1.23  * 8 / 3.13`);
    testParse(`123 * 123 / 123 % 123 * 123`);
}); 

test("parse parens", () => {
    testParse(`(1.22  + 1.23)  * 8 / 3.13`);
});

test("parse block", () => {
    testParse(`{ 1.22  + 1.23  * { 8 / 3.13 } + 2. }`);
    testParse(`1 + 1; x = -2; -x`)
});

test("parse variable assignment", () => {
    testParse(`
        x = 1.22
        y = { 1.23 }
        z = 3.13;
        x = 3
    `);
    testParseExpectError(`x = y = 2`)
    testParseExpectError(`x = y = 2;`)
});