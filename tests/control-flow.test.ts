import { testCompile, testCompileError, testParse, testParseExpectError } from "./helpers";

test("compile if expressions", () => {
    testCompile(`if true { 1 } else { 2 }`, 1n);
    testCompile(`if false { 1 } else { 2 }`, 2n);
    testCompile(`if 1 == 1 { 1 } else { 2 }`, 1n);
    testCompile(`if 1 == 2 { 1 } else { 2 }`, 2n);
    testCompile(
        `
        mut x = 1;
        if true {
            x = 2;
        } else {
            x = 3;
        }
        x
        `,
        2n
    );
    testCompile(
        `
        if false {
            0
        }
        else if 1 > 0 {
            1
        } 
        else {
            2
        }
        `,
        1n
    );
});

test("parse if", () => {
    testParse(`if true { 1 } else { 2 }`);
    testParseExpectError(`if 1 { 1 } else { 2 }`);
    testParse(`if true { 1 }`); // else-less if is now valid (evaluates to null)
    testParseExpectError(`if true { 1 } else { 2.0 }`);
    testParse(`x = 10; if x < 0 { 1 } else if x > 10 { 2 } else { 3 }`);
});

// ============================================================
// If without else
// ============================================================

test("if-else: else-less if as statement mutates variable", () => {
    testCompile(
        `
        mut x = 1;
        if x < 2 {
            x = 5
        };
        x
        `,
        5n
    );
});

test("if-else: else-less if false does not mutate", () => {
    testCompile(
        `
        mut x = 1;
        if false {
            x = 5
        };
        x
        `,
        1n
    );
});

test("if-else: else-less if with else-if chain still works", () => {
    testCompile(
        `
        mut x = 0;
        if x == 5 {
            x = 10
        } else if x == 0 {
            x = 20
        } else {
            x = 30
        };
        x
        `,
        20n
    );
});

test("if-else: else-less if as final expression evaluates to null", () => {
    testCompile(
        `
        if false {
            1
        }
        `,
        null
    );
});

test("if-else: error else-less if in expression context", () => {
    testCompileError("x = if true { 1 }");
    testCompileError("x = if false { 1 }");
});

test("if-else: regular if-else still works", () => {
    testCompile("if true { 1 } else { 2 }", 1n);
    testCompile("if false { 1 } else { 2 }", 2n);
    testCompile(
        `
        mut x = 1;
        if true {
            x = 2
        } else {
            x = 3
        };
        x
        `,
        2n
    );
});

// ============================================================
// For loops
// ============================================================

test("for: basic for loop over range", () => {
    testCompile(
        `
        mut sum = 0;
        for i = range(1, 3) {
            sum = sum + i
        };
        sum
        `,
        6n
    );
});

test("for: for loop over array", () => {
    testCompile(
        `
        mut sum = 0;
        for i = [1, 2, 3] {
            sum = sum + i
        };
        sum
        `,
        6n
    );
});

test("for: for loop with break", () => {
    testCompile(
        `
        mut sum = 0;
        for i = range(1, 10) {
            if i > 3 {
                break
            };
            sum = sum + i
        };
        sum
        `,
        6n
    );
});

test("for: for loop evaluates to null", () => {
    testCompile(
        `
        for i = [1, 2, 3] {
            i
        }
        `,
        null
    );
});
