import { expect } from "bun:test";
import { parse } from "../src/parse";
import { scan } from "../src/scan";
import { writeJS } from "../src/write-js";
import { resetRegistries } from "../src/ast";

/**
 * Parse + compile a Gema program, then eval the JS.
 * Asserts the final expression equals expectEqual.
 */
export function testCompile(text: string, expectEqual: unknown) {
    resetRegistries();
    const tokens = scan(text);
    const { ast, errors } = parse(tokens);
    expect(errors.length).toBe(0);
    const sourceOut = writeJS(ast);
    if (expectEqual !== null) {
        const result = eval(sourceOut);
        expect(result).toEqual(expectEqual);
    }
    return sourceOut;
}

/**
 * Assert that a program produces one or more parse/type errors.
 */
export function testCompileError(text: string) {
    resetRegistries();
    const tokens = scan(text);
    const { errors } = parse(tokens);
    expect(errors.length).toBeGreaterThan(0);
}

/**
 * Parse a program and assert no errors. Returns the AST.
 */
export function testParse(text: string) {
    resetRegistries();
    const tokens = scan(text);
    const { ast, errors } = parse(tokens);
    if (errors.length > 0) {
        console.log(errors);
    }
    expect(errors.length).toBe(0);
    return ast;
}

/**
 * Parse a program and assert at least one error. Returns the AST.
 */
export function testParseExpectError(text: string) {
    resetRegistries();
    const tokens = scan(text);
    const { errors } = parse(tokens);
    expect(errors.length).toBeGreaterThan(0);
}

/**
 * Assert two programs produce identical compiled output.
 */
export function requireIdenticalCompilation(text1: string, text2: string) {
    const js1 = testCompile(text1, null);
    const js2 = testCompile(text2, null);
    expect(js1).toEqual(js2);
}
