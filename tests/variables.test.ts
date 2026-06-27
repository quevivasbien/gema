import { test } from "bun:test";

import { testCompile, testParse, testParseExpectError } from "./helpers";

test("compile variables", () => {
    testCompile(
        `
            x = 1.2;
            y = { 2.3 };
            x + y
        `,
        3.5
    );
    testCompile(
        `
            mut x = 1.2;
            y = { 2.3 }
            x = x + y
        `,
        3.5
    );
});

test("parse variable assignment", () => {
    testParse(`
        x = 1.22;
        y = { 1.23 };
        z = 3.13
    `);
    testParseExpectError(`x = 1.0; x = 1`);
    testParseExpectError(`x = 2;`); // Semicolon discards value
});

test("variable assignment within parentheses", () => {
    testCompile("(x = 1)", 1);
    testCompile("(x = 1); x", 1);
});

test("chained variable assignment", () => {
    testCompile("x = y = 2", 2);
    testCompile("x = (y = 2)", 2);
    testCompile("x = (y = 2); (x, y)", [2, 2]);
    testCompile("x = y = 2; (x, y)", [2, 2]);
    testParseExpectError("(x = y) = 2");
});

test("parse mutable variable reassignment", () => {
    testParse(`mut x = 1; x = 2`);
    testParse(`mut x = 1.22; x = 3.; x`);
    testParseExpectError(`x = 1; x = 2; x`);
});

// ============================================================
// `mut` keyword + variable reassignment
// ============================================================

// ── Basic mutable variable behavior ──

test("mut: basic declaration and read", () => {
    testCompile("mut x = 1; x", 1);
    testCompile("mut x = true; x", true);
    testCompile('mut x = "hello"; x', "hello");
    testCompile("mut x = 1.5; x", 1.5);
});

test("mut: reassign same type", () => {
    testCompile("mut x = 1; x = 2; x", 2);
    testCompile("mut x = 1; x = x + 1; x", 2);
    testCompile("mut x = 10; x = 0; x", 0);
    testCompile("mut x = true; x = false; x", false);
    testCompile('mut x = "a"; x = "b"; x', "b");
    testCompile("mut x = 1.5; x = 2.5; x", 2.5);
    testCompile("mut x = [1, 2]; x = [3, 4]; x", [3, 4]);
});

test("mut: multiple reassignments", () => {
    testCompile(
        `
        mut x = 0;
        x = 1;
        x = 2;
        x
        `,
        2
    );
});

test("mut: reassignment with expression", () => {
    testCompile("mut x = 1; x = x * 3 + 2; x", 5);
});

// ── Non-mut cannot be reassigned ──

test("mut: non-mut variable cannot be reassigned", () => {
    testParseExpectError("x = 1; x = 2");
    testParseExpectError("x = 1; x = x + 1");
    testParseExpectError("x = true; x = false");
    testParseExpectError('x = "a"; x = "b"');
    testParseExpectError("x = 1.5; x = 2.5");
});

// ── Type mismatch on mutable reassignment ──

test("mut: type mismatch on reassignment errors", () => {
    testParseExpectError("mut x = 1; x = true");
    testParseExpectError("mut x = 1i; x = 1.5");
    testParseExpectError('mut x = 1; x = "hello"');
    testParseExpectError("mut x = true; x = 1");
    testParseExpectError("mut x = [1, 2]; x = [true, false]");
});

// ── Double declaration errors ──

test("mut: double declaration errors", () => {
    testParseExpectError("mut x = 1; mut x = 2");
    testParseExpectError("mut x = 1; x = 2; mut x = 3");
    testParseExpectError("x = 1; mut x = 2");
});

// ── Shadowing of mutable vars ──

test("mut: shadowing in nested block", () => {
    // Inner mut x attempts to shadow outer mut x
    testParseExpectError(
        `
        mut x = 1;
        {
            mut x = 2;
            x
        }
        `
    );
});

test("mut: shadowing in separate sibling blocks", () => {
    testCompile(
        `{ mut x = 1; x } { mut x = 2; x }`,
        2 // last expression
    );
});

// Shadowing from non-mut to mut is NOT allowed
test("mut: cannot shadow with mut if outer is non-mut", () => {
    testParseExpectError("x = 1; { mut x = 2 }");
});

// ── Mutable var in function body ──

test("mut: mutable var in function body", () => {
    testCompile(
        `
        func f(): Num {
            mut x = 1;
            x = 2;
            x
        };
        f()
        `,
        2
    );
});

test("mut: mutable var across function calls", () => {
    // Each call to f gets its own fresh x
    testCompile(
        `
        func f(): Num {
            mut x = 1;
            x = x + 1;
            x
        };
        f();
        f()
        `,
        2
    );
});

// ── Mutable var in if-else branches ──

test("mut: reassign in if-else branches", () => {
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
    testCompile(
        `
        mut x = 1;
        if false {
            x = 2
        } else {
            x = 3
        };
        x
        `,
        3
    );
});

test("mut: reassign in else-if chain", () => {
    testCompile(
        `
        mut x = 0;
        if x == 0 {
            x = 10
        } else if x == 1 {
            x = 20
        } else {
            x = 30
        };
        x
        `,
        10
    );
});

// ── Anonymous function capture (closures) ──

test("mut: closure captures mutable var", () => {
    // Function captures mut x from enclosing scope
    testCompile(
        `
        mut x = 1;
        f = func() { x = x + 1; x };
        f()
        `,
        2
    );
    // Multiple calls mutate the same captured x
    testCompile(
        `
        mut x = 1;
        f = func() { x = x + 1; x };
        f();
        f();
        x
        `,
        3
    );
});

test("mut: multiple closures share captured mutable var", () => {
    testCompile(
        `
        mut x = 0;
        inc = func() { x = x + 1; x };
        dec = func() { x = x - 1; x };
        inc();
        inc();
        dec();
        x
        `,
        1
    );
});

test("mut: each call to factory gets own mutable var", () => {
    testCompile(
        `
        func makeCounter(): Func[:Num] {
            mut count = 0;
            func() {
                count = count + 1;
                count
            }
        };
        a = makeCounter();
        b = makeCounter();
        a();
        a();
        b();
        b()
        `,
        2
    );
});

// ── Mutable var flow sensitivity ──

test("mut: type must stay consistent across all branches", () => {
    // Both branches reassign same type → ok
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
    // Error: one branch tries to change type
    testParseExpectError(`
        mut x = 1;
        if true {
            x = 2
        } else {
            x = true
        };
        x
    `);
});

// ── Edge: mut on declaration only, not on reassignment ──

test("mut: mut keyword only valid on first declaration", () => {
    testParseExpectError("mut x = 1; mut x = 2");
    // Reassignment doesn't use 'mut' keyword
    testCompile("mut x = 1; x = 2; x", 2);
});

// ── Edge: mut inside nested blocks ──

test("mut: inside deeply nested blocks", () => {
    testCompile(
        `
        mut x = 0;
        {
            {
                x = 1
            }
        };
        x
        `,
        1
    );
});

test("mut: inner block cannot reassign non-mut outer var", () => {
    testParseExpectError(`
        x = 0;
        {
            x = 1
        }
    `);
});

// ── Edge: function parameter names vs mut ──

test("mut: function parameter shadows outer mut var", () => {
    // Parameter x shadows outer mut x inside function body
    testCompile(
        `
        mut x = 1;
        func f(x: Num): Num { x };
        f(99)
        `,
        99
    );
    // Outer x is unchanged
    testCompile(
        `
        mut x = 1;
        func f(x: Num): Num { x };
        f(99);
        x
        `,
        1
    );
});

// ============================================================
// Compound assignment operators (+=, -=, *=, /=)
// ============================================================

// ── Basic compound assignment on mutable vars ──

test("compound: basic add-assign", () => {
    testCompile("mut x = 1; x += 1; x", 2);
    testCompile("mut x = 0; x += 5; x", 5);
});

test("compound: basic subtract-assign", () => {
    testCompile("mut x = 10; x -= 3; x", 7);
    testCompile("mut x = 5; x -= 5; x", 0);
});

test("compound: basic multiply-assign", () => {
    testCompile("mut x = 3; x *= 4; x", 12);
    testCompile("mut x = 7; x *= 0; x", 0);
});

test("compound: basic integer divide-assign", () => {
    testCompile("mut x = 10; x //= 3; x", 3);
    testCompile("mut x = 12; x //= 4; x", 3);
});

test("compound: basic float divide-assign", () => {
    testCompile("mut x = 10; x /= 4; x", 2.5);
    testCompile("mut x = 12; x /= 4; x", 3);
});

test("compound: basic modulo-assign", () => {
    testCompile("mut x = 10; x %= 3; x", 1);
    testCompile("mut x = 7; x %= 5; x", 2);
});

test("compound: basic exponentiation-assign", () => {
    testCompile("mut x = 2; x ^= 3; x", 8);
    testCompile("mut x = 3; x ^= 2; x", 9);
});

// ── Compound with expressions on RHS ──

test("compound: expression on right side", () => {
    testCompile("mut x = 1; x += 2 * 3; x", 7);
    testCompile("mut x = 10; x -= 2 + 1; x", 7);
    testCompile("mut x = 2; x *= 3 + 1; x", 8);
    testCompile("mut x = 100; x /= 5 + 5; x", 10);
    testCompile("mut x = 10; x %= 2 + 1; x", 1);
    testCompile("mut x = 2; x ^= 1 + 2; x", 8);
});

// ── Chained compound assignments ──

test("compound: chained operations", () => {
    testCompile(
        `
        mut x = 1;
        x += 1;
        x += 2;
        x += 3;
        x
        `,
        7
    );
    testCompile(
        `
        mut x = 100;
        x -= 10;
        x *= 2;
        x /= 5;
        x
        `,
        36
    );
    testCompile(
        `
        mut x = 10;
        x %= 6;
        x ^= 2;
        x
        `,
        16
    );
});

// ── Compound with different numeric types ──

test("compound: float types", () => {
    testCompile("mut x = 1.5; x += 1.5; x", 3.0);
    testCompile("mut x = 10.0; x -= 2.5; x", 7.5);
    testCompile("mut x = 3.0; x *= 2.5; x", 7.5);
    testCompile("mut x = 9.0; x /= 3.0; x", 3.0);
});

test("compound: bigint += float is an error", () => {
    testParseExpectError("mut x = 1i; x += 1.5");
});

// ── Compound on arrays (concatenation) ──

test("compound: array concat with +=", () => {
    testCompile("mut arr = [1, 2]; arr += [3]; arr", [1, 2, 3]);
    testCompile("mut arr = [1]; arr += [2]; arr += [3]; arr", [1, 2, 3]);
    testCompile("mut arr = []: Num; arr += [1]; arr", [1]);
});

// ── Compound on strings (concatenation) ──

test("compound: string concat with +=", () => {
    testCompile('mut s = "hello "; s += "world"; s', "hello world");
    testCompile('mut s = ""; s += "a"; s += "b"; s', "ab");
});

// ── Compound with operator overloading on structs ──

test("compound: struct add with +=", () => {
    testCompile(
        `
        struct Point { x: Num, y: Num };
        func add(a: Point, b: Point): Point { Point(a.x + b.x, a.y + b.y) };
        mut p = Point(1, 2);
        p += Point(3, 4);
        p.x + p.y
        `,
        10
    );
});

test("compound: struct subtract with -=", () => {
    testCompile(
        `
        struct Point { x: Num, y: Num };
        func subtract(a: Point, b: Point): Point { Point(a.x - b.x, a.y - b.y) };
        mut p = Point(5, 6);
        p -= Point(3, 2);
        p.x + p.y
        `,
        6
    );
});

test("compound: struct multiply with *=", () => {
    testCompile(
        `
        struct Point { x: Num, y: Num };
        func multiply(a: Point, b: Point): Point { Point(a.x * b.x, a.y * b.y) };
        mut p = Point(2, 3);
        p *= Point(4, 5);
        p.x + p.y
        `,
        23
    );
});

// ── Compound inside cross-block / closure context ──

test("compound: reassign outer mut from nested block", () => {
    testCompile(
        `
        mut x = 1;
        {
            x += 2
        };
        x
        `,
        3
    );
});

// ── Error: compound on non-mutable variable ──

test("compound: error on non-mutable variable", () => {
    testParseExpectError("x = 1; x += 1");
    testParseExpectError("x = 10; x -= 5");
    testParseExpectError("x = 3; x *= 2");
    testParseExpectError("x = 10; x /= 2");
    testParseExpectError("x = 10; x %= 3");
    testParseExpectError("x = 2; x ^= 3");
});

// ── Error: type mismatch in compound ──

test("compound: type mismatch errors", () => {
    testParseExpectError("mut x = 1; x += true");
    testParseExpectError("mut x = 1; x -= true");
    testParseExpectError("mut x = true; x += 1");
    testParseExpectError("mut x = 1; x *= true");
    testParseExpectError('mut x = 1; x /= "hello"');
});

// ── Error: unsupported compound operators on non-numeric types ──

test("compound: unsupported operator on string", () => {
    testParseExpectError('mut s = "hello"; s -= "o"');
    testParseExpectError('mut s = "hello"; s *= 2');
    testParseExpectError('mut s = "hello"; s /= 2');
});

// ── Error: compound as expression (compound is statement-only) ──

test("compound: used in non-assignment context", () => {
    // x += 1 where x doesn't exist yet
    testParseExpectError("x += 1");
});

// ── Edge: boolean logical operators NOT included ──

test("compound: no and=/or= operators", () => {
    testParseExpectError("mut x = true; x and= false");
    testParseExpectError("mut x = true; x or= false");
});
