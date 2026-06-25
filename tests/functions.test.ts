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
    testParse(`func foo() { 1 } foo[]`);
    testParse(`func add(a: Int, b: Int): Int { a + b }; add[Int, Int]`);
    testParse(`
        func myFunc(a: Func[Int: Func[Int: Int]], b: Func[:Int]): Func[Int: Func[Int: Int]] {
            a
        }
        myFunc[Func[Int: Func[Int: Int]], Func[:Int]]
    `);
    testParse(`func myFunc(a: Int): Int { a }; myFunc(1)`);
    testParseExpectError(`func myFunc(a: Int): Int { a }; myFunc(1.0)`);
});

test("non-anonymous functions do not have values unless annotated with param types", () => {
    testParseExpectError(
        `
        func foo(a: Int): Int {
            a
        }
        foo
        `
    );
    testParseExpectError(
        `
        func foo(a: Int): Int {
            a
        }
        x = foo
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

test("functions: generic type must appear in at least one param", () => {
    testParseExpectError(
        `
        trait Any {}
        func makeGetter(i: Int): Func[Iter[T]: Maybe[T]] where T is Any {
            func(t: Iter[T]) {
                t(i)
            }
        }
        makeGetter(1)([1,2,3])
        `
    );
});

test("recursive function with tail call optimization", () => {
    testCompile(
        `
        func sumUpto(n: Int) {
            func f(n: Int, res: Int): Int {
                if n <= 0 { return res };
                f(n - 1, res + n)
            };
            f(n, 0)
        }
        # This is enough to exceed the max recursion depth limit in most JS runtimes
        sumUpto(10000)
        `,
        50005000n
    );
});

test("recursive function with tail call optimization and keyword args", () => {
    testCompile(
        `
        func sumUpto(n: Int) {
            func f(n: Int, res: Int): Int {
                if n <= 0 { return res };
                f(res=res + n, n=n-1)
            };
            f(n, 0)
        }
        sumUpto(10)
        `,
        55n
    );
});

test("recursive function with tail call optimization and JS reserved keyword", () => {
    testCompile(
        `
        func sumUpto(n: Int) {
            func f(n: Int, class: Int): Int {
                if n <= 0 { return class };
                f(n - 1, class + n)
            };
            f(n, 0)
        }
        sumUpto(10)
        `,
        55n
    );
});

// ── Type-associated functions (static methods) ───────────

test("type-associated function: basic definition and call", () => {
    testCompile("func Int.zero() { 0 }; Int.zero()", 0n);
});

test("type-associated function: with parameters", () => {
    testCompile("func Int.add(n: Int): Int { n + 1 }; Int.add(5)", 6n);
});

test("type-associated function: on struct", () => {
    testCompile(
        `
        struct S { x: Int }
        func S.zero() { S(0) }
        S.zero().x
        `,
        0n
    );
});

test("type-associated function: on Str type", () => {
    testCompile('func Str.zero() { "" }; Str.zero()', "");
});

test("type-associated function: missing type", () => {
    testParseExpectError("func Int.increment(i: Int) { i + 1 }; increment(1)");
});

test("type-associated function: non-type-associated function with same base name", () => {
    testCompile(
        `
        func Int.increment(i: Int) { i + 1 }
        func increment(i: Int) { i + 2 }
        (Int.increment(1), increment(1))
        `,
        [2n, 3n]
    );
});

// ── Templated TAFs: func Arr[Int].empty() ───────────────

test("TAF template: concrete Arr[Int].empty()", () => {
    testCompile(
        `
        func Arr[Int].empty() { []:Int }
        Arr[Int].empty()
        `,
        []
    );
});

test("TAF template: Arr[Int].zeros(n)", () => {
    testCompile(
        `
        func Arr[Int].zeros(n: Int) {
            map(\\_ 0, 1..n) | collect
        }
        Arr[Int].zeros(3)
        `,
        [0n, 0n, 0n]
    );
});

test("TAF template: multiple template args", () => {
    testCompile(
        `
        func Arr[Int].empty() { []:Int }
        func Arr[Str].empty() { []:Str }
        (Arr[Int].empty(), Arr[Str].empty())
        `,
        [[], []]
    );
});

// ── Generic TAFs: func Arr[T].empty() where T is Any ────

test("TAF generic: Arr[T].empty() monomorphized to Int", () => {
    testCompile(
        `
        trait Any {}
        func Arr[T].empty() where T is Any { []:T }
        Arr[Int].empty()
        `,
        []
    );
});

test("TAF generic: Arr[T].empty() monomorphized to Str", () => {
    testCompile(
        `
        trait Any {}
        func Arr[T].empty() where T is Any { []:T }
        Arr[Str].empty()
        `,
        []
    );
});

test("TAF generic: Arr[T].empty with type-param body", () => {
    testCompile(
        `
        trait Any {}
        func Arr[T].fill(v: T, n: Int): Arr[T] where T is Any {
            map(\\_ v, 1..n) | collect
        }
        Arr[Int].fill(42, 3)
        `,
        [42n, 42n, 42n]
    );
});

// ── Type-param as associated type: func T.emptyArray() ──

test("TAF type-param: T.emptyArray() monomorphized to Int", () => {
    testCompile(
        `
        trait Any {}
        func T.emptyArray() where T is Any { []:T }
        Int.emptyArray()
        `,
        []
    );
});

test("TAF type-param: T.emptyArray() monomorphized to Str", () => {
    testCompile(
        `
        trait Any {}
        func T.emptyArray() where T is Any { []:T }
        Str.emptyArray()
        `,
        []
    );
});

// ── Trait integration ────────────────────────────────────

test("TAF trait: Self.zero in trait definition", () => {
    testParse(`
        trait Summable {
            add[(a: Self, b: Self): Self],
            Self.zero[():Self]
        }
        1
    `);
});

test("TAF trait: struct implementing Self.zero", () => {
    testCompile(
        `
        trait Summable {
            add[(a: Self, b: Self): Self],
            Self.zero[():Self]
        }
        struct S { s: Int }
        func add(a: S, b: S) { S(a.s + b.s) }
        func S.zero() { S(0) }
        func sum(iter: Iter[T]) where T is Summable {
            reduce(\\(acc, x) { acc + x }, T.zero(), iter)
        }
        sum([S(1), S(2), S(3)]).s
        `,
        6n
    );
});
