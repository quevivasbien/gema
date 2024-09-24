import { expect, test } from "bun:test";
import { scan } from "../src/scan";
import { parse } from "../src/parse";

export function testParse(text: string) {
    const tokens = scan(text);
    const { ast, errors } = parse(tokens);
    if (errors.length > 0) {
        console.log(errors);
    }
    expect(errors.length).toBe(0);
    expect(ast).toMatchSnapshot();
    return ast;
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

test("parse order of operations", () => {
    testParse(`1.22  + 1.23  * 8 / 3.13`);
}); 

test("parse parens", () => {
    testParse(`(1.22  + 1.23)  * 8 / 3.13`);
});

test("parse block", () => {
    testParse(`{ 1.22  + 1.23  * { 8 / 3.13 } + 2. }`);
    testParse(`1 + 1; x = -2; -x`)
});