import { test } from "bun:test";

import { testCompile, testCompileAndCheck, testParse, testParseExpectError } from "./helpers";

test("compile if expressions", () => {
    testCompile(`if true { 1 } else { 2 }`, 1);
    testCompile(`if false { 1 } else { 2 }`, 2);
    testCompile(`if 1 == 1 { 1 } else { 2 }`, 1);
    testCompile(`if 1 == 2 { 1 } else { 2 }`, 2);
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
        2
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
        1
    );
});

test("parse if", () => {
    testParse(`if true { 1 } else { 2 }`);
    testParseExpectError(`if 1 { 1 } else { 2 }`);
    testParseExpectError(`if true { 1 }`); // else-less if is value-less
    testParse(`if true { 1 }; 1`);
    testParseExpectError(`if true { "hello" } else { 2 }`); // type mismatch
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
        5
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
        1
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
        10
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
    testCompile("if true { 1 } else { 2 }", 1);
    testCompile("if false { 1 } else { 2 }", 2);
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
        2
    );
});

test("if-else: basic if/ifelse/else", () => {
    testCompile("if false { 1 } else if false { 2 } else { 3 }", 3);
});

test("if-else: if+else if+else works as an expression", () => {
    testCompile("if true { 1 } else if true { 2 } else { 3 }", 1);
    testCompile("if false { 1 } else if true { 2 } else { 3 }", 2);
    testCompile("if false { 1 } else if false { 2 } else { 3 }", 3);
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
        [3, 3]
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
        6
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
        6
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
        6
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
        8
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
        5
    );
});

test("for: infinite loop break immediately", () => {
    testCompile(
        `
        for { break };
        42
        `,
        42
    );
});

test("for: infinite loop with continue", () => {
    testCompile(
        `
        mut count = 0;
        mut seen = []:Num | trans;
        for {
            count += 1;
            if count % 2 == 0 {
                continue
            };
            push(count, seen);
            if count >= 5 {
                break
            }
        };
        detrans(seen)
        `,
        [1, 3, 5]
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
        3
    );
});

test("for: infinite loop inside function with break", () => {
    testCompile(
        `
        func findTarget(target: Num): Num {
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
        10
    );
});

test("for: nested for loop with same iterator", () => {
    // Iterators need to be cloned if used in a nested fashion
    testCompile(
        `
        func [T] square(iter: Iter[T]) {
            result = []: Tup[T, T] | trans;
            for a = iter {
                for b = iter {
                    push((a, b), result);
                }
            }
            result
        }
        square([1,2])
        `,
        [
            [1, 1],
            [1, 2],
            [2, 1],
            [2, 2],
        ]
    );
});

// ============================================================
// Return statement
// ============================================================

test("return: function can end with return", () => {
    // Functions whose last expression is a return correctly infer their
    // return type from the return value's type (via EscapeType unwrapping).
    testCompile(
        `
        func foo(): Num {
            return 42
        };
        foo()
        `,
        42
    );
    testCompile(
        `
        func add(a: Num, b: Num): Num {
            return a + b
        };
        add(3, 4)
        `,
        7
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
        func min(a: Num, b: Num) {
            if a < b {
                return a
            } else {
                return b
            }

            0
        };
        min(5, 3)
        `,
        3
    );
});

test("return: nested conditional return where Null value is not allowed", () => {
    // This is NOT okay, since the if-else statement here will have type Null
    // Which conflicts with what is returned.
    testParseExpectError(
        `
        func min(a: Num, b: Num) {
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
        func categorize(x: Num): Str {
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

test("return: if/elseif/else with escape branches resolves correctly", () => {
    // With Escape type, return branches are transparent and the else branch's type
    // determines the overall type. So the if/else if/else here has type Num.
    testCompile(
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
        `,
        2
    );
});

test("return: if/elseif with escape + separate expression", () => {
    // This IS okay, since the if/ifelse has type null (no else), and the 3 is a separate expression
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
        2
    );
});

test("return: return followed by semicolon", () => {
    testCompile(
        `
        func foo(): Num {
            if true {
                return 99;
            }
            0
        };
        foo()
        `,
        99
    );
});

test("return: return inside block inside function", () => {
    testCompile(
        `
        func foo(): Num {
            {
                return 99
            };
            0
        };
        foo()
        `,
        99
    );
});

test("return: return inside deeply nested blocks", () => {
    testCompile(
        `
        func foo(): Num {
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
        42
    );
});

test("return: return in a loop body", () => {
    testCompile(
        `
        func findFirst(): Num {
            for i = 1..10 {
                if i > 5 {
                    return i
                }
            };
            0
        };
        findFirst()
        `,
        6
    );
});

test("return: return in a chain of else-ifs", () => {
    testCompile(
        `
        func grade(score: Num): Str {
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
        mut out = []:Num | trans;
        for i = 1..5 {
            if i % 2 == 0 {
                continue
            };
            push(i, out)
        };
        out
        `,
        [1, 3, 5]
    );
});

test("continue: continue inside nested block in loop", () => {
    testCompile(
        `
        mut out = []:Num | trans;
        for i = 1..5 {
            {
                if i == 3 {
                    continue
                }
            };
            push(i, out)
        };
        out
        `,
        [1, 2, 4, 5]
    );
});

test("continue: continue with nested for loops", () => {
    testCompile(
        `
        mut out = []:Num | trans;
        for i = 1..3 {
            for j = 1..3 {
                if j == 2 {
                    continue
                };
                push(i * 10 + j, out)
            }
        };
        out
        `,
        [11, 13, 21, 23, 31, 33]
    );
});

// ============================================================
// Return + Continue combined
// ============================================================

test("return+continue: return exits loop early", () => {
    testCompile(
        `
        func firstEven(): Num {
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
        2
    );
});

test("return: return in braced block inside if-else branch", () => {
    testCompile(
        `
        func foo(): Num {
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
        1
    );
});

// ============================================================
// Break statement
// ============================================================

test("break: basic break in for loop", () => {
    testCompile(
        `
        mut out = []:Num | trans;
        for i = 1..5 {
            if i % 2 == 0 {
                break
            };
            push(i, out)
        };
        out
        `,
        [1]
    );
});

test("break: break inside nested block in loop", () => {
    testCompile(
        `
        mut out = []:Num | trans;
        for i = 1..5 {
            {
                if i == 3 {
                    break
                }
            };
            push(i, out)
        };
        out
        `,
        [1, 2]
    );
});

test("break: break with nested for loops", () => {
    testCompile(
        `
        mut out = []:Num | trans;
        for i = 1..3 {
            for j = 1..3 {
                if j == 2 {
                    break
                };
                push(i * 10 + j, out)
            }
        };
        out
        `,
        [11, 21, 31]
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
        func add(a: Num, b: Num): Num { a + b };
        add(3, 4)
        `,
        [],
        ["try {", "$Return$"]
    );
});

test("optimization: no try/catch in loop without break/continue", () => {
    testCompileAndCheck(
        `
        func sum(): Num {
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
        func foo() { return 1 };
        foo()
        `,
        ["return"],
        ["throw new $Return$", "try {"]
    );
});

test("optimization: direct break when not inside IIFE", () => {
    testCompileAndCheck(
        `
        func foo(): Num {
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
        func foo(): Num {
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
        func foo(): Num {
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
        func foo(): Num {
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
        func foo(): Num {
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
        func foo(): Num {
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
        func sign(x: Num) {
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
        ["return 1", "return (-(1))"],
        ["throw new $Return$", "try {"]
    );
});

test("optimization: return in nested if statement doesn't require try/catch", () => {
    testCompileAndCheck(
        `
        func superSign(x: Num) {
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
        ["return 2", "return 1", "return (-(1))", "return (-(2))"],
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

// ============================================================
// Escape type — match with return in some arms
// ============================================================

test("escape: match Maybe with return in none arm", () => {
    testCompile(
        `
        func addMaybe(a: Maybe[Num], b: Maybe[Num]) {
            a_unwrapped = match a {
                some(v) { v },
                none { return none:Num },
            };
            b_unwrapped = match b {
                some(v) { v },
                none { return none:Num },
            };
            some(a_unwrapped + b_unwrapped)
        };
        (addMaybe(some(3), some(4)), addMaybe(none:Num, some(4)))
        `,
        [7, null]
    );
});

test("escape: match enum with return in some variants", () => {
    testCompile(
        `
        enum Res[T, E] { ok: T, err: E }
        func unwrap(r: Res[Num, Str]): Num {
            match r {
                ok(v) { v },
                err(m) { return 0 },
            }
        };
        unwrap(Res[Num, Str].ok(42))
        `,
        42
    );
    testCompile(
        `
        enum Res[T, E] { ok: T, err: E }
        func unwrap(r: Res[Num, Str]): Num {
            match r {
                ok(v) { v },
                err(m) { return 0 },
            }
        };
        unwrap(Res[Num, Str].err("oops"))
        `,
        0
    );
});

test("escape: all match arms return gives Null type", () => {
    // When every arm has Escape type, the match resolves to Null.
    // Assigning Null to a variable is an error.
    testParseExpectError(
        `
        enum Foo { a, b }
        func foo(x: Foo): Num {
            y = match x {
                a { return 1 },
                b { return 2 },
            };
            0
        }
        `,
        "cannot assign null or escape value"
    );
});

test("match maybe with early break in for loop", () => {
    testCompile(
        `
        vals = [some(10), some(20), none:Num, some(30)];
        mut total = 0;
        for v = vals {
            total += match v {
                some(v) { v },
                none { break },
            }
        };
        total
        `,
        30
    );
});

test("match maybe with continue in for loop", () => {
    testCompile(
        `
        vals = [some(10), some(20), none:Num, some(30)];
        mut total = 0;
        for v = vals {
            total += match v {
                some(v) { v },
                none { continue },
            }
        };
        total
        `,
        60
    );
});

test("escape: match enum with break in for loop", () => {
    testCompile(
        `
        enum Action { add: Num, stop }
        actions = [Action.add(10), Action.add(20), Action.stop, Action.add(30)];
        mut total = 0;
        for action = actions {
            total += match action {
                add(v) { v },
                stop { break },
            }
        };
        total
        `,
        30
    );
});

test("escape: match enum with continue in for loop", () => {
    testCompile(
        `
        enum Action { add: Num, skip }
        actions = [Action.add(10), Action.skip, Action.add(20), Action.add(30)];
        mut total = 0;
        for action = actions {
            total += match action {
                add(v) { v },
                skip { continue },
            }
        };
        total
        `,
        60
    );
});

test("escape: function with only return statements", () => {
    testCompile(
        `
        func always42(): Num {
            return 42
        };
        always42()
        `,
        42
    );
});

test("escape: function with only return statement (inferred return type)", () => {
    testCompile(
        `
        func always42() {
            return 42
        };
        always42()
        `,
        42
    );
});

test("escape: cannot assign escape value directly", () => {
    testParseExpectError("x = return 5");
});

test("escape: return inside nested block in function", () => {
    testCompile(
        `
        func foo(): Num {
            {
                return 99
            }
        };
        foo()
        `,
        99
    );
});
