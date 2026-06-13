import { test } from "bun:test";

import { testCompile, testParse, testParseExpectError } from "./helpers";

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

test("allow calling non-variable objects", () => {
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

test("allow references to named functions", () => {
    testParse(`
        func foo(x: Int): Int {
            x
        };
        
        bar = foo[Int];

        bar(1)
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

test("functions: a function that returns a function on an iterable", () => {
    testCompile(
        `
        func makeGetter(i: Int) {
            func(t: Iter[Int]) {
                t(i)
            }
        }
        makeGetter(1)(range(1, 3))
        `,
        2n
    );
    testCompile(
        `
        func makeGetter(i: Int) {
            func(t: Iter[Int]) {
                t(i)
            }
        }
        makeGetter(1)([1,2,3])
        `,
        2n
    );
});

test.todo("functions: generic function with generic type only in nested function signature", () => {
    testCompile(
        `
        trait Any {}
        func makeGetter(i: Int): Func[Iter[T]: T] where T is Any {
            func(t: Iter[T]) {
                t(i)
            }
        }
        makeGetter(1)([1,2,3])
        `,
        2n
    );
});
