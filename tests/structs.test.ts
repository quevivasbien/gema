import { test } from "bun:test";

import {
    requireIdenticalCompilation,
    testCompile,
    testParseExpectError,
    testParse,
} from "./helpers";

test("compile struct construction and field access", () => {
    testCompile(
        `
        struct Point {
            x: Int,
            y: Int
        };
        p = Point(1, 2);
        p("x") + p("y")
    `,
        3n
    );
});

test("compile struct field access on param", () => {
    testCompile(
        `
        struct Point {
            x: Int,
            y: Int
        };
        func getX(p: Point): Int {
            p("x")
        };
        getX(Point(5, 10))
    `,
        5n
    );
});

test("compile struct with generic identity function", () => {
    testCompile(
        `
        trait Any {}

        struct Point {
            x: Int,
            y: Int
        };
        func id(a: T): T where T is Any {
            a
        };
        p = Point(1, 2);
        q = id(p);
        q("x") + q("y")
    `,
        3n
    );
});

test("compile functional operations with structs", () => {
    testCompile(
        `
        struct P { p: Int }

        filtered = filter(func (p: P) { p("p") > 0 }, [P(-1), P(2)]);
        filtered!(0)("p")
    `,
        2n
    );
    testCompile(
        `
        struct P { p: Int }

        collect(map(func (p: P) { p("p") }, [P(1), P(2)]))
    `,
        [1n, 2n]
    );
});

test("compile reduce with structs", () => {
    testCompile(
        `
        struct P { p: Int };
        result = reduce(func(a: P, b: P): P { P(a("p") + b("p")) }, P(0), [P(1), P(2), P(3)]);
        result("p")
    `,
        6n
    );
});

test("compile function returning struct field access", () => {
    testCompile(
        `
        struct P { p: Int };
        func getP(): P { P(7) };
        getP()("p")
    `,
        7n
    );
});

test("compile dot syntax for struct field access", () => {
    testCompile(
        `
        struct Point { x: Int, y: Int };
        p = Point(1, 2);
        p.x + p.y
    `,
        3n
    );
    testCompile(
        `
        struct Point { x: Int, y: Int };
        func getPoint(): Point { Point(5, 10) };
        getPoint().x
    `,
        5n
    );
    testCompile(
        `
        struct Point { x: Int, y: Int };
        p = Point(1, 2);
        p("x") + p.x
    `,
        2n
    );

    requireIdenticalCompilation(
        `struct Foo { x: Int }; Foo(1)("x")`,
        `struct Foo { x: Int }; Foo(1).x`
    );
});

test("compile operator overloading", () => {
    testCompile(
        `
        struct Point { x: Int, y: Int };
        func add(a: Point, b: Point): Point { Point(a.x + b.x, a.y + b.y) };
        result = Point(1, 2) + Point(3, 4);
        result.x + result.y
    `,
        10n
    );
    testCompile(
        `
        struct Point { x: Int, y: Int };
        func subtract(a: Point, b: Point): Point { Point(a.x - b.x, a.y - b.y) };
        result = Point(5, 6) - Point(3, 2);
        result.x + result.y
    `,
        6n
    );
    testCompile(
        `
        struct Point { x: Int, y: Int };
        func multiply(a: Point, b: Point): Point { Point(a.x * b.x, a.y * b.y) };
        result = Point(2, 3) * Point(4, 5);
        result.x + result.y
    `,
        23n
    );
    testCompile(
        `
        struct Point { x: Int, y: Int };
        func equal(a: Point, b: Point): Bool { a.x == b.x and a.y == b.y };
        Point(1, 2) == Point(1, 2)
    `,
        true
    );
    testCompile(
        `
        struct Point { x: Int, y: Int };
        func less(a: Point, b: Point): Bool { a.x < b.x };
        Point(1, 2) < Point(3, 4)
    `,
        true
    );
    testCompile(
        `
        struct Point { x: Int, y: Int };
        func add(a: Point, b: Point): Point { Point(a.x + b.x, a.y + b.y) };
        a = Point(1, 2) + Point(3, 4);
        b = a + Point(5, 6);
        b.x + b.y
    `,
        21n
    );
});

test("parse struct definition", () => {
    testParse(`
        struct Point {
            x: Int,
            y: Int
        }
        Point(1,2)
    `);
    testParse(`
        struct Empty {
        }
        Empty()
    `);
    testParseExpectError(`
        struct Point {
            x
        }
        Point(1)
    `);
    // Struct definition on its own is valueless, cannot terminate the program
    testParseExpectError(`
        struct Point {
            x: Int
        }
    `);
});

test("parse struct construction and field access", () => {
    testParse(`
        struct Point {
            x: Int,
            y: Int
        };
        p = Point(1, 2);
        p("x")
    `);
});

test("parse struct field access errors", () => {
    testParseExpectError(`
        struct Point {
            x: Int,
            y: Int
        };
        p = Point(1, 2);
        p("z")
    `);
    testParseExpectError(`
        struct Point {
            x: Int,
            y: Int
        };
        p("x")
    `);
});

test("parse struct constructor errors", () => {
    testParseExpectError(`
        struct Point {
            x: Int,
            y: Int
        };
        Point(1)
    `);
    testParseExpectError(`
        struct Point {
            x: Int,
            y: Int
        };
        Point(1, "hello")
    `);
});

test("parse struct field access on param", () => {
    testParse(`
        struct Point {
            x: Int,
            y: Int
        };
        func getX(p: Point): Int {
            p("x")
        };
        getX(Point(5, 10))
    `);
});

test("parse dot syntax for struct field access", () => {
    testParse(`
        struct Point { x: Int, y: Int };
        p = Point(1, 2);
        p.x
    `);
    testParse(`
        struct Point { x: Int, y: Int };
        p = Point(1, 2);
        p.x + p.y
    `);
    testParse(`
        struct Point { x: Int, y: Int };
        func getPoint(): Point { Point(3, 4) };
        getPoint().x
    `);
    testParse(`
        struct Point { x: Int, y: Int };
        p = Point(1, 2);
        p("x") + p.x
    `);
    testParseExpectError(`
        struct Point { x: Int, y: Int };
        p = Point(1, 2);
        p.z
    `);
    testParseExpectError(`
        p = 5;
        p.x
    `);
});

test("parse operator overloading", () => {
    testParse(`
        struct Point { x: Int, y: Int };
        func add(a: Point, b: Point): Point { Point(a.x + b.x, a.y + b.y) };
        Point(1, 2) + Point(3, 4)
    `);
    testParse(`
        struct Point { x: Int, y: Int };
        func subtract(a: Point, b: Point): Point { Point(a.x - b.x, a.y - b.y) };
        Point(5, 6) - Point(3, 2)
    `);
    testParse(`
        struct Point { x: Int, y: Int };
        func multiply(a: Point, b: Point): Point { Point(a.x * b.x, a.y * b.y) };
        Point(2, 3) * Point(4, 5)
    `);
    testParse(`
        struct Point { x: Int, y: Int };
        func equal(a: Point, b: Point): Bool { a.x == b.x and a.y == b.y };
        Point(1, 2) == Point(1, 2)
    `);
    testParse(`
        struct Point { x: Int, y: Int };
        func less(a: Point, b: Point): Bool { a.x < b.x };
        Point(1, 2) < Point(3, 4)
    `);
    testParse(`
        struct Point { x: Int, y: Int };
        func add(a: Point, b: Point): Point { Point(a.x + b.x, a.y + b.y) };
        a = Point(1, 2) + Point(3, 4);
        b = a + Point(5, 6)
    `);
    testParseExpectError(`
        struct Point { x: Int, y: Int };
        Point(1, 2) + Point(3, 4)
    `);
});

test("parse functional operations with structs", () => {
    testParse(`
        struct P { p: Int }

        filtered = filter(func (p: P) { p("p") > 0 }, [P(-1), P(2)]);
        filtered!(0)("p")
    `);
    testParse(`
        struct P { p: Int }

        collect(map(func (p: P) { p("p") }, [P(1), P(2)]))
    `);
});

// ============================================================
// Mutable struct fields
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
    testParseExpectError(`
        struct S { x: Int };
        mut s = S(1);
        s.x = 2
    `);
});

// ── Error: assign to non-mut field ──

test("field: error assigning to non-mutable field", () => {
    testParseExpectError(`
        struct S { x: Int };
        s = S(1);
        s.x = 2
    `);
});

// ── Error: assign to non-existent field ──

test("field: error assigning to non-existent field", () => {
    testParseExpectError(`
        struct S { mut x: Int };
        s = S(1);
        s.y = 2
    `);
});

// ── Error: type mismatch on field assignment ──

test("field: error type mismatch on field assignment", () => {
    testParseExpectError(`
        struct S { mut x: Int };
        s = S(1);
        s.x = true
    `);
});

test("field: error type mismatch on compound field assignment", () => {
    testParseExpectError(`
        struct S { mut x: Int };
        s = S(1);
        s.x += true
    `);
});

// ── Error: compound on non-mut field ──

test("field: error compound on non-mutable field", () => {
    testParseExpectError(`
        struct S { x: Int };
        s = S(1);
        s.x += 2
    `);
});

// ── Error: assign to field on non-struct type ──

test("field: error assigning field on non-struct", () => {
    testParseExpectError(`
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
    testParseExpectError(`
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

test.todo("struct: allow overloading of struct constructor", () => {
    testParse(
        `
        struct S {}

        func S(s: Int) {
        S()
        }

        S(1)
        `
    );
    testCompile(
        `
        struct S { s: Int }

        func S(s: Float) {
            S(toInt(s))
        }

        S(1.0).s
        `,
        1n
    );
});
