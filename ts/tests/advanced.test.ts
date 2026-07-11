import { test } from "bun:test";

import { testCompile, testParse, testParseExpectError } from "./helpers";

test("compile struct with trait generic (add two points)", () => {
    testCompile(
        `
        trait Adder {
            add[Self, Self: Self],
        };

        struct Point {
            x: Num,
            y: Int
        };

        func add(a: Point, b: Point): Point {
            Point(a.x + b.x, a.y + b.y)
        };

        func [T: Adder] foo(a: T, b: T): T {
            add(a, b)
        };

        result = foo(Point(1, 2i), Point(3, 4i));
        result.x + toNum(result.y)
    `,
        10
    );
});

test("compile struct with trait generic (chained add)", () => {
    testCompile(
        `
        trait Adder {
            add[Self, Self: Self],
        };

        struct Point {
            x: Num,
            y: Int
        };

        func add(a: Point, b: Point): Point {
            Point(a.x + b.x, a.y + b.y)
        };

        func [T: Adder] foo(a: T, b: T): T {
            add(a, b)
        };

        a = Point(1, 2i);
        b = Point(3, 4i);
        c = Point(5, 6i);
        result = foo(foo(a, b), c);
        result.x + toNum(result.y)
    `,
        21
    );
});

test("compile struct with multiple generic type params", () => {
    testCompile(
        `
        struct Point { x: Num, y: Num };
        struct Pair { a: Num, b: Num };
        
        func [T, U] foo(a: T, b: U): Arr[T] {
            [a]
        };
        result = foo(Point(1, 2), Pair(3, 4));
        result!(0).x
    `,
        1
    );
});

test("compile trait-defined functions", () => {
    testCompile(
        `
        trait Adder {
            add[Self, Self: Self],
        };

        func add(a: Num, b: Num): Num {
            a + b
        }

        func [T: Adder] foo(a: T, b: T): T {
            add(a, b)
        }

        foo(1, 2)
        `,
        3
    );
    testCompile(
        `
        trait Comparable {
            eq[Self, Self: Bool],
            lt[Self, Self: Bool]
        };

        func [T: Comparable] lte(a: T, b: T): Bool {
            lt(a, b) or eq(a, b)
        }

        func eq(a: Num, b: Num): Bool {
            a == b
        }

        func lt(a: Num, b: Num): Bool {
            a < b
        }
        
        [lte(2, 3), lte(3, 3), lte(4,3)]
        `,
        [true, true, false]
    );
});

test("parse functions with generics", () => {
    // Generic type params must have trait bounds
    testParse(
        `func [T] foo(a: T): T {
            a
        }

        foo[Num]
        `
    );
    testParse(
        `
        trait Bar {}
        trait Baz {}

        func [T: Bar + Baz] foo(a: T): T {
            a
        }

        foo[Num]
        `
    );
});

test("parse traits", () => {
    testParse("trait Foo {} 1");
    testParse("trait Foo { foo[Self: Self] } 1");
    testParse("trait Foo { foo[Self: Self], bar[Self: Num] } 1");
    testParse("trait Foo { foo[Self, Self: Self] } 1");
    testParse("trait Foo { foo[Self, Num: Self] }; 1");
    testParse("trait Foo { foo[Num Self: Num] }; 1");

    // Self needs to be at least one of the arguments of all required functions
    testParseExpectError("trait Foo { foo[Num, Num: Num] }; 1");
    testParseExpectError("trait Foo { foo[Self: Self], bar[Num: Self] } 1");
});

test("parse trait-defined functions", () => {
    testParse(`
        trait Adder {
            add[Self, Self: Self],
        };

        func add(a: Num, b: Num): Num {
            a + b
        }

        func [T: Adder] foo(a: T, b: T): T {
            add(a, b)
        }
        
        foo(1, 2)
        `);
    testParse(`
        trait Comparable {
            eq[Self, Self: Bool],
            lt[Self, Self: Bool]
        };

        func [T: Comparable] lte(a: T, b: T): Bool {
            lt(a, b) or eq(a, b)
        }

        func eq(a: Num, b: Num): Bool {
            a == b
        }

        func lt(a: Num, b: Num): Bool {
            a < b
        }
        
        lte(2, 3)
        `);
    testParse(`
        func [T] identity(x: T): T { x }

        identity("hello")
    `);
});

test("generic functions with unsatisifed traits", () => {
    // Should fail because 2 is not Comparable
    testParseExpectError(`
        trait Comparable {
            eq[Self, Self: Bool],
            lt[Self, Self: Bool]
        };

        func [T: Comparable] lte(a: T, b: T): Bool {
            lt(a, b) or eq(a, b)
        }
        
        lte(2, 3)
    `);
    // Should fail because Int is not Bar, even though bar is not called
    testParseExpectError(`
        trait Foo {}
        trait Bar {
            bar[Self, Self: Self],
        }

        func [T: Foo + Bar] foo(x: T): T {x}

        foo(1)
    `);
});

test("parse generic identity function", () => {
    testParse(`
        func [T] id(a: T): T {
            a
        };
        id(1)
    `);
});

test("parse generic error when trait not satisfied", () => {
    testParseExpectError(`
        trait Adder {
            add[Self, Self: Self],
        };

        struct Point {
            x: Num,
            y: Int
        };

        func [T: Adder] foo(a: T, b: T): T {
            add(a, b)
        };

        foo(Point(1, 2), Point(3, 4))
    `);
});

test("parse generic with multiple type parameters", () => {
    testParse(`
        func [T, U] pair(a: T, b: U): Arr[T] {
            [a]
        }
        
        pair[Int, Str]
    `);
});

test("parse positional args still work in generic functions with traits", () => {
    // Existing positional-arg-only behavior should still work
    testParse(`
        trait Adder {
            add[Self, Self: Self],
        };
        func add(a: Num, b: Num): Num { a + b };
        func [T: Adder] foo(a: T, b: T): T { add(a, b) };
        foo(1, 2)
    `);
    testParse(`
        trait Comparable {
            eq[Self, Self: Bool],
            lt[Self, Self: Bool]
        };
        func eq(a: Num, b: Num): Bool { a == b };
        func lt(a: Num, b: Num): Bool { a < b };
        func [T: Comparable] lte(a: T, b: T): Bool { lt(a, b) or eq(a, b) };
        lte(2, 3)
    `);
});

test("parse empty array in generic function", () => {
    testParse("func [T] foo(t: T) { []: Num } foo(1)");
    testParse("func [T] foo(t: T) { []: T } foo(1)");
});
