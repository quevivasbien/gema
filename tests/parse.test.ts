import { expect, test } from "bun:test";
import { scan } from "../src/scan";
import { parse } from "../src/parse";
import { resetRegistries } from "../src/ast";

export function testParse(text: string) {
    resetRegistries();
    const tokens = scan(text);
    const { ast, errors } = parse(tokens);
    if (errors.length > 0) {
        console.log(errors);
    }
    expect(errors.length).toBe(0);
    return ast;
}

function testParseExpectError(text: string) {
    resetRegistries();
    const tokens = scan(text);
    const { ast, errors } = parse(tokens);
    expect(errors.length).toBeGreaterThan(0);
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
});

test.todo("parse variable reassignment", () => {
    testParse("x = 1; x = x + 1");
    testParse("x = 1; x = x + 1; x");
    testParse("x = 1; x = 2; x");
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

test.todo("parse struct with generic element", () => {
    testParse(`
        trait Any {}

        struct Point { x: T, y: T, } where T is Any;
    `);
    testParse(`
        trait Adder {
            add[(a: Self, b: Self): Self],
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

test.todo("parse automatic conversion of array to iterator", () => {
    testParse(`
        func toStr(iter: Iter[Bool]) {
            strs = map(func(x: Bool){ if x { "*" } else { " " }}, iter);
            reduce(func(acc:Str, x:Str){acc+x}, strs, "")
        }

        toStr([false, true, false, true])
    `);
});

test.todo("parse treat builtin functions as valid functions", () => {
    testParse(`f = toFloat[Int];`);
    testParse(`map(toStr, range(1, 3))`);
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

test("parse generic function without return type annotation", () => {
    // Generic functions can infer return type from body
    testParse(`
        trait Any {}
        func foo(a: T) where T is Any { a }
    `);
    // Body returning concrete type (not the type param)
    testParse(`
        trait Any {}
        func bar(a: T) where T is Any { 42 }
    `);
    // Multiple type params
    testParse(`
        trait Any {}
        func id(x: T) where T is Any { x }
        id(42)
    `);
    // Generic function without return type, used with trait dispatch
    testParse(`
        trait Any {}
        func id(x: T) where T is Any { x }
        id(42)
    `);
    // Generic function calling another generic function inside a generic body
    testParse(`
        trait Any {}
        func id(x: T) where T is Any { x }
        func wrap(x: T): T where T is Any { id(x) }
        wrap(10)
    `);
    // Generic with trait-defined function, nested in another generic
    testParse(`
        trait Foo {
            foo[(x: Self): Self]
        }
        func foo(x: Int) { x }
        func id(x: T) where T is Foo { foo(x) }
        func wrap(x: T): T where T is Foo { id(x) }
        id(10)
    `);
    testParse(`
        trait Foo {
            foo[(x: Self): Self]
        }
        func foo(x: Int) { x }
        func id(x: T) where T is Foo { foo(x) }
        func wrap(x: T): T where T is Foo { id(x) }
        wrap(10)
    `);
});

test("parse anonymous function with return type annotation", () => {
    // Basic anonymous function with return type
    testParse(`func (x: Int): Int { x + 1 }`);
    // Return type matching body
    testParse(`func (x: Int): Int { x }`);
    // Return type that's different from final expression but still valid
    testParse(`x = func (a: Int): Int { a }; x(5)`);
    // Anonymous function with return type used in map
    testParse(`
        @map(func (x: Int): Int { x + 1 }, [1, 2, 3])
    `);
    // Anonymous function with return type used in filter
    testParse(`
        @filter(func (x: Int): Bool { x > 0 }, [1, 2, 3])
    `);
    // Anonymous function with return type used in reduce
    testParse(`
        reduce(func (acc: Int, x: Int): Int { acc + x }, [1, 2, 3], 0)
    `);
    // Anonymous function without return type should still work (no regression)
    testParse(`func (x: Int) { x + 1 }`);

    // Error: anonymous function with conflicting return type
    testParseExpectError(`func (x: Int): Str { x + 1 }`);
    testParseExpectError(`func (x: Int): Bool { x }`);
    testParseExpectError(`func (x: Bool): Int { x }`);
});
