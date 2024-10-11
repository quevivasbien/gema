import { expect, test } from "bun:test";
import { writeJS } from "../src/write-js";
import { testParse } from "./parse.test";

function testCompile(text: string, expectEqual?: any) {
    const ast = testParse(text, false);
    const sourceOut = writeJS(ast);
    expect(sourceOut).toMatchSnapshot();
    if (expectEqual) {
        expect(eval(sourceOut)).toEqual(expectEqual);
    }
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
        }

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
        }
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
        }
        x = foo[Int];
        x(1)
        `,
        1n
    );
    testCompile(
        `
            func call(f: Func[Int, Int], x: Int): Int {
                f(x)
            }
            
            func add1(x: Int): Int {
                x + 1
            }
            
            call(add1[Int], 1)
        `,
        2n
    );
});

test("anonymous functions", () => {
    testCompile(
        `
            f = func(a: Int, b: Int): Int {
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
            (func(a: Int, b: Int): Int {
                a + b
            })(1, 2)
        `,
        3n
    );
    testCompile(
        `
            func foo(a: Int): Func[Int] {
                func(): Int {
                    a
                }
            }
            
            foo(1)()
        `,
        1n
    );
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
    testCompile(`@map(func(x: Int): Int { x + 1 }, [1, 2, 3])`, [2n, 3n, 4n]);
    testCompile(
        `
        add1 = func(x: Int): Int {
            x + 1
        };
        iter = map(
            add1,
            map(add1, [1, 2, 3])
        );

        @iter
        `,
        [3n, 4n, 5n]
    )
});