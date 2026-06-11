import { expect, test } from "bun:test";
import { parse } from "../src/parse";
import { scan } from "../src/scan";
import { writeJS } from "../src/write-js";
import { resetRegistries } from "../src/ast";

/**
 * Helper: parse + compile a Gema program, then eval the JS.
 * If expectEqual is null, returns the JS string without evaluating.
 * Otherwise asserts the final expression equals expectEqual.
 */
function testCompile(text: string, expectEqual: any) {
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
 * Helper: assert that a program produces one or more parse/type errors.
 */
function testCompileError(text: string) {
    resetRegistries();
    const tokens = scan(text);
    const { ast, errors } = parse(tokens);
    expect(errors.length).toBeGreaterThan(0);
}

// ============================================================
// PHASE 1: `mut` keyword + variable reassignment
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
// PHASE 2: Compound assignment operators (+=, -=, *=, /=)
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
    testCompileError("mut x = 1; x /= \"hello\"");
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

// ============================================================
// PHASE 3: Mutable struct fields
// ============================================================

// ── Basic field mutation ──

test("field: mutate mutable field with =", () => {
    testCompile(
        `
        struct Point { mut x: Int, mut y: Int };
        p = Point(1, 2);
        p.x = 5;
        p.x
        `,
        5n
    );
});

test("field: mutate multiple mutable fields", () => {
    testCompile(
        `
        struct Point { mut x: Int, mut y: Int };
        p = Point(1, 2);
        p.x = 10;
        p.y = 20;
        p.x + p.y
        `,
        30n
    );
});

test("field: mutate mutable string field", () => {
    testCompile(
        `
        struct S { mut val: Str };
        s = S("hi");
        s.val = "hello";
        s.val
        `,
        "hello"
    );
});

test("field: mutate mutable bool field", () => {
    testCompile(
        `
        struct S { mut flag: Bool };
        s = S(true);
        s.flag = false;
        s.flag
        `,
        false
    );
});

// ── Reading fields (mutable or not) still works ──

test("field: read non-mut field still works", () => {
    testCompile(
        `
        struct S { x: Int };
        s = S(42);
        s.x
        `,
        42n
    );
});

test("field: read mut field also works", () => {
    testCompile(
        `
        struct S { mut x: Int };
        s = S(99);
        s.x
        `,
        99n
    );
});

// ── Compound assignment on mutable fields ──

test("field: compound += on mutable field", () => {
    testCompile(
        `
        struct Point { mut x: Int, mut y: Int };
        p = Point(1, 2);
        p.x += 3;
        p.x
        `,
        4n
    );
});

test("field: compound -= on mutable field", () => {
    testCompile(
        `
        struct Point { mut x: Int, mut y: Int };
        p = Point(5, 6);
        p.x -= 2;
        p.x
        `,
        3n
    );
});

test("field: compound *= on mutable field", () => {
    testCompile(
        `
        struct Point { mut x: Int, mut y: Int };
        p = Point(2, 3);
        p.x *= 4;
        p.x
        `,
        8n
    );
});

test("field: compound /= on mutable field", () => {
    testCompile(
        `
        struct Point { mut x: Int, mut y: Int };
        p = Point(10, 3);
        p.x /= 3;
        p.x
        `,
        3n
    );
});

test("field: compound %= on mutable field", () => {
    testCompile(
        `
        struct Point { mut x: Int, mut y: Int };
        p = Point(10, 3);
        p.x %= 6;
        p.x
        `,
        4n
    );
});

test("field: compound ^= on mutable field", () => {
    testCompile(
        `
        struct Point { mut x: Int, mut y: Int };
        p = Point(2, 3);
        p.x ^= 3;
        p.x
        `,
        8n
    );
});

// ── Mutating field via nested block (reassigns field on outer struct) ──

test("field: mutate field from nested block", () => {
    testCompile(
        `
        struct Point { mut x: Int };
        p = Point(1);
        {
            p.x = 5
        };
        p.x
        `,
        5n
    );
});

// ── Mut struct var does NOT make fields mutable ──

test("field: mut var doesn't make non-mut field mutable", () => {
    testCompileError(`
        struct S { x: Int };
        mut s = S(1);
        s.x = 2
    `);
});

// ── Error: assign to non-mut field ──

test("field: error assigning to non-mutable field", () => {
    testCompileError(`
        struct S { x: Int };
        s = S(1);
        s.x = 2
    `);
});

// ── Error: assign to non-existent field ──

test("field: error assigning to non-existent field", () => {
    testCompileError(`
        struct S { mut x: Int };
        s = S(1);
        s.y = 2
    `);
});

// ── Error: type mismatch on field assignment ──

test("field: error type mismatch on field assignment", () => {
    testCompileError(`
        struct S { mut x: Int };
        s = S(1);
        s.x = true
    `);
});

test("field: error type mismatch on compound field assignment", () => {
    testCompileError(`
        struct S { mut x: Int };
        s = S(1);
        s.x += true
    `);
});

// ── Error: compound on non-mut field ──

test("field: error compound on non-mutable field", () => {
    testCompileError(`
        struct S { x: Int };
        s = S(1);
        s.x += 2
    `);
});

// ── Error: assign to field on non-struct type ──

test("field: error assigning field on non-struct", () => {
    testCompileError(`
        x = 1;
        x.y = 2
    `);
});

// ── Struct with mixed mutable and immutable fields ──

test("field: mixed mut and non-mut fields", () => {
    testCompile(
        `
        struct HalfMut { mut x: Int, y: Int };
        q = HalfMut(1, 2);
        q.x = 10;
        q.x + q.y
        `,
        12n
    );
    // Non-mut field cannot be mutated
    testCompileError(`
        struct HalfMut { mut x: Int, y: Int };
        q = HalfMut(1, 2);
        q.y = 20
    `);
});

// ── Mutating field through multiple levels of struct nesting ──

test("field: nested struct with mutable fields", () => {
    testCompile(
        `
        struct Inner { mut val: Int };
        struct Outer { inner: Inner };
        o = Outer(Inner(1));
        o.inner.val = 5;
        o.inner.val
        `,
        5n
    );
});


test("field: mutable struct fields from vars", () => {
    testCompile(
        `
        struct S { mut a: Int };
        x = 1;
        s = S(x);
        s.a = 2;
        x
        `,
        1n
    );
    testCompile(
        `
        struct S { mut a: Int };
        mut x = 1;
        s = S(x);
        s.a = 2;
        x
        `,
        1n
    );
    testCompile(
        `
        struct S { mut a: Arr[Int] };
        x = [1];
        s = S(x);
        s.a = [2];
        x
        `,
        [1n]
    );
});

test("field: mutable struct fields with keyword constructors", () => {
    testCompile(
        `
        struct S { mut a: Int };
        s = S(a=1);
        s.a = 2
        `,
        2n
    );
    testCompile(
        `
        struct S { mut a: Int, b: Int };
        s = S(b=1, a=2);
        s.a = 3;
        s.a
        `,
        3n
    );
    testCompile(
        `
        struct S { mut a: Int };
        x = 1;
        s = S(a=x);
        s.a = s.a + 1;
        s.a
        `,
        2n
    );
});

// ============================================================
// PHASE 4: Mutable arrays (MutArr[T])
// ============================================================

// ── Creating mutable arrays ──

test("mutarr: create empty", () => {
    testCompile("mutarr = trans([]:Int); detrans(mutarr)", []);
});

test("mutarr: create from array", () => {
    testCompile("mutarr = trans([1, 2, 3]); detrans(mutarr)", [1n, 2n, 3n]);
});

test("mutarr: create from array with strings or bools", () => {
    testCompile('mutarr = trans(["a", "b"]); detrans(mutarr)', ["a", "b"]);
    testCompile("mutarr = trans([true, false]); detrans(mutarr)", [true, false]);
});

// ── push elements ──

test("mutarr: push elements", () => {
    testCompile(
        `
        mutarr = trans([]:Int);
        push(mutarr, 1);
        push(mutarr, 2);
        push(mutarr, 3);
        detrans(mutarr)
        `,
        [1n, 2n, 3n]
    );
});

test("mutarr: push returns the array", () => {
    testCompile(
        `mutarr = trans([]:Int); push(mutarr, 10); detrans(mutarr)`,
        [10n]
    );
    testCompile(
        `mutarr = trans([1, 2]); push(mutarr, 3); detrans(mutarr)`,
        [1n, 2n, 3n]
    );
});

// ── set element ──

test("mutarr: set element", () => {
    testCompile(
        `
        mutarr = trans([1, 2, 3]);
        set(mutarr, 1, 99);
        detrans(mutarr)
        `,
        [1n, 99n, 3n]
    );
});

test("mutarr: set returns new value", () => {
    testCompile("mutarr = trans([1, 2, 3]); set(mutarr, 0, 99)", 99n);
});

// ── Element access (indexing) ──

test("mutarr: element access via indexing", () => {
    testCompile("mutarr = trans([10, 20, 30]); mutarr(0)", 10n);
    testCompile("mutarr = trans([10, 20, 30]); mutarr(2)", 30n);
});

test("mutarr: length on MutArr", () => {
    testCompile("mutarr = trans([1, 2, 3]); length(mutarr)", 3n);
    testCompile("mutarr = trans([]:Int); length(mutarr)", 0n);
});

test("mutarr: last on MutArr", () => {
    testCompile("mutarr = trans([10, 20, 30]); last(mutarr)", 30n);
    testCompile("mutarr = trans([42]); last(mutarr)", 42n);
});

// ── trans() makes a deep copy ──

test("mutarr: trans creates deep copy", () => {
    // Make a mutable copy, mutate it
    testCompile(
        `x = [1, 2, 3]; y = trans(x); set(y, 0, 99); detrans(y)`,
        [99n, 2n, 3n]
    );
    // Original should be unaffected
    testCompile(
        `x = [1, 2, 3]; y = trans(x); set(y, 0, 99); x`,
        [1n, 2n, 3n]
    );
});

// ── unsafeTrans — no copy ──

test("mutarr: unsafeTrans shares the array", () => {
    testCompile(
        `x = [1, 2, 3]; y = unsafeTrans(x); set(y, 0, 99); detrans(y)`,
        [99n, 2n, 3n]
    );
    // With unsafeTrans, the original is also affected
    testCompile(
        `x = [1, 2, 3]; y = unsafeTrans(x); set(y, 0, 99); x`,
        [99n, 2n, 3n]
    );
});

// ── detrans then use as regular array ──

test("mutarr: detransed array can be used normally", () => {
    testCompile(
        `mutarr = trans([1, 2, 3]); arr = detrans(mutarr); @map(func(x: Int){ x + 1 }, arr)`,
        [2n, 3n, 4n]
    );
    testCompile(
        `mutarr = trans([1, 2, 3]); arr = detrans(mutarr); arr(0)`,
        1n
    );
});

// ── Multiple operations chained ──

test("mutarr: push after set after push", () => {
    testCompile(
        `
        mutarr = trans([]:Int);
        push(mutarr, 1);
        push(mutarr, 2);
        set(mutarr, 0, 99);
        push(mutarr, 3);
        detrans(mutarr)
        `,
        [99n, 2n, 3n]
    );
});

// ── MutArr as function parameter ──

test("mutarr: pass mutarr to function", () => {
    testCompile(
        `
        func addOne(mutarr: MutArr[Int]) {
            set(mutarr, 0, mutarr(0) + 1)
        };
        mutarr = trans([1, 2, 3]);
        addOne(mutarr);
        detrans(mutarr)
        `,
        [2n, 2n, 3n]
    );
});

// ── Scope tests ──

test("mutarr: mutate via nested block", () => {
    testCompile(
        `
        mutarr = trans([1, 2, 3]);
        {
            set(mutarr, 0, 99)
        };
        detrans(mutarr)
        `,
        [99n, 2n, 3n]
    );
});

test("mutarr: mutate via closure", () => {
    testCompile(
        `
        mutarr = trans([1, 2, 3]);
        f = func() { set(mutarr, 0, 99) };
        f();
        detrans(mutarr)
        `,
        [99n, 2n, 3n]
    );
});

test("mutarr: pass mutarr into function and push", () => {
    testCompile(
        `
        func addOne(m: MutArr[Int]) {
            push(m, 1)
        };
        mutarr = trans([]:Int);
        addOne(mutarr);
        addOne(mutarr);
        detrans(mutarr)
        `,
        [1n, 1n]
    );
});

// ── Use-after-detrans error ──

test("mutarr: error use after detrans", () => {
    testCompileError(`
        mutarr = trans([1, 2, 3]);
        arr = detrans(mutarr);
        push(mutarr, 4)
    `);
    testCompileError(`
        mutarr = trans([1, 2, 3]);
        arr = detrans(mutarr);
        set(mutarr, 0, 99)
    `);
});

// ── Error cases ──

test("mutarr: error trans on non-array", () => {
    testCompileError("trans(1)");
    testCompileError('trans("hello")');
    testCompileError("trans(true)");
});

test("mutarr: error unsafeTrans on non-array", () => {
    testCompileError("unsafeTrans(1)");
});

test("mutarr: error detrans on non-mut-array", () => {
    testCompileError("detrans([1, 2, 3])");
    testCompileError("detrans(1)");
});

test("mutarr: error push on non-mut-array", () => {
    testCompileError("push([1, 2], 3)");
});

test("mutarr: error set on non-mut-array", () => {
    testCompileError("set([1, 2], 0, 99)");
});

test("mutarr: error push type mismatch", () => {
    testCompileError(`mutarr = trans([1, 2]); push(mutarr, "hello")`);
});

test("mutarr: error set type mismatch", () => {
    testCompileError(`mutarr = trans([1, 2]); set(mutarr, 0, "hello")`);
});

test("mutarr: error set non-integer index", () => {
    testCompileError(`mutarr = trans([1, 2]); set(mutarr, "x", 99)`);
});

test("mutarr: error trans on non-array variable", () => {
    testCompileError("x = 1; trans(x)");
});

// ============================================================
// PHASE 5: If without else
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
// PHASE 6: Pipe syntax
// ============================================================

test("pipe: basic pipe", () => {
    testCompile(
        `
        add1 = func(x: Int) { x + 1 };
        1 | add1
        `,
        2n
    );
});

test("pipe: chained pipe", () => {
    testCompile(
        `
        add1 = func(x: Int) { x + 1 };
        5 | add1 | add1
        `,
        7n
    );
});

test("pipe: pipe to length", () => {
    testCompile("[1, 2, 3] | length", 3n);
});

test("pipe: pipe to last", () => {
    testCompile("[10, 20, 30] | last", 30n);
});

test("pipe: error non-identifier RHS", () => {
    testCompileError("1 | 2");
    testCompileError("true | false");
});

// ============================================================
// PHASE 7: For loops
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