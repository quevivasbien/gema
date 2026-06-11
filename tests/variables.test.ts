import { test } from "bun:test";

import { testCompile, testCompileError, testParse, testParseExpectError } from "./helpers";

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
        x = 1.22
        y = { 1.23 }
        z = 3.13;
    `);
    testParseExpectError(`x = 1.0; x = 1;`);
    testParseExpectError(`x = y = 2`);
    testParseExpectError(`x = y = 2;`);
});

test("parse mutable variable reassignment", () => {
    testParse(`mut x = 1; x = 2;`);
    testParse(`mut x = 1.22; x = 3.;`);
    testParseExpectError(`x = 1; x = 2;`);
});

// ============================================================
// `mut` keyword + variable reassignment
// ============================================================

// ── Basic mutable variable behavior ──

test("mut: basic declaration and read", () => {
    testCompile("mut x = 1; x", 1n);
    testCompile("mut x = true; x", true);
    testCompile('mut x = "hello"; x', "hello");
    testCompile("mut x = 1.5; x", 1.5);
});

test("mut: reassign same type", () => {
    testCompile("mut x = 1; x = 2; x", 2n);
    testCompile("mut x = 1; x = x + 1; x", 2n);
    testCompile("mut x = 10; x = 0; x", 0n);
    testCompile("mut x = true; x = false; x", false);
    testCompile('mut x = "a"; x = "b"; x', "b");
    testCompile("mut x = 1.5; x = 2.5; x", 2.5);
    testCompile("mut x = [1, 2]; x = [3, 4]; x", [3n, 4n]);
});

test("mut: multiple reassignments", () => {
    testCompile(
        `
        mut x = 0;
        x = 1;
        x = 2;
        x
        `,
        2n
    );
});

test("mut: reassignment with expression", () => {
    testCompile("mut x = 1; x = x * 3 + 2; x", 5n);
});

// ── Non-mut cannot be reassigned ──

test("mut: non-mut variable cannot be reassigned", () => {
    testCompileError("x = 1; x = 2");
    testCompileError("x = 1; x = x + 1");
    testCompileError("x = true; x = false");
    testCompileError('x = "a"; x = "b"');
    testCompileError("x = 1.5; x = 2.5");
});

// ── Type mismatch on mutable reassignment ──

test("mut: type mismatch on reassignment errors", () => {
    testCompileError("mut x = 1; x = true");
    testCompileError("mut x = 1; x = 1.5");
    testCompileError('mut x = 1; x = "hello"');
    testCompileError("mut x = true; x = 1");
    testCompileError("mut x = [1, 2]; x = [true, false]");
});

// ── Double declaration errors ──

test("mut: double declaration errors", () => {
    testCompileError("mut x = 1; mut x = 2");
    testCompileError("mut x = 1; x = 2; mut x = 3");
    testCompileError("x = 1; mut x = 2");
});

// ── Shadowing (like JS let) ──

test("mut: shadowing in nested block", () => {
    // Inner mut x shadows outer mut x
    testCompile(
        `
        mut x = 1;
        {
            mut x = 2;
            x
        }
        `,
        2n
    );
    // Outer x is unchanged after inner block
    testCompile(
        `
        mut x = 1;
        {
            mut x = 2
        };
        x
        `,
        1n
    );
});

test("mut: shadowing in separate sibling blocks", () => {
    testCompile(
        `{ mut x = 1; x }
{ mut x = 2; x }`,
        2n // last expression
    );
});

// Shadowing from non-mut to mut is NOT allowed
test("mut: cannot shadow with mut if outer is non-mut", () => {
    testCompileError("x = 1; { mut x = 2 }");
});

// ── Mutable var in function body ──

test("mut: mutable var in function body", () => {
    testCompile(
        `
        func f(): Int {
            mut x = 1;
            x = 2;
            x
        };
        f()
        `,
        2n
    );
});

test("mut: mutable var across function calls", () => {
    // Each call to f gets its own fresh x
    testCompile(
        `
        func f(): Int {
            mut x = 1;
            x = x + 1;
            x
        };
        f();
        f()
        `,
        2n
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
        2n
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
        3n
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
        10n
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
        2n
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
        3n
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
        1n
    );
});

test("mut: each call to factory gets own mutable var", () => {
    testCompile(
        `
        func makeCounter(): Func[:Int] {
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
        2n
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
        2n
    );
    // Error: one branch tries to change type
    testCompileError(`
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
    testCompileError("mut x = 1; mut x = 2");
    // Reassignment doesn't use 'mut' keyword
    testCompile("mut x = 1; x = 2; x", 2n);
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
        1n
    );
});

test("mut: inner block cannot reassign non-mut outer var", () => {
    testCompileError(`
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
        func f(x: Int): Int { x };
        f(99)
        `,
        99n
    );
    // Outer x is unchanged
    testCompile(
        `
        mut x = 1;
        func f(x: Int): Int { x };
        f(99);
        x
        `,
        1n
    );
});

// ============================================================
// Compound assignment operators (+=, -=, *=, /=)
// ============================================================

// ── Basic compound assignment on mutable vars ──

test("compound: basic add-assign", () => {
    testCompile("mut x = 1; x += 1; x", 2n);
    testCompile("mut x = 0; x += 5; x", 5n);
});

test("compound: basic subtract-assign", () => {
    testCompile("mut x = 10; x -= 3; x", 7n);
    testCompile("mut x = 5; x -= 5; x", 0n);
});

test("compound: basic multiply-assign", () => {
    testCompile("mut x = 3; x *= 4; x", 12n);
    testCompile("mut x = 7; x *= 0; x", 0n);
});

test("compound: basic divide-assign", () => {
    testCompile("mut x = 10; x /= 3; x", 3n);
    testCompile("mut x = 12; x /= 4; x", 3n);
});

test("compound: basic modulo-assign", () => {
    testCompile("mut x = 10; x %= 3; x", 1n);
    testCompile("mut x = 7; x %= 5; x", 2n);
});

test("compound: basic exponentiation-assign", () => {
    testCompile("mut x = 2; x ^= 3; x", 8n);
    testCompile("mut x = 3; x ^= 2; x", 9n);
});

// ── Compound with expressions on RHS ──

test("compound: expression on right side", () => {
    testCompile("mut x = 1; x += 2 * 3; x", 7n);
    testCompile("mut x = 10; x -= 2 + 1; x", 7n);
    testCompile("mut x = 2; x *= 3 + 1; x", 8n);
    testCompile("mut x = 100; x /= 5 + 5; x", 10n);
    testCompile("mut x = 10; x %= 2 + 1; x", 1n);
    testCompile("mut x = 2; x ^= 1 + 2; x", 8n);
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
        7n
    );
    testCompile(
        `
        mut x = 100;
        x -= 10;
        x *= 2;
        x /= 5;
        x
        `,
        36n
    );
    testCompile(
        `
        mut x = 10;
        x %= 6;
        x ^= 2;
        x
        `,
        16n
    );
});

// ── Compound with different numeric types ──

test("compound: float types", () => {
    testCompile("mut x = 1.5; x += 1.5; x", 3.0);
    testCompile("mut x = 10.0; x -= 2.5; x", 7.5);
    testCompile("mut x = 3.0; x *= 2.5; x", 7.5);
    testCompile("mut x = 9.0; x /= 3.0; x", 3.0);
});

test("compound: int += float promotes to float", () => {
    // x is Int, 1.5 is Float → x + 1.5 is Float → but reassigning Int with Float errors
    testCompileError("mut x = 1; x += 1.5");
});

// ── Compound on arrays (concatenation) ──

test("compound: array concat with +=", () => {
    testCompile("mut arr = [1, 2]; arr += [3]; arr", [1n, 2n, 3n]);
    testCompile("mut arr = [1]; arr += [2]; arr += [3]; arr", [1n, 2n, 3n]);
    testCompile("mut arr = []: Int; arr += [1]; arr", [1n]);
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
        struct Point { x: Int, y: Int };
        func add(a: Point, b: Point): Point { Point(a.x + b.x, a.y + b.y) };
        mut p = Point(1, 2);
        p += Point(3, 4);
        p.x + p.y
        `,
        10n
    );
});

test("compound: struct subtract with -=", () => {
    testCompile(
        `
        struct Point { x: Int, y: Int };
        func subtract(a: Point, b: Point): Point { Point(a.x - b.x, a.y - b.y) };
        mut p = Point(5, 6);
        p -= Point(3, 2);
        p.x + p.y
        `,
        6n
    );
});

test("compound: struct multiply with *=", () => {
    testCompile(
        `
        struct Point { x: Int, y: Int };
        func multiply(a: Point, b: Point): Point { Point(a.x * b.x, a.y * b.y) };
        mut p = Point(2, 3);
        p *= Point(4, 5);
        p.x + p.y
        `,
        23n
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
        3n
    );
});

// ── Error: compound on non-mutable variable ──

test("compound: error on non-mutable variable", () => {
    testCompileError("x = 1; x += 1");
    testCompileError("x = 10; x -= 5");
    testCompileError("x = 3; x *= 2");
    testCompileError("x = 10; x /= 2");
    testCompileError("x = 10; x %= 3");
    testCompileError("x = 2; x ^= 3");
});

// ── Error: type mismatch in compound ──

test("compound: type mismatch errors", () => {
    testCompileError("mut x = 1; x += true");
    testCompileError("mut x = 1; x -= true");
    testCompileError("mut x = true; x += 1");
    testCompileError("mut x = 1; x *= true");
    testCompileError('mut x = 1; x /= "hello"');
});

// ── Error: unsupported compound operators on non-numeric types ──

test("compound: unsupported operator on string", () => {
    testCompileError('mut s = "hello"; s -= "o"');
    testCompileError('mut s = "hello"; s *= 2');
    testCompileError('mut s = "hello"; s /= 2');
});

// ── Error: compound as expression (compound is statement-only) ──

test("compound: used in non-assignment context", () => {
    // x += 1 where x doesn't exist yet
    testCompileError("x += 1");
});

// ── Edge: boolean logical operators NOT included ──

test("compound: no and=/or= operators", () => {
    testCompileError("mut x = true; x and= false");
    testCompileError("mut x = true; x or= false");
});
