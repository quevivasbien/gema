import { test } from "bun:test";

import { testCompile, testParse, testParseExpectError } from "./helpers";

test("compile struct with trait generic (add two points)", () => {
    testCompile(
        `
        trait Adder {
            add[(a: Self, b: Self): Self],
        };

        struct Point {
            x: Num,
            y: Int
        };

        func add(a: Point, b: Point): Point {
            Point(a.x + b.x, a.y + b.y)
        };

        func foo(a: T, b: T): T where T is Adder {
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
            add[(a: Self, b: Self): Self],
        };

        struct Point {
            x: Num,
            y: Int
        };

        func add(a: Point, b: Point): Point {
            Point(a.x + b.x, a.y + b.y)
        };

        func foo(a: T, b: T): T where T is Adder {
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
        trait Any {}

        struct Point { x: Num, y: Num };
        struct Pair { a: Num, b: Num };
        
        func foo(a: T, b: U): Arr[T] where T is Any, U is Any {
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
            add[(a: Self, b: Self): Self],
        };

        func add(a: Num, b: Num): Num {
            a + b
        }

        func foo(a: T, b: T): T where T is Adder {
            add(a, b)
        }

        foo(1, 2)
        `,
        3
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
        `
        trait Any {}

        func foo(a: T): T where T is Any {
            a
        }

        foo[Num]
        `
    );
    testParse(
        `
        trait Bar {}
        trait Baz {}

        func foo(a: T): T where T is Bar, T is Baz {
            a
        }

        foo[Num]
        `
    );
});

test("parse traits", () => {
    testParse("trait Foo {} 1");
    testParse("trait Foo { foo[(self: Self): Self] } 1");
    testParse("trait Foo { foo[(self: Self): Self], bar[(self: Self): Num] } 1");
    testParse("trait Foo { foo[(a: Self, b: Self): Self] } 1");
    testParse("trait Foo { foo[(a: Self, b: Num): Self] }; 1");
    testParse("trait Foo { foo[(a: Num, b: Self): Num] }; 1");

    // Self needs to be at least one of the arguments of all required functions
    testParseExpectError("trait Foo { foo[(a: Num, b: Num): Num] }; 1");
    testParseExpectError("trait Foo { foo[(self: Self): Self], bar[(a: Num): Self] } 1");
});

test("parse trait-defined functions", () => {
    testParse(`
        trait Adder {
            add[(a: Self, b: Self): Self],
        };

        func add(a: Num, b: Num): Num {
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

        func eq(a: Num, b: Num): Bool {
            a == b
        }

        func lt(a: Num, b: Num): Bool {
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

test("parse generic error when trait not satisfied", () => {
    testParseExpectError(`
        trait Adder {
            add[(a: Self, b: Self): Self],
        };

        struct Point {
            x: Num,
            y: Int
        };

        func foo(a: T, b: T): T where T is Adder {
            add(a, b)
        };

        foo(Point(1, 2), Point(3, 4))
    `);
});

test("parse generic with multiple type parameters", () => {
    testParse(`
        trait Any {}

        func pair(a: T, b: U): Arr[T] where T is Any, U is Any {
            [a]
        }
        
        pair[Int, Str]
    `);
});

test("parse positional args still work in generic functions with traits", () => {
    // Existing positional-arg-only behavior should still work
    testParse(`
        trait Adder {
            add[(a: Self, b: Self): Self],
        };
        func add(a: Num, b: Num): Num { a + b };
        func foo(a: T, b: T): T where T is Adder { add(a, b) };
        foo(1, 2)
    `);
    testParse(`
        trait Comparable {
            eq[(x: Self, y: Self): Bool],
            lt[(x: Self, y: Self): Bool]
        };
        func eq(a: Num, b: Num): Bool { a == b };
        func lt(a: Num, b: Num): Bool { a < b };
        func lte(a: T, b: T): Bool where T is Comparable { lt(a, b) or eq(a, b) };
        lte(2, 3)
    `);
});

test("parse empty array in generic function", () => {
    testParse("trait Any {} func foo(t: T) where T is Any { []: Num } foo(1)");
    testParse("trait Any {} func foo(t: T) where T is Any { []: T } foo(1)");
});
