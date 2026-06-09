import { expect, test } from "bun:test";
import { writeJS } from "../src/write-js";
import { testParse } from "./parse.test";

function testCompile(text: string, expectEqual: any) {
    const ast = testParse(text, false);
    const sourceOut = writeJS(ast);
    // expect(sourceOut).toMatchSnapshot();
    expect(eval(sourceOut)).toEqual(expectEqual);
    return sourceOut;
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
    testCompile(`
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
    testCompile(`
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
    )
})

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

test.todo("compile repeated use of iterator", () => {
    testCompile(`
        x = range(1, 3);

        [x(0), x(2), x(1)]
    `, [1n, 3n, 2n]);
});

test("compile struct construction and field access", () => {
    testCompile(`
        struct Point {
            x: Int,
            y: Int
        };
        p = Point(1, 2);
        p("x") + p("y")
    `, 3n);
});

test("compile struct field access on param", () => {
    testCompile(`
        struct Point {
            x: Int,
            y: Int
        };
        func getX(p: Point): Int {
            p("x")
        };
        getX(Point(5, 10))
    `, 5n);
});

test("compile struct with generic identity function", () => {
    testCompile(`
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
    `, 3n);
});

test("compile struct with trait generic (add two points)", () => {
    testCompile(`
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

        result = foo(Point(1, 2), Point(3, 4));
        result("x") + result("y")
    `, 10n);
});

test("compile struct with trait generic (chained add)", () => {
    testCompile(`
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
    `, 21n);
});

test("compile struct with multiple generic type params", () => {
    testCompile(`
        trait Any {}

        struct Point { x: Int, y: Int };
        struct Pair { a: Int, b: Int };
        
        func foo(a: T, b: U): Arr[T] where T is Any, U is Any {
            [a]
        };
        result = foo(Point(1, 2), Pair(3, 4));
        result(0)("x")
    `, 1n);
});

test("compile trait-defined functions", () => {
    testCompile(`
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
        `,
        3n
    );
    testCompile(`
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
        
        [lte(2, 3), lte(3, 3), lte(4,3)]
        `,
        [true, true, false]
    );
});

test("compile functional operations with structs", () => {
    testCompile(`
        struct P { p: Int }

        filtered = filter(func (p: P) { p("p") > 0 }, [P(-1), P(2)]);
        filtered(0)("p")
    `, 2n);
    testCompile(`
        struct P { p: Int }

        @map(func (p: P) { p("p") }, [P(1), P(2)])
    `, [1n, 2n]);
});

test("compile reduce with structs", () => {
    testCompile(`
        struct P { p: Int };
        func addP(a: P, b: P): P {
            P(a("p") + b("p"))
        };
        result = reduce(addP, [P(1), P(2), P(3)], P(0));
        result("p")
    `, 6n);
});

test("compile function returning struct field access", () => {
    testCompile(`
        struct P { p: Int };
        func getP(): P { P(7) };
        getP()("p")
    `, 7n);
});

test("compile exponentiation", () => {
    testCompile(`2 ^ 3`, 8n);
    testCompile(`2 ^ 3 ^ 2`, 512n);  // Right-associative: 2^(3^2) = 2^9 = 512
    testCompile(`2 + 3 ^ 2 * 2`, 20n);  // 2 + (9 * 2) = 20
    testCompile(`(-2) ^ 3`, -8n);  // -2^3 = -8
    testCompile(`-2 ^ 2`, -4n);  // Exponentiation takes precedence over unary -
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
    testCompile(`
        const = 5;
        const + 1
    `, 6n);
    testCompile(`
        let = 10;
        let
    `, 10n);
    testCompile(`
        class = 20;
        class
    `, 20n);
    testCompile(`
        return = true;
        return
    `, true);
    testCompile(`
        func f(const: Int): Int {
            const
        };
        f(5)
    `, 5n);
    testCompile(`
        const = 1;
        let = 2;
        const + let
    `, 3n);
});

test("compile dot syntax for struct field access", () => {
    testCompile(`
        struct Point { x: Int, y: Int };
        p = Point(1, 2);
        p.x + p.y
    `, 3n);
    testCompile(`
        struct Point { x: Int, y: Int };
        func getPoint(): Point { Point(5, 10) };
        getPoint().x
    `, 5n);
    testCompile(`
        struct Point { x: Int, y: Int };
        p = Point(1, 2);
        p("x") + p.x
    `, 2n);
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

test.todo("compile function with nested generic type", () => {
    testCompile(`
        func getLength(arr: Arr[T]): Int {
            reduce(func(acc: Int, x: Int) { acc + 1 }, arr, 0)
        }

        getLength([1,2,3])
    `, 3n);
    testCompile(`
        trait Summable {
            sum[Self, Self: Self],
        }

        func computeSum(arr: Arr[T]): T where T is Summable {
            reduce(func(acc: T, x: T) { sum(acc, x) }, arr, 0)
        }

        func sum(a: Int, y: Int): Int {
            x + y
        }

        computeSum([1,2,3])
    `, 6n);
});