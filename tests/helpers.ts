import { expect } from "bun:test";
import { parse } from "../src/parse";
import { scan } from "../src/scan";
import { writeJS } from "../src/write-js";
import { resetRegistries } from "../src/ast/index";

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
 * Parse + compile a Gema program, then check whether the generated JS
 * contains (or does not contain) the given patterns.
 * Returns the compiled JS string.
 */
export function testCompileAndCheck(
    text: string,
    includes: string[] = [],
    excludes: string[] = []
): string {
    resetRegistries();
    const tokens = scan(text);
    const { ast, errors } = parse(tokens);
    expect(errors.length).toBe(0);
    const sourceOut = writeJS(ast);
    for (const pattern of includes) {
        if (!sourceOut.includes(pattern)) {
            console.log(`Expected to find in JS output:\n  ${pattern}`);
            console.log("Actual JS:\n", sourceOut);
        }
        expect(sourceOut).toInclude(pattern);
    }
    for (const pattern of excludes) {
        if (sourceOut.includes(pattern)) {
            console.log(`Expected NOT to find in JS output:\n  ${pattern}`);
            console.log("Actual JS:\n", sourceOut);
        }
        expect(sourceOut).not.toInclude(pattern);
    }
    return sourceOut;
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

/**
 * Assert a program compiles successfully but throws a runtime error
 */
export function testCompileExpectRuntimeError(text: string, expectErrorMessage?: string) {
    const js = testCompile(text, null);
    expect(() => eval(js)).toThrow(expectErrorMessage);
}
