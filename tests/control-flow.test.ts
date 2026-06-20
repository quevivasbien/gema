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
        if x == 0 {
            x = 10
        } else if x == 10 {
            x = 20
        };
        x
        `,
        10n
    );
});

test("if-else: error else-less if in expression context", () => {
    testParseExpectError("x = if true { 1 }");
    testParseExpectError("x = if false { 1 }");
});

test("if-else: error if + if-else if without else in expression context", () => {
    testParseExpectError("x = if true { 1 } else if false { 2 }");
    testParseExpectError("x = if false { 1 } else if true { 2 }");
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

test("if-else: basic if/ifelse/else", () => {
    testCompile("if false { 1 } else if false { 2 } else { 3 }", 3n);
});

test("if-else: if+else if+else works as an expression", () => {
    testCompile("if true { 1 } else if true { 2 } else { 3 }", 1n);
    testCompile("if false { 1 } else if true { 2 } else { 3 }", 2n);
    testCompile("if false { 1 } else if false { 2 } else { 3 }", 3n);
    testCompile(
        `
        mut x = 1;
        y = if false {
            x = 2
        } else if true {
            x = 3
        } else {
            1
        };
        (x, y)
        `,
        [3n, 3n]
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
// Infinite loop: for { ... }
// ============================================================

test("for: infinite loop with break", () => {
    testCompile(
        `
        mut count = 0;
        for {
            if count == 5 {
                break
            };
            count += 1
        };
        count
        `,
        5n
    );
});

test("for: infinite loop break immediately", () => {
    testCompile(
        `
        for { break };
        42
        `,
        42n
    );
});

test("for: infinite loop with continue", () => {
    testCompile(
        `
        mut count = 0;
        mut seen = []:Int | trans;
        for {
            count += 1;
            if count % 2 == 0 {
                continue
            };
            push(seen, count);
            if count >= 5 {
                break
            }
        };
        detrans(seen)
        `,
        [1n, 3n, 5n]
    );
});

test("for: nested infinite loops with break", () => {
    testCompile(
        `
        mut sum = 0;
        for {
            for {
                sum += 1;
                break  # break inner
            };
            if sum >= 3 {
                break  # break outer
            }
        };
        sum
        `,
        3n
    );
});

test("for: infinite loop inside function with break", () => {
    testCompile(
        `
        func findTarget(target: Int): Int {
            mut guess = 0;
            for {
                if guess == target {
                    break
                };
                guess += 1
            };
            guess
        };
        findTarget(10)
        `,
        10n
    );
});

test("for: nested for loop with same iterator", () => {
    // Iterators need to be cloned if used in a nested fashion
    testCompile(
        `
        trait Any {}
        func square(iter: Iter[T]) where T is Any {
            result = []: Tuple[T, T] | trans;
            for a = iter {
                for b = iter {
                    push(result, (a, b));
                }
            }
            result
        }
        square([1,2])
        `,
        [
            [1n, 1n],
            [1n, 2n],
            [2n, 1n],
            [2n, 2n],
        ]
    );
});

// ============================================================
// Return statement
// ============================================================

test("return: cannot end function with return", () => {
    // Control flow statements technically have null type.
    // This means you cannot terminate a function with a return statement,
    // since this would imply that the function both does and does not return a Null
    testParseExpectError(
        `
        func foo(): Int {
            return 42
        };
        foo()
        `
    );
    testParseExpectError(
        `
        func add(a: Int, b: Int): Int {
            return a + b
        };
        add(3, 4)
        `
    );
});

test("return: return type doesn't match function return type", () => {
    // Tries to return Null, but function expects integer
    testParseExpectError(
        `
        func foo() {
            if true {
                return
            }
            1
        }
        foo()
        `
    );
    // Tries to return string, but function expects integer
    testParseExpectError(
        `
        func foo() {
            if true {
                return "foo"
            }
            1
        }
        foo()
        `
    );
});

test("return: conditional return where Null value is allowed", () => {
    // This is okay, since both branches of the if-else have the same (Null) type,
    // And the function ends in an Int value
    // Ofc the idiomatic way to do this would be to omit the returns
    testCompile(
        `
        func min(a: Int, b: Int) {
            if a < b {
                return a
            } else {
                return b
            }

            0
        };
        min(5, 3)
        `,
        3n
    );
});

test("return: nested conditional return where Null value is not allowed", () => {
    // This is NOT okay, since the if-else statement here will have type Null
    // Which conflicts with what is returned.
    testParseExpectError(
        `
        func min(a: Int, b: Int) {
            if a < b {
                return a
            } else {
                return b
            }
        };
        min(5, 3)
        `
    );
});

test("return: deeply nested conditional return where Null value is not allowed", () => {
    // This is NOT okay, for the same reason as the previous test
    testParseExpectError(
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
        `
    );
});

test("return: if/elseif/else with mismatch in type", () => {
    // This is NOT okay, because the if and elseif both have Null type, but the else block has Int type
    testParseExpectError(
        `
        func foo() {
            if false {
                return 1
            }
            else if true {
                return 2
            }
            else {
                3
            }
        };
        foo()
        `
    );
});

test("return: if/elseif/else with mismatch in type", () => {
    // This IS okay, since the if/ifelse has type null, and the 3 is a separate expression
    testCompile(
        `
        func foo() {
            if false {
                return 1
            }
            else if true {
                return 2
            }
            3
        };
        foo()
        `,
        2n
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
            }
            "F"
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
        out
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
        out
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
        out
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
                    1;
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
// Break statement
// ============================================================

test("break: basic break in for loop", () => {
    testCompile(
        `
        mut out = []:Int | trans;
        for i = 1..5 {
            if i % 2 == 0 {
                break
            };
            push(out, i)
        };
        out
        `,
        [1n]
    );
});

test("break: break inside nested block in loop", () => {
    testCompile(
        `
        mut out = []:Int | trans;
        for i = 1..5 {
            {
                if i == 3 {
                    break
                }
            };
            push(out, i)
        };
        out
        `,
        [1n, 2n]
    );
});

test("break: break with nested for loops", () => {
    testCompile(
        `
        mut out = []:Int | trans;
        for i = 1..3 {
            for j = 1..3 {
                if j == 2 {
                    break
                };
                push(out, i * 10 + j)
            }
        };
        out
        `,
        [11n, 21n, 31n]
    );
});

// ============================================================
// Control flow where not allowed
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

test("break: error when break outside loop", () => {
    testParseExpectError("continue");
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
        func foo() { return };
        foo(); 1
        `,
        ["return"],
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
        func foo(): Int {
            x = {
                if true { return 1 };
                42
            };
            x
        };
        foo()
        `,
        ["throw new $Return$", "try {"]
    );
});

test("optimization: exception break when inside IIFE", () => {
    testCompileAndCheck(
        `
        func foo(): Int {
            for i = 1..10 {
                x = {
                    if true { break };
                    0
                };
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
                x = {
                    if true { continue };
                    0
                };
            };
            0
        };
        foo()
        `,
        ["throw new $Continue$", "try {"]
    );
});

test("optimization: return in dropped block doesn't require try/catch", () => {
    testCompileAndCheck(
        `
        func foo(): Int {
            {
                return 99
            }
            0
        };
        foo()
        `,
        ["return 99"],
        ["throw new $Return$", "try {"]
    );
});

test("optimization: return in non-nested if statement doesn't require try/catch", () => {
    testCompileAndCheck(
        `
        func sign(x: Int) {
            if x > 0 {
                return 1 
            }
            if x < 0 {
                return -1
            }
            0
        }
        sign(1)
        `,
        ["return 1n", "return (-(1n))"],
        ["throw new $Return$", "try {"]
    );
});

test("optimization: return in nested if statement doesn't require try/catch", () => {
    testCompileAndCheck(
        `
        func superSign(x: Int) {
        if x > 0 {
            if x > 10 {
            return 2
            }
            return 1 
        }
        if x < 0 {
            if x < -10 {
            return -2
            }
            return -1
        }
        0
        }

        superSign(1)
        `,
        ["return 2n", "return 1n", "return (-(1n))", "return (-(2n))"],
        ["throw new $Return$", "try {"]
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
