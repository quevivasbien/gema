import { test } from "bun:test";
import { testCompile, testParseExpectError } from "./helpers";

// ============================================================
// Plain enums — compile to numbers
// ============================================================

test("plain enum definition and value access", () => {
    testCompile(
        `
        enum Grade { a, b, c };
        Grade.a
        `,
        0
    );
});

test("plain enum all values", () => {
    testCompile(
        `
        enum Grade { a, b, c };
        Grade.b
        `,
        1
    );
    testCompile(
        `
        enum Grade { a, b, c };
        Grade.c
        `,
        2
    );
});

test("plain enum in variable assignment", () => {
    testCompile(
        `
        enum Grade { a, b, c };
        g = Grade.b;
        g
        `,
        1
    );
});

test("plain enum comparison with ==", () => {
    testCompile(
        `
        enum Grade { a, b, c };
        Grade.a == Grade.a
        `,
        true
    );
    testCompile(
        `
        enum Grade { a, b, c };
        Grade.a == Grade.b
        `,
        false
    );
});

// ============================================================
// Tagged enums — compile to {$tag, $val} objects
// ============================================================

test("tagged enum constructor", () => {
    testCompile(
        `
        enum Number {
            integer: Num,
            decimal: Num,
        };
        Number.integer(1)
        `,
        { $tag: 0, $val: 1 }
    );
});

test("tagged enum second variant", () => {
    testCompile(
        `
        enum Number {
            integer: Num,
            decimal: Num,
        };
        Number.decimal(1.0)
        `,
        { $tag: 1, $val: 1.0 }
    );
});

test("tagged enum with string type", () => {
    testCompile(
        `
        enum Label {
            name: Str,
            id: Num,
        };
        Label.name("hello")
        `,
        { $tag: 0, $val: "hello" }
    );
});

// ============================================================
// Mixed enums — some variants with values, some without
// ============================================================

test("mixed enum with value and plain variants", () => {
    testCompile(
        `
        enum OptionalInt {
            value: Num,
            missing
        };
        OptionalInt.value(42)
        `,
        { $tag: 0, $val: 42 }
    );
});

test("mixed enum plain variant", () => {
    testCompile(
        `
        enum OptionalInt {
            value: Num,
            missing
        };
        OptionalInt.missing
        `,
        { $tag: 1, $val: null }
    );
});

test("mixed enum with more variants", () => {
    testCompile(
        `
        enum Event {
            click: Num,
            keypress: Str,
            timeout
        };
        Event.timeout
        `,
        { $tag: 2, $val: null }
    );
});

// ============================================================
// Match on plain enums
// ============================================================

test("match on plain enum with else", () => {
    testCompile(
        `
        enum Grade { a, b, c };
        g = Grade.a;
        match g {
            a { 100 },
            else { 50 }
        }
        `,
        100
    );
});

test("match on plain enum else branch", () => {
    testCompile(
        `
        enum Grade { a, b, c };
        g = Grade.c;
        match g {
            a { 100 },
            else { 50 }
        }
        `,
        50
    );
});

test("match on plain enum with brace-less body", () => {
    testCompile(
        `
        enum Grade { a, b, c };
        match Grade.b {
            a 100,
            b 200,
            else 0
        }
        `,
        200
    );
});

test("match on plain enum covers all variants", () => {
    testCompile(
        `
        enum Grade { a, b, c };
        match Grade.a {
            a 1,
            b 2,
            c 3
        }
        `,
        1
    );
});

// ============================================================
// Match on tagged enums
// ============================================================

test("match on tagged enum extracts value", () => {
    testCompile(
        `
        enum Number {
            integer: Int,
            decimal: Num,
        };
        match Number.integer(5i) {
            integer(i) i,
            decimal(d) toInt(d)
        }
        `,
        5n
    );
});

test("match on tagged enum with transformation", () => {
    testCompile(
        `
        enum Number {
            integer: Int,
            decimal: Num,
        };
        match Number.decimal(3.5) {
            integer(i) i * 2i,
            decimal(d) toInt(d * 2.0)
        }
        `,
        7n
    );
});

test("match on tagged enum returns different type per arm", () => {
    testCompile(
        `
        enum Number {
            integer: Num,
            decimal: Num,
        };
        func square(n: Number): Number {
            match n {
                integer(i) Number.integer(i * i),
                decimal(d) Number.decimal(d * d)
            }
        };
        match square(Number.integer(3)) {
            integer(i) i,
            decimal(d) 0
        }
        `,
        9
    );
});

test("match on tagged enum binding same name as scrutinee", () => {
    testCompile(
        `
        enum Number {
            integer: Num,
            decimal: Num,
        };
        x = Number.integer(7);
        match x {
            integer(x) x + 1,
            decimal(d) 0
        }
        `,
        8
    );
});

// ============================================================
// Match on mixed enums
// ============================================================

test("match on mixed enum with plain and tagged arms", () => {
    testCompile(
        `
        enum OptionalInt {
            value: Num,
            missing
        };
        func unwrapOptional(oi: OptionalInt, fallback: Num) {
            match oi {
                value(i) i,
                missing fallback
            }
        };
        unwrapOptional(OptionalInt.value(42), -1)
        `,
        42
    );
});

test("match on mixed enum returns default for plain variant", () => {
    testCompile(
        `
        enum OptionalInt {
            value: Num,
            missing
        };
        func unwrapOptional(oi: OptionalInt, fallback: Num) {
            match oi {
                value(i) i,
                missing fallback
            }
        };
        unwrapOptional(OptionalInt.missing, -1)
        `,
        -1
    );
});

// ============================================================
// Partial match (no else) → type Null
// ============================================================

test("partial match on plain enum without else errors as Null", () => {
    testParseExpectError(
        `
        enum Grade { a, b, c };
        x = match Grade.a { a 1 }
        `,
        "cannot assign null"
    );
});

test("partial match on tagged enum without else errors as Null", () => {
    testParseExpectError(
        `
        enum Number {
            integer: Num,
            decimal: Num,
        };
        x = match Number.integer(1) { integer(i) i }
        `,
        "cannot assign null"
    );
});

test("plain enum variant cannot be called", () => {
    testParseExpectError(
        `
        enum Grade { a, b, c };
        Grade.a(1)
        `,
        "cannot call non-callable"
    );
});

test("match on non-enum type errors", () => {
    testParseExpectError(
        `
        match 42 { a 1, else 0 }
        `,
        "requires a Maybe or enum type"
    );
});

// ============================================================
// Error cases
// ============================================================

test("invalid variant name errors", () => {
    testParseExpectError(
        `
        enum Grade { a, b, c };
        Grade.z
        `,
        "no variant"
    );
});

test("tagged enum variant with wrong argument type errors", () => {
    testParseExpectError(
        `
        enum Number { integer: Num, decimal: Num };
        Number.integer("hello")
        `,
        "expected"
    );
});

test("match arm type mismatch errors", () => {
    testParseExpectError(
        `
        enum Number { integer: Num, decimal: Num };
        match Number.integer(1) {
            integer(i) i,
            decimal(d) "hello"
        }
        `,
        "same type"
    );
});

test("duplicate variant name errors", () => {
    testParseExpectError(
        `
        enum Grade { a, b, a }
        `,
        "Duplicate"
    );
});

test("enums with traits", () => {
    testCompile(
        `
        enum Foo {
            a,
            b,
        }

        trait Bim {
            bim[Self: Self]
        }

        func [T: Bim] neeb(x: T): Arr[T] {
            [bim(x)]
        }

        func bim(x: Foo) {
            x
        }

        neeb(Foo.a)
        `,
        [0]
    );
});

test("enums with traits -- trait is not implemented", () => {
    testParseExpectError(
        `
        enum Foo {
            a,
            b,
        }

        trait Bim {
            bim[Self: Self]
        }

        func [T: Bim] neeb(x: T): Arr[T] {
            [bim(x)]
        }

        neeb(Foo.a)
        `
    );
});

test("enums with traits -- trait implemented for one enum type but not another", () => {
    testParseExpectError(
        `
        enum Foo {
            a: Int
            b,
        }

        enum Bar {
            a,
            b: Num,
        }

        trait Bim {
            bim[Self: Self]
        }

        func [T: Bim] neeb(x: T): Arr[T] {
            [bim(x)]
        }

        func bim(x: Foo) {
            x
        }

        # Bim is implemented for Foo but not for Bar; this should not work!
        (neeb(Foo.a(1)), neeb(Bar.a))
        `
    );
});

test("enums with traits -- trait implemented for both enum types", () => {
    testCompile(
        `
        enum Foo {
            a: Int
            b,
        }

        enum Bar {
            a,
            b: Num,
        }

        trait Bim {
            bim[Self: Self]
        }

        func [T: Bim] neeb(x: T): Arr[T] {
            [bim(x)]
        }

        func bim(x: Foo) {
            x
        }

        func bim(x: Bar) {
            match x {
                a { x },
                b(i) { Bar.b(i + 1)}
            }
        }

        (neeb(Foo.a(1i)), neeb(Bar.b(1)))
        `,
        [[{ $tag: 0, $val: 1n }], [{ $tag: 1, $val: 2 }]]
    );
});
