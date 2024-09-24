import { expect, test } from "bun:test";
import { writeJS } from "../src/write-js";
import { testParse } from "./parse.test";

function testCompile(text: string, expectEqual?: any) {
    const ast = testParse(text);
    const sourceOut = writeJS(ast);
    expect(sourceOut).toMatchSnapshot();
    if (expectEqual) {
        expect(eval(sourceOut)).toEqual(expectEqual);
    }
    return sourceOut;
}

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
});