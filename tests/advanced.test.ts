import { test } from "bun:test";

import {
    requireIdenticalCompilation,
    testCompile,
    testParse,
    testParseExpectError,
} from "./helpers";

test("compile struct with trait generic (add two points)", () => {
    testCompile(
        `
        trait Adder {
            add[(a: Self, b: Self): Self],
        };

        struct Point {
            x: Int,
            y: Int
        };

        func add(a: Point, b: Point): Point {
            Point(a("x") + b("x"), a("y") + b("y"))
        };

        func foo(a: T, b: T): T where T is Adder {
            add(a, b)
        };

        result = foo(Point(1, 2), Point(3, 4));
        result("x") + result("y")
    `,
        10n
    );
});

test("compile struct with trait generic (chained add)", () => {
    testCompile(
        `
        trait Adder {
            add[(a: Self, b: Self): Self],
        };

        struct Point {
            x: Int,
            y: Int
        };

        func add(a: Point, b: Point): Point {
            Point(a("x") + b("x"), a("y") + b("y"))
        };

        func foo(a: T, b: T): T where T is Adder {
            add(a, b)
        };

        a = Point(1, 2);
        b = Point(3, 4);
        c = Point(5, 6);
        result = foo(foo(a, b), c);
        result("x") + result("y")
    `,
        21n
    );
});

test("compile struct with multiple generic type params", () => {
    testCompile(
        `
        trait Any {}

        struct Point { x: Int, y: Int };
        struct Pair { a: Int, b: Int };
        
        func foo(a: T, b: U): Arr[T] where T is Any, U is Any {
            [a]
        };
        result = foo(Point(1, 2), Pair(3, 4));
        result(0)("x")
    `,
        1n
    );
});

test("compile trait-defined functions", () => {
    testCompile(
        `
        trait Adder {
            add[(a: Self, b: Self): Self],
        };

        func add(a: Int, b: Int): Int {
            a + b
        }

        func foo(a: T, b: T): T where T is Adder {
            add(a, b)
        }

        foo(1, 2)
        `,
        3n
    );
    testCompile(
        `
        trait Comparable {
            eq[(a: Self, b: Self): Bool],
            lt[(a: Self, b: Self): Bool]
        };

        func lte(a: T, b: T): Bool where T is Comparable {
            lt(a, b) or eq(a, b)
        }

        func eq(a: Int, b: Int): Bool {
            a == b
        }

        func lt(a: Int, b: Int): Bool {
            a < b
        }
        
        [lte(2, 3), lte(3, 3), lte(4,3)]
        `,
        [true, true, false]
    );
});

test("compile keyword arguments for functions", () => {
    testCompile(`func foo(x: Int): Int { x }; foo(x=1)`, 1n);
    testCompile(`func foo(x: Int, y: Int): Int { x + y }; foo(x=1, y=1)`, 2n);
    testCompile(`func foo(x: Int, y: Int): Int { x + y }; foo(y=1, x=1)`, 2n);
    testCompile(`func foo(x: Int) { x }; foo(x={ x = 1; x }); foo(1)`, 1n);

    // Want to ensure that we emit the exact same JS if the function is called with the same arguments
    requireIdenticalCompilation(
        "func foo(x: Int, y: Int): Int { x + y }; foo(1, 2)",
        "func foo(x: Int, y: Int): Int { x + y }; foo(x=1, y=2)"
    );
    requireIdenticalCompilation(
        "func foo(x: Int, y: Int): Int { x + y }; foo(x=1, y=2)",
        "func foo(x: Int, y: Int): Int { x + y }; foo(y=2, x=1)"
    );
});

test("compile keyword arguments for struct constructors", () => {
    testCompile(`struct Foo {x: Int }; Foo(x=1).x`, 1n);
    testCompile(`struct Foo {x: Int, y: Int }; foo = Foo(x=1, y=1); foo.x + foo.y`, 2n);
    testCompile(`struct Foo {x: Int, y: Int }; Foo(y=1, x=2).y`, 1n);
    testCompile(`struct Foo {x: Int }; Foo(x={ x = 1; x }).x`, 1n);

    // Want to ensure that we emit the exact same JS if a struct is constructed with the same values
    requireIdenticalCompilation(
        "struct Foo { x: Int, y: Int }; Foo(1, 2)",
        "struct Foo { x: Int, y: Int }; Foo(x=1, y=2)"
    );
    requireIdenticalCompilation(
        "struct Foo { x: Int, y: Int }; Foo(x=1, y=2)",
        "struct Foo { x: Int, y: Int }; Foo(y=2, x=1)"
    );
});

test("compile keyword arguments with named trait signatures in generic functions", () => {
    // Keyword args matching trait param names in generic function
    testCompile(
        `
        trait Adder {
            add[(a: Self, b: Self): Self],
        };
        func add(a: Int, b: Int): Int { a + b };
        func double(a: T): T where T is Adder { add(a=a, b=a) };
        double(4)
    `,
        8n
    );
    // Reordered keyword args matching trait param names
    testCompile(
        `
        trait Adder {
            add[(a: Self, b: Self): Self],
        };
        func add(a: Int, b: Int): Int { a + b };
        func double(a: T): T where T is Adder { add(b=a, a=a) };
        double(4)
    `,
        8n
    );
    // Keyword args with trait that has one param
    testCompile(
        `
        trait Any {}
        func id(x: T): T where T is Any { x }
        id(x=42)
    `,
        42n
    );
    // Keyword args produce identical output to positional args
    requireIdenticalCompilation(
        `trait Adder { add[(a: Self, b: Self): Self], };
         func add(a: Int, b: Int): Int { a + b };
         func double(a: T): T where T is Adder { add(a, a) };
         double(4)`,
        `trait Adder { add[(a: Self, b: Self): Self], };
         func add(a: Int, b: Int): Int { a + b };
         func double(a: T): T where T is Adder { add(a=a, b=a) };
         double(4)`
    );
    requireIdenticalCompilation(
        `trait Adder { add[(a: Self, b: Self): Self], };
         func add(a: Int, b: Int): Int { a + b };
         func double(a: T): T where T is Adder { add(a=a, b=a) };
         double(4)`,
        `trait Adder { add[(a: Self, b: Self): Self], };
         func add(a: Int, b: Int): Int { a + b };
         func double(a: T): T where T is Adder { add(b=a, a=a) };
         double(4)`
    );
    // Multiple trait functions with keyword args
    testCompile(
        `
        trait Comparable {
            eq[(x: Self, y: Self): Bool],
            lt[(x: Self, y: Self): Bool]
        };
        func eq(a: Int, b: Int): Bool { a == b };
        func lt(a: Int, b: Int): Bool { a < b };
        func lte(a: T, b: T): Bool where T is Comparable { lt(x=a, y=b) or eq(x=a, y=b) };
        [lte(2, 3), lte(3, 3), lte(4, 3)]
    `,
        [true, true, false]
    );
    // Original positional-arg behavior still works through traits
    testCompile(
        `
        trait Adder {
            add[(a: Self, b: Self): Self],
        };
        func add(a: Int, b: Int): Int { a + b };
        func foo(a: T, b: T): T where T is Adder { add(a, b) };
        foo(1, 2)
    `,
        3n
    );
});

test("parse functions with generics", () => {
    // Generic type params must have trait bounds
    testParse(
        `
        trait Any {}

        func foo(a: T): T where T is Any {
            a
        }
        `
    );
    testParse(
        `
        func foo(a: T): T where T is Bar {
            a
        }
        `
    );
    testParse(
        `
        func foo(a: T): T where T is Bar, T is Baz {
            a
        }
        `
    );
    // Generic without a where clause is an error
    testParseExpectError(`
        func foo(a: T): T {
            a
        }
    `);
});

test("parse traits", () => {
    testParse("trait Foo {}");
    testParse("trait Foo { foo[(self: Self): Self] }");
    testParse("trait Foo { foo[(self: Self): Self], bar[(self: Self): Int] }");
    testParse("trait Foo { foo[(a: Self, b: Self): Self] }");
    testParse("trait Foo { foo[(a: Self, b: Int): Self] }");
    testParse("trait Foo { foo[(a: Int, b: Self): Int] }");

    // Self needs to be at least one of the arguments of all required functions
    testParseExpectError("trait Foo { foo[(a: Int, b: Int): Int] }");
    testParseExpectError("trait Foo { foo[(self: Self): Self], bar[(a: Int): Self] }");
});

test("parse trait-defined functions", () => {
    testParse(`
        trait Adder {
            add[(a: Self, b: Self): Self],
        };

        func add(a: Int, b: Int): Int {
            a + b
        }

        func foo(a: T, b: T): T where T is Adder {
            add(a, b)
        }
        
        foo(1, 2)
        `);
    testParse(`
        trait Comparable {
            eq[(a: Self, b: Self): Bool],
            lt[(a: Self, b: Self): Bool]
        };

        func lte(a: T, b: T): Bool where T is Comparable {
            lt(a, b) or eq(a, b)
        }

        func eq(a: Int, b: Int): Bool {
            a == b
        }

        func lt(a: Int, b: Int): Bool {
            a < b
        }
        
        lte(2, 3)
        `);
    testParse(`
        trait Any {}

        func identity(x: T): T where T is Any { x }

        identity("hello")
    `);
});

test("generic functions with unsatisifed traits", () => {
    // Should fail because 2 is not Comparable
    testParseExpectError(`
        trait Comparable {
            eq[(a: Self, b: Self): Bool],
            lt[(a: Self, b: Self): Bool]
        };

        func lte(a: T, b: T): Bool where T is Comparable {
            lt(a, b) or eq(a, b)
        }
        
        lte(2, 3)
    `);
    // Should fail because Int is not Bar, even though bar is not called
    testParseExpectError(`
        trait Foo {}
        trait Bar {
            bar[(a: Self, b: Self): Self],
        }

        func foo(x: T): T where T is Foo, T is Bar {x}

        foo(1)
    `);
});

test("parse generic identity function", () => {
    testParse(`
        trait Any {}

        func id(a: T): T where T is Any {
            a
        };
        id(1)
    `);
});

test("parse struct with trait generic", () => {
    testParse(`
        trait Adder {
            add[(a: Self, b: Self): Self],
        };

        struct Point {
            x: Int,
            y: Int
        };

        func add(a: Point, b: Point): Point {
            Point(a("x") + b("x"), a("y") + b("y"))
        };

        func foo(a: T, b: T): T where T is Adder {
            add(a, b)
        };

        foo(Point(1, 2), Point(3, 4))
    `);
});

test("parse generic error when trait not satisfied", () => {
    testParseExpectError(`
        trait Adder {
            add[(a: Self, b: Self): Self],
        };

        struct Point {
            x: Int,
            y: Int
        };

        func foo(a: T, b: T): T where T is Adder {
            add(a, b)
        };

        foo(Point(1, 2), Point(3, 4))
    `);
});

test("parse generic multiple type parameters", () => {
    testParse(`
        trait Any {}

        func pair(a: T, b: U): Arr[T] where T is Any, U is Any {
            [a]
        }
    `);
});

test("parse struct with generic identity", () => {
    testParse(`
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
    `);
});

test("parse struct with trait generic chained add", () => {
    testParse(`
        trait Adder {
            add[(a: Self, b: Self): Self],
        };

        struct Point {
            x: Int,
            y: Int
        };

        func add(a: Point, b: Point): Point {
            Point(a("x") + b("x"), a("y") + b("y"))
        };

        func foo(a: T, b: T): T where T is Adder {
            add(a, b)
        };

        a = Point(1, 2);
        b = Point(3, 4);
        c = Point(5, 6);
        result = foo(foo(a, b), c);
        result("x") + result("y")
    `);
});

test("parse keyword arguments for functions", () => {
    testParse(`func foo(x: Int): Int { x }; foo(x=1)`);
    testParse(`func foo(x: Int, y: Int): Int { x + y }; foo(x=1, y=1)`);
    testParse(`func foo(x: Int, y: Int): Int { x + y }; foo(y=1, x=1)`);
    testParse(`func foo(x: Int) { x }; foo(x={ x = 1; x })`);
    testParseExpectError(`struct foo(x: Int): Int { x }; foo(x=1, x=1)`);
    testParseExpectError(`struct foo(x: Int, y: Int): Int { x + y }; foo(x=1)`);
    testParseExpectError(`func foo(x: Int, y: Int): Int { x + y }; foo(x, y=1)`); // Cannot mix with keyword calls in current language spec
    testParseExpectError(`func foo(x: Int, y: Int): Int { x + y }; foo(x=1, y)`); // Cannot mix with keyword calls in current language spec
});

test("parse keyword arguments for functions, with mixed types", () => {
    testParse(`
        func foo(x: Int, y: Float): Int {
            x + toInt(y)
        }
        foo(x=1, y=2.)
    `);
    testParse(`
        func foo(x: Int, y: Float): Int {
            x + toInt(y)
        }
        foo(y=1., x=2)
    `);
    testParse(`
        func foo(x: Int, y: Str): Str {
            toStr(x) + y
        }
        foo(y="hello", x=1)
    `);
    testParse(`
        func foo(x: Arr[Int], y: Int): Int {
            x(0) + y
        }
        foo(y=1, x=[1, 2])
    `);
});

test("parse keyword arguments for functions, with generics", () => {
    testParse(`
        trait Any {}
        func foo(x: T): T where T is Any { x }
        foo(x=1) + toInt(foo(x=1.))
    `);
});

test("parse keyword arguments for struct constructors", () => {
    testParse(`struct Foo {x: Int }; Foo(x=1)`);
    testParse(`struct Foo {x: Int, y: Int }; Foo(x=1, y=1)`);
    testParse(`struct Foo {x: Int, y: Int }; Foo(y=1, x=1)`);
    testParse(`struct Foo {x: Int }; Foo(x={ x = 1; x })`);
    testParseExpectError(`struct Foo {x: Int, }; Foo(x=1, x=1)`);
    testParseExpectError(`struct Foo {x: Int, y: Int }; Foo(x=1)`);
    testParseExpectError(`struct Foo {x: Int, y: Int }; Foo(x=1, 1)`); // Cannot mix with keyword calls in current language spec
    testParseExpectError(`struct Foo {x: Int, y: Int }; Foo(1, y=1)`); // Cannot mix with keyword calls in current language spec
});

test("parse keyword arguments with named trait signatures in generic functions", () => {
    // Keyword args matching trait param names should work
    testParse(`
        trait Adder {
            add[(a: Self, b: Self): Self],
        };
        func add(a: Int, b: Int): Int { a + b };
        func double(a: T): T where T is Adder { add(a=a, b=a) };
        double(4)
    `);
    testParse(`
        trait Comparable {
            eq[(x: Self, y: Self): Bool],
            lt[(x: Self, y: Self): Bool]
        };
        func eq(a: Int, b: Int): Bool { a == b };
        func lt(a: Int, b: Int): Bool { a < b };
        func check(a: T, b: T): Bool where T is Comparable { eq(x=a, y=b) };
        check(1, 2)
    `);
    testParse(`
        trait Any {}
        func id(x: T): T where T is Any { x }
        id(x=42)
    `);
    // Keyword args work with reordered names
    testParse(`
        trait Adder {
            add[(a: Self, b: Self): Self],
        };
        func add(x: Int, y: Int): Int { x + y };
        func double(a: T): T where T is Adder { add(b=a, a=a) };
        double(4)
    `);
    // Keyword args still work with non-generic functions (unchanged behavior)
    testParse(`func foo(x: Int, y: Int): Int { x + y }; foo(y=1, x=2)`);
    // Keyword args where concrete function name differs from trait param names
    // (resolution uses concrete function's names when it's in scope)
    testParse(`
        trait Adder {
            add[(a: Self, b: Self): Self],
        };
        func add(x: Int, y: Int): Int { x + y };
        func double(a: T): T where T is Adder { add(x=a, y=a) };
        double(4)
    `);
});

test("parse keyword argument name mismatch with trait param names", () => {
    // When the concrete function is NOT in the ancestor chain (e.g., defined
    // in a different scope), keyword resolution falls back to trait param names.
    // In the current single-file setup, the concrete function is always in scope,
    // so mismatches are detected by the concrete function's param names.

    // Trait says add(a: Self, b: Self), call uses wrong name not matching any param
    testParseExpectError(`
        trait Adder {
            add[(a: Self, b: Self): Self],
        };
        func add(x: Int, y: Int): Int { x + y };
        func double(a: T): T where T is Adder { add(z=a, w=a) };
        double(4)
    `);
    // Reordered: trait says eq(x: Self, y: Self), call uses mismatched name
    testParseExpectError(`
        trait Comparable {
            eq[(x: Self, y: Self): Bool],
        };
        func eq(a: Int, b: Int): Bool { a == b };
        func check(a: T, b: T): Bool where T is Comparable { eq(z=a, w=b) };
        check(1, 2)
    `);
});

test("parse positional args still work in generic functions with traits", () => {
    // Existing positional-arg-only behavior should still work
    testParse(`
        trait Adder {
            add[(a: Self, b: Self): Self],
        };
        func add(a: Int, b: Int): Int { a + b };
        func foo(a: T, b: T): T where T is Adder { add(a, b) };
        foo(1, 2)
    `);
    testParse(`
        trait Comparable {
            eq[(x: Self, y: Self): Bool],
            lt[(x: Self, y: Self): Bool]
        };
        func eq(a: Int, b: Int): Bool { a == b };
        func lt(a: Int, b: Int): Bool { a < b };
        func lte(a: T, b: T): Bool where T is Comparable { lt(a, b) or eq(a, b) };
        lte(2, 3)
    `);
});

test("parse empty array in generic function", () => {
    testParse("trait Any {} func foo(t: T) where T is Any { []: Int } foo(1)");
    testParse("trait Any {} func foo(t: T) where T is Any { []: T } foo(1)");
});
