import { expect, test } from "bun:test";
import { scan } from "../src/scan";
import { parse } from "../src/parse";
import { resetRegistries } from "../src/ast";

export function testParse(text: string, checkSnapshot: boolean = true) {
    resetRegistries();
    const tokens = scan(text);
    const { ast, errors } = parse(tokens);
    if (errors.length > 0) {
        console.log(errors);
    }
    expect(errors.length).toBe(0);
    // expect(ast).toMatchSnapshot();
    return ast;
}

function testParseExpectError(text: string) {
    resetRegistries();
    const tokens = scan(text);
    const { ast, errors } = parse(tokens);
    expect(errors.length).toBeGreaterThan(0);
    // expect(errors).toMatchSnapshot();
}

test("parse addition", () => {
    testParse(`1.22  + 1.23  + 8 + 3.13`);
    testParse(`"hello" + "hello"`);
    testParseExpectError("1.22 + false");
});

test("parse subtraction", () => {
    testParse(`1.22  - 1.23  - 8 - 3.13`);
    testParseExpectError("1.22 - false");
});

test("parse multiplication", () => {
    testParse(`1.22  * 1.23  * 8 * 3.13`);
    testParseExpectError("1.22 * false");
});

test("parse division", () => {
    testParse(`1.22  / 1.23  / 8 / 3.13`);
    testParseExpectError("1.22 / false");
});

test("parse modulo", () => {
    testParse(`1.22  % 1.23  % 8 % 3.13`);
    testParseExpectError("1.22 % false");
});

test("parse order of operations", () => {
    testParse(`1.22  + 1.23  * 8 / 3.13`);
    testParse(`123 * 123 / 123 % 123 * 123`);
    testParse(`123 + 456 == 123 + 456`);
    testParse(`123 + 456 != 123 + 456 or 123 + 456 == 123 + 456`);
});

test("parse parens", () => {
    testParse(`(1.22  + 1.23)  * 8 / 3.13`);
});

test("parse block", () => {
    testParse(`{ 1.22  + 1.23  * { 8 / 3.13 } + 2. }`);
    testParse(`1 + 1; x = -2; -x`);
    testParse(`
        1 + 1;
        (2)
    `);
    testParseExpectError(`
        1 + 1
        (2)
    `);
});

test("parse variable assignment", () => {
    testParse(`
        x = 1.22
        y = { 1.23 }
        z = 3.13;
        x = 3.
    `);
    testParseExpectError(`x = 1.0; x = 1;`);
    testParseExpectError(`x = y = 2`);
    testParseExpectError(`x = y = 2;`);
    // testParseExpectError(`f = func foo(a: Int): Int { a };`);
});

test("parse if", () => {
    testParse(`if true { 1 } else { 2 }`);
    testParseExpectError(`if 1 { 1 } else { 2 }`);
    testParseExpectError(`if true { 1 }`);
    testParseExpectError(`if true { 1 } else { 2.0 }`);
    testParse(`x = 10; if x < 0 { 1 } else if x > 10 { 2 } else { 3 }`);
});

test("parse function", () => {
    // Functions without return types are allowed (inferred from body)
    testParse(`func foo() { 1 }`);
    testParse(`func add(a: Int, b: Int): Int { a + b }`);
    testParse(`
        func myFunc(a: Func[Int: Func[Int: Int]], b: Func[:Int]): Func[Int: Func[Int: Int]] {
            a
        }
    `);
    testParse(`func myFunc(a: Int): Int { a }; myFunc(1)`);
    testParseExpectError(`func myFunc(a: Int): Int { a }; myFunc(1.0)`);
    // Functions with params must be referenced with explicit type params
    testParseExpectError(
        `
        func foo(a: Int): Int {
            a
        }
        x = foo;
        `
    );
});

test("parse array literal", () => {
    testParseExpectError(`[]`);
    testParseExpectError(`[1, 2]: Str`);
    testParseExpectError(`[1, "2"]`);
    testParse(`[]: Arr[Int]`);
    testParseExpectError(`[]: Arr`);
    testParseExpectError(`[]: Arr[Int, Str]`);
});

test("parse array indexed access", () => {
    testParseExpectError(`x = [1, 2, 3]; x()`);
    testParseExpectError(`x = [1, 2, 3]; x("hello")`);
    testParseExpectError(`x = [1, 2, 3]; x(0, 1)`);
    testParseExpectError(`[1, 2, 3]()`);
    testParseExpectError(`[1, 2, 3]("hello")`);
    testParseExpectError(`[1, 2, 3](0, 1)`);
});

test("allow references to named functions", () => {
    testParse(`
        func foo(x: Int): Int {
            x
        };
        
        bar = foo[Int];

        bar(1)
    `);
});

test("parse filter iterator", () => {
    testParseExpectError(`
        func myFilter(x: Int): Int {
            x + 1
        };
        @filter(myFilter, [1, 2, 3])
    `);
});

test("parse reduce expression", () => {
    testParseExpectError(`
        func add(x: Int, y: Int): Int {
            x + y
        };
        @filter(myFilter, [1., 2., 3.], 0)
    `);
    testParseExpectError(`
        func add(x: Int, y: Int): Int {
            x + y
        };
        @filter(myFilter, [1, 2, 3], false)
    `);
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

test("parse trait-defined functions", () => {
    testParse(`
        trait Adder {
            add[Self, Self: Self],
        };

        func add(a: Int, b: Int): Int {
            a + b
        }

        func foo(a: T, b: T): T where T is Adder {
            add(a, b)
        }
        
        foo(1, 2)
        `
    );
    testParse(`
        trait Comparable {
            eq[Self, Self: Bool],
            lt[Self, Self: Bool]
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
        `
    );
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
            eq[Self, Self: Bool],
            lt[Self, Self: Bool]
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
            bar[Self, Self: Self],
        }

        func foo(x: T): T where T is Foo, T is Bar {x}

        foo(1)
    `);
});

test("parse struct definition", () => {
    testParse(`
        struct Point {
            x: Int,
            y: Int
        }
    `);
    testParse(`
        struct Empty {
        }
    `);
    testParseExpectError(`
        struct Point {
            x
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
            add[Self, Self: Self],
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
            add[Self, Self: Self],
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
            add[Self, Self: Self],
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

test.todo("parse struct with generic element", () => {
    testParse(`
        trait Any {}

        struct Point { x: T, y: T, } where T is Any;
    `);
     testParse(`
        trait Adder {
            add[Self, Self: Self],
        };

        struct Point { x: T, y: T, } where T is Adder;

        func add(a: Point, b: Point): Point {
            Point(add(a("x"), b("x")), add(a("y"), b("y")))
        };
    `);
});

test("parse exponentiation", () => {
    testParse(`2 ^ 3`);
    testParse(`2 ^ 3 ^ 4`);
    testParse(`2 + 3 ^ 4 * 5`);
    testParse(`-2 ^ 3`);
    testParseExpectError(`true ^ false`);
    testParseExpectError(`\"hello\" ^ 2`);
});

test("parse string indexing", () => {
    testParse(`\"hello\"(0)`);
    testParse(`\"hello\"(1)`);
    testParse(`x = "hello"; x(0)`);
});

test("parse variables named with JS reserved words", () => {
    testParse(`const = 5`);
    testParse(`let = 10`);
    testParse(`class = 20`);
    testParse(`return = true`);
    testParse(`func f(const: Int): Int { const }; f(5)`);
    testParse(`
        const = 1;
        let = 2;
        const + let
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

test("parse type conversion builtins", () => {
    testParse(`toStr(152)`);
    testParse(`toStr(true)`);
    testParse(`toStr(3.14)`);
    testParse(`toInt(3.14)`);
    testParse(`toInt(true)`);
    testParse(`toFloat(3)`);
    testParse(`toBool(1)`);
    testParse(`toBool(0)`);
    testParse(`"The number is " + toStr(152)`);
    testParseExpectError(`toStr(true, false)`);
    testParseExpectError(`toStr(Point(1, 2))`);
});

test("parse functional operations with structs", () => {
    testParse(`
        struct P { p: Int }

        filtered = filter(func (p: P) { p("p") > 0 }, [P(-1), P(2)]);
        filtered(0)("p")
    `);
    testParse(`
        struct P { p: Int }

        @map(func (p: P) { p("p") }, [P(1), P(2)])
    `);
});