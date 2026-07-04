import { describe, test } from "bun:test";

import { testCompile, testParse, testParseExpectError } from "./helpers";

describe("parse function", () => {
    test("parse function without explicit return type", () => {
        testParse(`func foo() { 1 } foo[]`);
        testParse(`func add(a: Num, b: Num) { a + b }; add[Num, Num]`);
    });

    test("parse function with explicit return type", () => {
        testParse(`
            func myFunc(a: Func[Num: Func[Num: Num]], b: Func[:Num]): Func[Num: Func[Num: Num]] {
                a
            }
            myFunc[Func[Num: Func[Num: Num]], Func[:Num]]
        `);
        testParse(`func myFunc(a: Int): Int { a }; myFunc(1i)`);
    });

    test("parse call to function without matching type signature", () => {
        testParseExpectError(`func myFunc(a: Num): Num { a }; myFunc(1i)`);
        testParseExpectError(`func myFunc(a: Num): Num { a }; myFunc[Str]`);
    });

    test("parse function with generics", () => {
        // Functions without return types are allowed (inferred from body)
        testParse(`func [T] foo(x: T) { 1 } foo[Num]`);
        testParse(`func [T, U] foo(x: T, y: U) { 1 } foo[Num, Int]`);
    });

    test("parse function with generics -- generics must appear as assoc. type or as param type", () => {
        testParseExpectError("func [T] foo(x: Num) { x } foo[Num]");
        testParseExpectError("func [T] foo(x: Num): T { x } foo[Num]");
    });

    test("parse function with generics & trait requirements", () => {
        testParse(
            `trait Foo {} trait Bar {} func [T: Foo, U: Bar] foo(x: T, y: U) { 1 } foo[Num, Int]`
        );
        testParse(`trait Foo {} trait Bar {} func [T: Foo + Bar] foo(x: T) { 1 } foo[Num]`);
        testParse(`trait Foo {} trait Bar {} func [T: Foo, T: Bar] foo(x: T) { 1 } foo[Num]`);
    });
});

test("compile functions", () => {
    testCompile(`func myFunc(a: Num, b: Num): Num { a + b }; myFunc(1, 2)`, 3);
});

test("compile recursive functions", () => {
    testCompile(
        `
        func factorial(n: Num): Num {
            if n <= 1 {
                1
            } else {
                n * factorial(n - 1)
            }
        };

        factorial(4)
        `,
        24
    );
});

test("compile functions as variables", () => {
    testCompile(
        `
        func foo(): Num {
            1
        };
        x = foo;
        y = foo[];
    
        x() + y()
        `,
        2
    );
    testCompile(
        `
        func foo(a: Num): Num {
            a
        };
        x = foo[Num];
        x(1)
        `,
        1
    );
    testCompile(
        `
            func call(f: Func[Num: Num], x: Num): Num {
                f(x)
            };
            
            func add1(x: Num): Num {
                x + 1
            };
            
            call(add1[Num], 1)
        `,
        2
    );
});

test("allow calling non-variable objects", () => {
    testCompile(
        `
        func foo(x: Num): Num {
            x + 1
        };

        func bar(): Func[Num: Num] {
            foo[Num]
        };

        bar()(1)
        `,
        2
    );
});

test("compile generic function without return type annotation", () => {
    testCompile(
        `
        func [T] id(x: T) { x }
        id(42)
    `,
        42
    );
    testCompile(
        `
        func [T] id(x: T) { x }
        id("hello")
    `,
        "hello"
    );
    // Generic function calling another generic function inside a generic body
    testCompile(
        `
        func [T] id(x: T) { x }
        func [T] wrap(x: T): T { id(x) }
        wrap(10)
    `,
        10
    );
    // Generic with trait-defined function, nested in another generic
    testCompile(
        `
        trait Foo {
            foo[Self: Self]
        }
        func foo(x: Num) { x }
        func [T: Foo] id(x: T) { foo(x) }
        func [T: Foo] wrap(x: T): T { id(x) }
        id(10)
    `,
        10
    );
    testCompile(
        `
        trait Foo {
            foo[Self: Self]
        }
        func foo(x: Num) { x }
        func [T: Foo] id(x: T) { foo(x) }
        func [T: Foo] wrap(x: T): T { id(x) }
        wrap(10)
    `,
        10
    );
});

test("non-anonymous functions do not have values unless annotated with param types", () => {
    testParseExpectError(
        `
        func foo(a: Num): Num {
            a
        }
        foo
        `
    );
    testParseExpectError(
        `
        func foo(a: Num): Num {
            a
        }
        x = foo
        `
    );
});

test("allow references to named functions", () => {
    testParse(`
        func foo(x: Num): Num {
            x
        };
        
        bar = foo[Num];

        bar(1)
    `);
});

test("functions: a function that returns a function on an iterable", () => {
    testCompile(
        `
        func makeGetter(i: Num) {
            func(t: Iter[Num]) {
                t(i)
            }
        }
        makeGetter(1)(range(1, 3))
        `,
        2
    );
    testCompile(
        `
        func makeGetter(i: Num) {
            func(t: Iter[Num]) {
                t(i)
            }
        }
        makeGetter(1)([1,2,3])
        `,
        2
    );
});

test("functions: generic type must appear in at least one param", () => {
    testParseExpectError(
        `
        func [T] makeGetter(i: Num): Func[Iter[T]: Maybe[T]] {
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
        func sumUpto(n: Num) {
            func f(n: Num, res: Num): Num {
                if n <= 0 { return res };
                f(n - 1, res + n)
            };
            f(n, 0)
        }
        # This is enough to exceed the max recursion depth limit in most JS runtimes
        sumUpto(10000)
        `,
        50005000
    );
});

test("recursive function with tail call optimization and JS reserved keyword", () => {
    testCompile(
        `
        func sumUpto(n: Num) {
            func f(n: Num, class: Num): Num {
                if n <= 0 { return class };
                f(n - 1, class + n)
            };
            f(n, 0)
        }
        sumUpto(10)
        `,
        55
    );
});

// ── Type-associated functions (static methods) ───────────

test("type-associated function: basic definition and call", () => {
    testCompile("func Int.zero() { 0 }; Int.zero()", 0);
});

test("type-associated function: with parameters", () => {
    testCompile("func Int.add(n: Num): Num { n + 1 }; Int.add(5)", 6);
});

test("type-associated function: on struct", () => {
    testCompile(
        `
        struct S { x: Num }
        func S.zero() { S(0) }
        S.zero().x
        `,
        0
    );
});

test("type-associated function: on Str type", () => {
    testCompile('func Str.zero() { "" }; Str.zero()', "");
});

test("type-associated function: missing type", () => {
    testParseExpectError("func Int.increment(i: Num) { i + 1 }; increment(1)");
});

test("type-associated function: non-type-associated function with same base name", () => {
    testCompile(
        `
        func Int.increment(i: Num) { i + 1 }
        func increment(i: Num) { i + 2 }
        (Int.increment(1), increment(1))
        `,
        [2, 3]
    );
});

// ── Templated TAFs: func Arr[Num].empty() ───────────────

test("TAF template: concrete Arr[Num].empty()", () => {
    testCompile(
        `
        func Arr[Num].empty() { []:Int }
        Arr[Num].empty()
        `,
        []
    );
});

test("TAF template: Arr[Num].zeros(n)", () => {
    testCompile(
        `
        func Arr[Num].zeros(n: Num) {
            map(\\_ 0, 1..n) | collect
        }
        Arr[Num].zeros(3)
        `,
        [0, 0, 0]
    );
});

test("TAF template: multiple template args", () => {
    testCompile(
        `
        func Arr[Num].empty() { []:Int }
        func Arr[Str].empty() { []:Str }
        (Arr[Num].empty(), Arr[Str].empty())
        `,
        [[], []]
    );
});

// ─ [T]─ Generic TAFs: func Arr[T].empty() ────

test("TAF generic: Arr[T].empty() monomorphized to Int", () => {
    testCompile(
        `
        func [T] Arr[T].empty() { []:T }
        Arr[Num].empty()
        `,
        []
    );
});

test("TAF generic: Arr[T].empty() monomorphized to Str", () => {
    testCompile(
        `
        func [T] Arr[T].empty() { []:T }
        Arr[Str].empty()
        `,
        []
    );
});

test("TAF generic: Arr[T].empty with type-param body", () => {
    testCompile(
        `
        func [T] Arr[T].fill(v: T, n: Num): Arr[T] {
            map(\\_ v, 1..n) | collect
        }
        Arr[Num].fill(42, 3)
        `,
        [42, 42, 42]
    );
});

// ── Type-param as associated type: func T.emptyArray() ──

test("TAF type-param: T.emptyArray() monomorphized to Int", () => {
    testCompile(
        `
        func [T] T.emptyArray() { []:T }
        Int.emptyArray()
        `,
        []
    );
});

test("TAF type-param: T.emptyArray() monomorphized to Str", () => {
    testCompile(
        `
        func [T] T.emptyArray() { []:T }
        Str.emptyArray()
        `,
        []
    );
});

// ── Trait integration ────────────────────────────────────

test("TAF trait: Self.zero in trait definition", () => {
    testParse(`
        trait Summable {
            add[Self, Self: Self],
            Self.zero[:Self]
        }
        1
    `);
});

test("TAF trait: struct implementing Self.zero", () => {
    testCompile(
        `
        trait Summable {
            add[Self, Self: Self],
            Self.zero[:Self]
        }
        struct S { s: Num }
        func add(a: S, b: S) { S(a.s + b.s) }
        func S.zero() { S(0) }
        func [T: Summable] sum(iter: Iter[T]) {
            reduce(\\(acc, x) { acc + x }, T.zero(), iter)
        }
        sum([S(1), S(2), S(3)]).s
        `,
        6
    );
});

// ── Automatic array -> iterator conversion ────────────────────────────────────

test("automatic Arr -> Iter conversion: fallback on Iter signature if no matching Arr signature exists", () => {
    testCompile(
        `
        func foo(iter: Iter[Num]) { 1 }
        foo([1,2,3])
        `,
        1
    );
});

test("automatic Arr -> Iter conversion: fallback should happen only if no matching Arr signature exists", () => {
    testCompile(
        `
        func foo(iter: Iter[Num]) { 1 }
        func foo(iter: Arr[Num]) { 2 }
        foo([1,2,3])
        `,
        2
    );
    testCompile(
        `
        func foo(iter: Arr[Num]) { 2 }
        func foo(iter: Iter[Num]) { 1 }
        foo([1,2,3])
        `,
        2
    );
});
