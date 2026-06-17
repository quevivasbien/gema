import { test } from "bun:test";

import { testCompile, testCompileAndCheck, testParse, testParseExpectError } from "./helpers";

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
    testParseExpectError(`if true { 1 }`); // else-less if is value-less
    testParse(`if true { 1 }; 1`);
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

test("if-else: error else-less if in expression context", () => {
    testParseExpectError("x = if true { 1 }");
    testParseExpectError("x = if false { 1 }");
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

test("for: for loop over string", () => {
    testParseExpectError(
        `
        mut total = 0;
        for i = "hello" {
            total += 1
        };
        sum
        `
    );
});

test("for: for loop over numeric type", () => {
    testParseExpectError(
        `
        mut total = 0;
        for i = 1 {
            total += 1
        };
        sum
        `
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
    testParseExpectError(
        `
        for i = [1, 2, 3] {
            i
        }
        `
    );
    testParseExpectError(
        `
        x = {for i = [1, 2, 3] {
            i
        }}
        `
    );
});

test("for: repeated for loop with same iterating variable", () => {
    // Iterating variable needs to not be declared in same scope as the rest of the block.
    // 0..3 is inclusive of 3, so each loop iterates 4 times.
    testCompile(
        `
        mut total = 0;
        for i = 0..3 {
            total += 1;
        }
        for i = 0..3 {
            total += 1;
        }
        total
        `,
        8n
    );
});

// ============================================================
// Return statement
// ============================================================

test("return: basic return from function", () => {
    testCompile(
        `
        func foo(): Int {
            return 42
        };
        foo()
        `,
        42n
    );
});

test("return: return from function with expression", () => {
    testCompile(
        `
        func add(a: Int, b: Int): Int {
            return a + b
        };
        add(3, 4)
        `,
        7n
    );
});

test("return: conditional return", () => {
    testCompile(
        `
        func min(a: Int, b: Int): Int {
            if a < b {
                return a
            } else {
                return b
            }
        };
        min(5, 3)
        `,
        3n
    );
});

test("return: return inside nested if inside function", () => {
    testCompile(
        `
        func categorize(x: Int): Str {
            if x > 0 {
                if x > 10 {
                    return "large"
                } else {
                    return "small"
                }
            } else {
                return "non-positive"
            }
        };
        categorize(7)
        `,
        "small"
    );
});

test("return: return inside block inside function", () => {
    testCompile(
        `
        func foo(): Int {
            {
                return 99
            };
            0
        };
        foo()
        `,
        99n
    );
});

test("return: return inside deeply nested blocks", () => {
    testCompile(
        `
        func foo(): Int {
            {
                {
                    {
                        return 42
                    }
                }
            };
            0
        };
        foo()
        `,
        42n
    );
});

test("return: return in a loop body", () => {
    testCompile(
        `
        func findFirst(): Int {
            for i = 1..10 {
                if i > 5 {
                    return i
                }
            };
            0
        };
        findFirst()
        `,
        6n
    );
});

test("return: return in a chain of else-ifs", () => {
    testCompile(
        `
        func grade(score: Int): Str {
            if score >= 90 {
                return "A"
            } else if score >= 80 {
                return "B"
            } else if score >= 70 {
                return "C"
            } else {
                return "F"
            }
        };
        grade(85)
        `,
        "B"
    );
});

// ============================================================
// Continue statement
// ============================================================

test("continue: basic continue in for loop", () => {
    testCompile(
        `
        mut out = []:Int | trans;
        for i = 1..5 {
            if i % 2 == 0 {
                continue
            };
            push(out, i)
        };
        collect(out)
        `,
        [1n, 3n, 5n]
    );
});

test("continue: continue inside nested block in loop", () => {
    testCompile(
        `
        mut out = []:Int | trans;
        for i = 1..5 {
            {
                if i == 3 {
                    continue
                }
            };
            push(out, i)
        };
        collect(out)
        `,
        [1n, 2n, 4n, 5n]
    );
});

test("continue: continue with nested for loops", () => {
    testCompile(
        `
        mut out = []:Int | trans;
        for i = 1..3 {
            for j = 1..3 {
                if j == 2 {
                    continue
                };
                push(out, i * 10 + j)
            }
        };
        collect(out)
        `,
        [11n, 13n, 21n, 23n, 31n, 33n]
    );
});

// ============================================================
// Return + Continue combined
// ============================================================

test("return+continue: return exits loop early", () => {
    testCompile(
        `
        func firstEven(): Int {
            for i = 1..10 {
                if i % 2 == 0 {
                    return i
                } else {
                    continue
                }
            };
            0
        };
        firstEven()
        `,
        2n
    );
});

test("return: return in braced block inside if-else branch", () => {
    testCompile(
        `
        func foo(): Int {
            for i = 1..10 {
                if true {
                    { return i }
                } else {
                    1
                }
            };
            0
        };
        foo()
        `,
        1n
    );
});

// ============================================================
// Optimization: verify exception handling is only used when needed
// ============================================================

test("optimization: no try/catch in function without return", () => {
    testCompileAndCheck(
        `
        func add(a: Int, b: Int): Int { a + b };
        add(3, 4)
        `,
        [],
        ["try {", "$Return$"]
    );
});

test("optimization: no try/catch in loop without break/continue", () => {
    testCompileAndCheck(
        `
        func sum(): Int {
            mut total = 0;
            for i = 1..5 { total = total + i };
            total
        };
        sum()
        `,
        [],
        ["try {", "$Continue$", "$Break$"]
    );
});

test("optimization: direct return when not inside IIFE", () => {
    testCompileAndCheck(
        `
        func foo(): Int { return 42 };
        foo()
        `,
        ["return 42n"],
        ["throw new $Return$", "try {"]
    );
});

test("optimization: direct break when not inside IIFE", () => {
    testCompileAndCheck(
        `
        func foo(): Int {
            for i = 1..10 {
                if i > 5 { break };
            };
            0
        };
        foo()
        `,
        ["break;"],
        ["throw new $Break$", "try {"]
    );
});

test("optimization: direct continue when not inside IIFE", () => {
    testCompileAndCheck(
        `
        func foo(): Int {
            for i = 1..10 {
                if i % 2 == 0 { continue };
            };
            0
        };
        foo()
        `,
        ["continue"],
        ["throw new $Continue$", "try {"]
    );
});

test("optimization: exception return when inside IIFE", () => {
    testCompileAndCheck(
        `
        func foo(x: Int): Int {
            result = if x > 0 { return x } else { 0 };
            result
        };
        foo(5)
        `,
        ["throw new $Return$", "try {"]
    );
});

test("optimization: exception break when inside IIFE", () => {
    testCompileAndCheck(
        `
        func foo(): Int {
            for i = 1..10 {
                if true { break } else { 0 };
            };
            0
        };
        foo()
        `,
        ["throw new $Break$", "try {"]
    );
});

test("optimization: exception continue when inside IIFE", () => {
    testCompileAndCheck(
        `
        func foo(): Int {
            for i = 1..10 {
                if true { continue } else { 0 };
            };
            0
        };
        foo()
        `,
        ["throw new $Continue$", "try {"]
    );
});

// ============================================================
// Error cases
// ============================================================

test("return: error when return outside function", () => {
    testParseExpectError("return 42");
});

test("return: error when return outside function in block", () => {
    testParseExpectError("{ return 42 }");
});

test("continue: error when continue outside loop", () => {
    testParseExpectError("continue");
});

// ============================================================
// Existing behavior must still work after IIFE flattening
// ============================================================

test("if-else as expression assigned to variable", () => {
    testCompile(
        `
        x = if true { 10 } else { 20 };
        x
        `,
        10n
    );
    testCompile(
        `
        x = if false { 10 } else { 20 };
        x
        `,
        20n
    );
});

test("if-else with multiple statements in branches", () => {
    testCompile(
        `
        x = if true {
            mut y = 1;
            y + 1
        } else {
            mut z = 2;
            z + 2
        };
        x
        `,
        2n
    );
});

test("if-else chained assigned to variable", () => {
    testCompile(
        `
        x = if 1 == 1 {
            "a"
        } else if 2 == 2 {
            "b"
        } else {
            "c"
        };
        x
        `,
        "a"
    );
});
