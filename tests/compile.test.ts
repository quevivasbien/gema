import { expect, test } from "bun:test";
import { writeJS } from "../src/write-js";
import { testParse } from "./parse.test";

function testCompile(text: string, expectEqual: any) {
    const ast = testParse(text);
    const sourceOut = writeJS(ast);
    if (expectEqual !== null) {
        expect(eval(sourceOut)).toEqual(expectEqual);
    }
    return sourceOut;
}

// For testing whether two programs produce the same compiled output
function requireIdenticalCompilation(text1: string, text2: string) {
    const js1 = testCompile(text1, null);
    const js2 = testCompile(text2, null);
    expect(js1).toEqual(js2);
}

test("compile literals", () => {
    testCompile(`1`, 1n);
    testCompile(`1.23`, 1.23);
    testCompile(`true`, true);
    testCompile(`false`, false);
    testCompile(`"hello"`, "hello");
});

test("compile binary expressions", () => {
    testCompile(`1 + 2`, 3n);
    testCompile(`1 - 2`, -1n);
    testCompile(`1 * 2`, 2n);
    testCompile(`1 / 2`, 0n);
    testCompile(`3 * (1 + 3) / 2`, 6n);
    testCompile(`5 % 3`, 2n);
    testCompile(`-5 % 3`, 1n);
    testCompile(`true and false`, false);
    testCompile(`true or false`, true);
    testCompile(`1 == 1`, true);
    testCompile(`1 != 1`, false);
    testCompile(`(1 > 2) and (3 < 4)`, false);
    testCompile(`(1 > 2) or (3 < 4)`, true);
});

test("compile block", () => {
    testCompile(`{ 1 }`, 1n);
    testCompile(`1 + { 1 }`, 2n);
    testCompile(`{ 1; }`, null);
    testCompile(
        `
            (-32 / 4) % { 1 + 2 } 
        `,
        1n
    );
});

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
            x = 1.2;
            y = { 2.3 }
            x = x + y
        `,
        3.5
    );
});

test("compile if expressions", () => {
    testCompile(`if true { 1 } else { 2 }`, 1n);
    testCompile(`if false { 1 } else { 2 }`, 2n);
    testCompile(`if 1 == 1 { 1 } else { 2 }`, 1n);
    testCompile(`if 1 == 2 { 1 } else { 2 }`, 2n);
    testCompile(
        `
        x = 1;
        if true {
            x = 2;
        } else {
            x = 3;
        }
        x
        `,
        1n
    );
    testCompile(
        `
        if false {
            0
        }
        else if 1 > 0 {
            1
        } 
        else {
            2
        }
        `,
        1n
    );
});

test("compile functions", () => {
    testCompile(`func myFunc(a: Int, b: Int): Int { a + b }; myFunc(1, 2)`, 3n);
});

test("compile recursive functions", () => {
    testCompile(
        `
        func factorial(n: Int): Int {
            if n <= 1 {
                1
            } else {
                n * factorial(n - 1)
            }
        };

        factorial(4)
        `,
        24n
    );
});

test("compile functions as variables", () => {
    testCompile(
        `
        func foo(): Int {
            1
        };
        x = foo;
        y = foo[];
    
        x() + y()
        `,
        2n
    );
    testCompile(
        `
        func foo(a: Int): Int {
            a
        };
        x = foo[Int];
        x(1)
        `,
        1n
    );
    testCompile(
        `
            func call(f: Func[Int: Int], x: Int): Int {
                f(x)
            };
            
            func add1(x: Int): Int {
                x + 1
            };
            
            call(add1[Int], 1)
        `,
        2n
    );
});

test("anonymous functions", () => {
    testCompile(
        `
            f = func(a: Int, b: Int) {
                a + b
            };
            f(1, 2)
        `,
        3n
    );
});

test("allow calling non-variable objects", () => {
    testCompile(
        `
            (func(a: Int, b: Int) {
                a + b
            })(1, 2)
        `,
        3n
    );
    testCompile(
        `
            func foo(a: Int): Func[:Int] {
                func() {
                    a
                }
            }
            
            foo(1)()
        `,
        1n
    );
    testCompile(
        `
        func foo(x: Int): Int {
            x + 1
        };

        func bar(): Func[Int: Int] {
            foo[Int]
        };

        bar()(1)
        `,
        2n
    );
});

test("compile arrays", () => {
    testCompile(
        `
            [1, 2, 3]
        `,
        [1n, 2n, 3n]
    );

    testCompile(
        `
            ["1", "2", "3"]
        `,
        ["1", "2", "3"]
    );

    testCompile(
        `
            []: Int + [1, 2, 3] + [1]
        `,
        [1n, 2n, 3n, 1n]
    );
});

test("compile array indexed access", () => {
    testCompile(
        `
            x = [1, 2, 3];
            x(0)
        `,
        1n
    );
    testCompile(
        `
            x = [[1, 2], [3, 4]];
            x(0, 1)
        `,
        2n
    );
    testCompile(
        `
            [1, 2, 3](0)
        `,
        1n
    );
    testCompile(
        `
            [[1, 2], [3, 4]](0, 1)
        `,
        2n
    );
});

test("compile map iterator", () => {
    testCompile(`@map(func(x: Int) { x + 1 }, [1, 2, 3])`, [2n, 3n, 4n]);
    testCompile(
        `
        func foo(x: Int): Int {
            x
        };
        
        @map(foo, [1, 2, 3])
        `,
        [1n, 2n, 3n]
    );
    testCompile(
        `
        add1 = func(x: Int) {
            x + 1
        };
        iter = map(
            add1,
            map(add1, [1, 2, 3])
        );

        @iter
        `,
        [3n, 4n, 5n]
    );
    testCompile(
        `
        arr = ["hello", "there"];
        iter = map(arr, [1, 1, 0]);
        @iter
        `,
        ["there", "there", "hello"]
    );
});

test("compile filter iterator", () => {
    testCompile(
        `
        func isEven(x: Int): Bool {
            x % 2 == 0
        };
        iter = filter(isEven, [1, 2, 3, 4, 5]);
        @iter
        `,
        [2n, 4n]
    );
});

test("compile reduce expression", () => {
    testCompile(
        `
        reduce(
            func(x: Int, y: Int) {
                x * y    
            },
            [1, 2, 3],
            1
        )
        `,
        6n
    );
    testCompile(
        `
        func add(x: Int, y: Int): Int {
            x + y
        };
        reduce(add, [1, 2, 3], 0)
        `,
        6n
    );
    testCompile(
        `
        func sum(x: Iter[Int]): Int {
            reduce(func(a: Int, b: Int) { a + b }, x, 0)
        }

        sum(range(0, 100))
        `,
        5050n
    );
});

test("compile repeated use of iterator", () => {
    testCompile(
        `
        x = range(1, 3);

        [x(0), x(2), x(1)]
    `,
        [1n, 3n, 2n]
    );
    testCompile(
        `
        x = range(1, 3);

        @x;
        @x
    `,
        [1n, 2n, 3n]
    );
    testCompile(
        `
        x = range(1, 3);
        y = map(func(i: Int){ i + 1 }, x);

        @x;
        @y
    `,
        [2n, 3n, 4n]
    );
    testCompile(
        `
        x = range(1, 3);
        y = map(func(i: Int){ i + 1 }, x);

        @y;
        @x
    `,
        [1n, 2n, 3n]
    );
    testCompile(
        `
        x = range(1, 3);
        y = reduce(func(acc: Int, x: Int){acc+x}, x, 0);

        y + reduce(func(acc: Int, x: Int){acc+x}, x, 0)
    `,
        12n
    );
});

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

test("compile functional operations with structs", () => {
    testCompile(
        `
        struct P { p: Int }

        filtered = filter(func (p: P) { p("p") > 0 }, [P(-1), P(2)]);
        filtered(0)("p")
    `,
        2n
    );
    testCompile(
        `
        struct P { p: Int }

        @map(func (p: P) { p("p") }, [P(1), P(2)])
    `,
        [1n, 2n]
    );
});

test("compile reduce with structs", () => {
    testCompile(
        `
        struct P { p: Int };
        func addP(a: P, b: P): P {
            P(a("p") + b("p"))
        };
        result = reduce(addP, [P(1), P(2), P(3)], P(0));
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

test("compile exponentiation", () => {
    testCompile(`2 ^ 3`, 8n);
    testCompile(`2 ^ 3 ^ 2`, 512n); // Right-associative: 2^(3^2) = 2^9 = 512
    testCompile(`2 + 3 ^ 2 * 2`, 20n); // 2 + (9 * 2) = 20
    testCompile(`(-2) ^ 3`, -8n); // -2^3 = -8
    testCompile(`-2 ^ 2`, -4n); // Exponentiation takes precedence over unary -
    testCompile(`5 ^ 0`, 1n);
    testCompile(`2.0 ^ 3.0`, 8.0);
});

test("compile string indexing", () => {
    testCompile(`"hello"(0)`, "h");
    testCompile(`"hello"(1)`, "e");
    testCompile(`"hello"(4)`, "o");
    testCompile(`x = "hello"; x(0)`, "h");
});

test("compile variables named with JS reserved words", () => {
    testCompile(
        `
        const = 5;
        const + 1
    `,
        6n
    );
    testCompile(
        `
        let = 10;
        let
    `,
        10n
    );
    testCompile(
        `
        class = 20;
        class
    `,
        20n
    );
    testCompile(
        `
        return = true;
        return
    `,
        true
    );
    testCompile(
        `
        func f(const: Int): Int {
            const
        };
        f(5)
    `,
        5n
    );
    testCompile(
        `
        const = 1;
        let = 2;
        const + let
    `,
        3n
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

test("compile type conversion builtins", () => {
    testCompile(`toStr(152)`, "152");
    testCompile(`toStr(true)`, "true");
    testCompile(`toStr(3.14)`, "3.14");
    testCompile(`toInt(3.14)`, 3n);
    testCompile(`toInt(-3.14)`, -3n);
    testCompile(`toInt(-3.8)`, -3n);
    testCompile(`toInt(true)`, 1n);
    testCompile(`toFloat(3)`, 3.0);
    testCompile(`toBool(1)`, true);
    testCompile(`toBool(0)`, false);
    testCompile(`"The number is " + toStr(152)`, "The number is 152");
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

test.todo("compile special operator functions for builtin types", () => {
    testCompile("add(1, 2)", 3n);
    testCompile("multiply(1, 2)", 2n);
    testCompile("subtract(1.0, 2.0)", 1.0 - 2.0);
    testCompile("less(1.0, 2.0)", true);

    requireIdenticalCompilation("add(1.0, 2.0)", "1.0 + 2.0");
    requireIdenticalCompilation("add([1,2], [3])", "[1,2] + [3]");
});

test("compile fallback on functions with Iter params when calling with Arr", () => {
    // Tests the combination of both features:
    //   1. Nested generic type Iter[T] in the signature
    //   2. Auto array-to-iterator conversion (Arr[Int] → Iter[Int])
    testCompile(
        `
        func foo(x: Iter[Int]) { reduce(func(acc: Int, x: Int){acc+x}, [1,2,3], 0) }

        foo([1,2,3])
     `,
        6n
    );
    // If Arr signature is available, this is the one that should be used
    testCompile(
        `
        func matches(x: Arr[Int]) { true }

        func matches(x: Iter[Int]) { false }

        matches([1])
    `,
        true
    );
});

test("compile function with nested generic type", () => {
    testCompile(
        `
        trait Any {}

        func getLength(arr: Arr[T]): Int where T is Any {
            reduce(func(acc: Int, x: T) { acc + 1 }, arr, 0)
        }

        getLength([1,2,3])
    `,
        3n
    );
    testCompile(
        `
        trait Summable {
            sum[(a: Self, b: Self): Self],
        }

        func computeSum(arr: Arr[T]): T where T is Summable {
            reduce(func(acc: T, x: T) { sum(acc, x) }, arr, 0)
        }

        func sum(x: Int, y: Int): Int {
            x + y
        }

        computeSum([1,2,3])
    `,
        6n
    );
    // Tests the combination of both features:
    //   1. Nested generic type Iter[T] in the signature
    //   2. Auto array-to-iterator conversion (Arr[Int] → Iter[Int])
    testCompile(
        `
        trait Summable {
            sum[(a: Self, b: Self): Self],
        }

        func sum(iter: Iter[T], start: T): T where T is Summable {
            reduce(func(acc: T, x: T) { sum(acc, x) }, iter, start)
        }

        func sum(a: Int, b: Int): Int {
            a + b
        }

        sum([1, 2, 3], 0)
    `,
        6n
    );
    testCompile(
        `
        trait Concat {
            concat[(a: Self, b: Self): Self],
        }

        func join(iter: Iter[T], start: T): T where T is Concat {
            reduce(func(acc: T, x: T) { concat(acc, x) }, iter, start)
        }

        func concat(a: Arr[Int], b: Arr[Int]): Arr[Int] {
            a + b
        }

        join([[1,2], [3,4], [5,6]], []: Int)
    `,
        [1n, 2n, 3n, 4n, 5n, 6n]
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

test("compile generic function without return type annotation", () => {
    testCompile(
        `
        trait Any {}
        func id(x: T) where T is Any { x }
        id(42)
    `,
        42n
    );
    testCompile(
        `
        trait Any {}
        func id(x: T) where T is Any { x }
        id("hello")
    `,
        "hello"
    );
    // Generic function calling another generic function inside a generic body
    testCompile(
        `
        trait Any {}
        func id(x: T) where T is Any { x }
        func wrap(x: T): T where T is Any { id(x) }
        wrap(10)
    `,
        10n
    );
    // Generic with trait-defined function, nested in another generic
    testCompile(
        `
        trait Foo {
            foo[(x: Self): Self]
        }
        func foo(x: Int) { x }
        func id(x: T) where T is Foo { foo(x) }
        func wrap(x: T): T where T is Foo { id(x) }
        id(10)
    `,
        10n
    );
    testCompile(
        `
        trait Foo {
            foo[(x: Self): Self]
        }
        func foo(x: Int) { x }
        func id(x: T) where T is Foo { foo(x) }
        func wrap(x: T): T where T is Foo { id(x) }
        wrap(10)
    `,
        10n
    );
});

test("compile anonymous function with return type annotation", () => {
    testCompile(`func (x: Int): Int { x + 1 }(5)`, 6n);
    testCompile(`@map(func (x: Int): Int { x + 1 }, [1, 2, 3])`, [2n, 3n, 4n]);
    testCompile(`@filter(func (x: Int): Bool { x > 0 }, [1, 2, 3])`, [1n, 2n, 3n]);
    testCompile(`reduce(func (acc: Int, x: Int): Int { acc + x }, [1, 2, 3], 0)`, 6n);
    // Regular anonymous functions still work
    testCompile(`func (x: Int) { x + 1 }(5)`, 6n);
});
