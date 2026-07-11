import { test } from "bun:test";

import { testCompile, testParse, testParseExpectError } from "./helpers";

// ============================================================
// Basic anonymous functions (func syntax with explicit types)
// ============================================================

test("anon: basic", () => {
    testCompile(
        `
        f = func(a: Num, b: Num) {
            a + b
        };
        f(1, 2)
    `,
        3
    );
    testParse("func(x:Arr[Num]){x(0)}");
});

test("anon: directly invoked", () => {
    testCompile(
        `
        (func(a: Num, b: Num) {
            a + b
        })(1, 2)
    `,
        3
    );
});

test("anon: nested in function returning closure", () => {
    testCompile(
        `
        func foo(a: Num): Func[:Num] {
            func() {
                a
            }
        }

        foo(1)()
    `,
        1
    );
});

test("anon: with return type annotation", () => {
    testCompile(`func (x: Num): Num { x + 1 }(5)`, 6);
    testCompile(`collect(map(func (x: Num): Num { x + 1 }, [1, 2, 3]))`, [2, 3, 4]);
    testCompile(`collect(filter(func (x: Num): Bool { x > 0 }, [1, 2, 3]))`, [1, 2, 3]);
    testCompile(`reduce(func (acc: Num, x: Num): Num { acc + x }, 0, [1, 2, 3])`, 6);
});

test("anon: without return type annotation still works", () => {
    testCompile(`func (x: Num) { x + 1 }(5)`, 6);
});

test("anon: parse return type annotations", () => {
    testParse(`func (x: Num): Num { x + 1 }`);
    testParse(`func (x: Num): Num { x }`);
    testParse(`x = func (a: Num): Num { a }; x(5)`);
    testParse(`collect(map(func (x: Num): Num { x + 1 }, [1, 2, 3]))`);
    testParse(`collect(filter(func (x: Num): Bool { x > 0 }, [1, 2, 3]))`);
    testParse(`reduce(func (acc: Num, x: Num): Num { acc + x }, 0, [1, 2, 3])`);
    testParse(`func (x: Num) { x + 1 }`);
});

test("anon: parse error on conflicting return type", () => {
    testParseExpectError(`func (x: Num): Str { x + 1 }`);
    testParseExpectError(`func (x: Num): Bool { x }`);
    testParseExpectError(`func (x: Bool): Num { x }`);
});

test("anon: closure captures variables by reference", () => {
    testCompile(
        `
        mut x = 1;
        f = func() { x = x + 1; x };
        f()
    `,
        2
    );
    testCompile(
        `
        mut x = 1;
        f = func() { x = x + 1; x };
        f();
        f();
        x
    `,
        3
    );
});

test("anon: multiple closures sharing captured var", () => {
    testCompile(
        `
        mut x = 0;
        inc = func() { x = x + 1; x };
        dec = func() { x = x - 1; x };
        inc();
        inc();
        dec();
        x
    `,
        1
    );
});

test("anon: each factory call gets own mutable var", () => {
    testCompile(
        `
        func makeCounter(): Func[:Num] {
            mut count = 0;
            func() {
                count = count + 1;
                count
            }
        };
        a = makeCounter();
        b = makeCounter();
        a();
        a();
        b();
        b()
    `,
        2
    );
});

// ============================================================
// Backslash syntax (\x { body })
// ============================================================

test("anon: backslash basic", () => {
    // Simple backslash function directly invoked
    testCompile("(\\x { x + 1 })(5)", 6);
});

test("anon: backslash with no braces", () => {
    testCompile("(\\x x)(5)", 5);
});

test("anon: backslash multiple params", () => {
    testCompile("(\\(a, b) { a + b })(3, 4)", 7);
});

test("anon: backslash multiple params, missing comma", () => {
    testParseExpectError("(\\a b { a + b })(3, 4)");
});

test("anon: backslash multiple params, no curly braces", () => {
    testCompile("(\\(a, b)  a + b)(3, 4)", 7);
});

test("anon: backslash zero params", () => {
    // TODO: I don't actually think we should allow this. It seems like this will create parsing ambiguities.
    testCompile("(\\ { 42 })()", 42);
});

test("anon: backslash in map", () => {
    testCompile("collect(map(\\x { x + 1 }, [1, 2, 3]))", [2, 3, 4]);
});

test("anon: backslash in filter", () => {
    testCompile("collect(filter(\\x { x % 2 == 0 }, [1, 2, 3, 4, 5]))", [2, 4]);
});

test("anon: backslash in reduce", () => {
    testCompile("reduce(\\(acc, x) { acc + x }, 0, [1, 2, 3])", 6);
});

test("anon: backslash in takeWhile", () => {
    testCompile("collect(takeWhile(\\x { x < 3 }, range(0, 10)))", [0, 1, 2]);
});

test("anon: backslash in dropWhile", () => {
    testCompile("collect(dropWhile(\\x { x < 3 }, [1, 2, 3, 4, 5]))", [3, 4, 5]);
});

test("anon: backslash in iterate", () => {
    testCompile("collect(take(3, iterate(\\x { x + 1 }, 0)))", [0, 1, 2]);
});

test("anon: backslash nested", () => {
    // Nested backslash: map of map
    testCompile("collect(map(\\row { collect(map(\\x { x * 2 }, row)) }, [[1, 2], [3, 4]]))", [
        [2, 4],
        [6, 8],
    ]);
});

test("anon: backslash in pipe", () => {
    // Pipe value into a backslash function
    testCompile("5 | \\x { x + 1 }", 6);
});

test("anon: backslash in pipe, bare function call with no braces", () => {
    // Function with single param
    testCompile(
        `
        func foo(x: Num) { x + 1}
        1  | \\x foo(x)
        `,
        2
    );
    // Function with multiple params
    testCompile(
        `
        func foo(x: Num, y: Num) { x + y }
        1  | \\x foo(x, 1)
        `,
        2
    );
});

test("anon: backslash in chained pipe", () => {
    // Function with single param
    testCompile(
        `
        func foo(x: Num) { x + 1}
        1  | \\x foo(x) | \\x foo(x)
        `,
        3
    );
    // Function with multiple params
    testCompile(
        `
        func foo(x: Num, y: Num) { x + y }
        1  | \\x foo(x, 1) | \\x foo(x, 2)
        `,
        4
    );
});

test("anon: pipe into map", () => {
    testCompile(
        `
        func foo(x: Num) { x + 1 }
        [1,2,3]  | \\x map(foo[Num], x) | collect
        `,
        [2, 3, 4]
    );
    // Chained pipe
    testCompile(
        `
        func foo(x: Num) { x + 1 }
        [1,2,3]  | \\x map(foo[Num], x) | \\x map(foo[Num], x) | collect
        `,
        [3, 4, 5]
    );
});

test("anon: pipe with func syntax", () => {
    // Pipe with existing func syntax (parenthesized and bare)
    testCompile("3 | (func(x: Num) { x + 1 })", 4);
    testCompile("3 | func(x: Num) { x + 1 }", 4);
});

test("anon: backslash inside generic function body", () => {
    testCompile(
        `
        func [T] length(arr: Iter[T]): Num {
            reduce(\\(acc, x) { acc + 1 }, 0, arr)
        };
        length([10, 20, 30])
    `,
        3
    );
});

// ============================================================
// Inference — verifying types are correctly inferred
// ============================================================

test("anon: inference — map deduces param type from iterable", () => {
    // x should be inferred as Int from [1,2,3]
    testCompile("collect(map(\\x { x * 2 }, [1, 2, 3]))", [2, 4, 6]);
});

test("anon: inference — map deduces param type from string iterable", () => {
    // x should be inferred as Str
    testCompile('collect(map(\\x { x + "!" }, ["a", "b"]))', ["a!", "b!"]);
});

test("anon: inference — filter deduces param type", () => {
    testCompile("collect(filter(\\x { x > 0 }, [1, 2, 3]))", [1, 2, 3]);
});

test("anon: inference — reduce deduces acc and element types", () => {
    testCompile("reduce(\\(acc, x) { acc + x }, 0, [1, 2, 3])", 6);
    testCompile('reduce(\\(acc, x) { acc + x }, "", ["a", "b", "c"])', "abc");
});

test("anon: inference — iterate deduces param/return type from start", () => {
    testCompile("collect(take(3, iterate(\\x { x * 2 }, 1)))", [1, 2, 4]);
});

test("anon: inference — from direct call args", () => {
    testCompile("(\\(x, y) { x + y })(10, 20)", 30);
});

test("anon: inference — return type flows to caller", () => {
    // In map, the return type of the function becomes the element type of the result
    testCompile("first = collect(map(\\x { toStr(x) }, [1, 2, 3]))(0); first", "1");
});

test("anon: inference — complex body with conditionals", () => {
    testCompile("collect(filter(\\x { if x > 0 { true } else { false } }, [-1, 0, 1, 2]))", [1, 2]);
});

// ============================================================
// Error cases — when inference fails or types conflict
// ============================================================

test("anon: error — backslash cannot have type annotations", () => {
    // The \\ syntax is for inference only; annotating types is not allowed
    testParseExpectError("\\x: Num { x + 1 }");
});

test("anon: error — func syntax requires type annotations", () => {
    // The func() syntax still requires explicit types on each param
    testParseExpectError("func(x) { x + 1 }");
});

test("anon: error — backslash as argument requires inferrable context", () => {
    // When passed to something that's not a known builtin/func, should error
    testParseExpectError("foo(\\x { x + 1 })");
});

test("anon: error — body uses param in incompatible way with inferred type", () => {
    // If x is inferred as Int but body tries to use it as Str
    testParseExpectError(`collect(map(\\x { x + "!" }, [1, 2, 3]))`);
});

test("anon: error — type mismatch in builtin function arg", () => {
    // filter expects Bool return, but body returns Int
    testParseExpectError("collect(filter(\\x { x + 1 }, [1, 2, 3]))");
});

test("anon: error — backslash cannot be assigned to variable", () => {
    // Backslash syntax only works in direct call contexts; use func(x: Type) for variable assignment
    testParseExpectError("f = \\x { x + 1 }; f(5)");
});

// ============================================================
// Inference — user-defined functions
// ============================================================

test("anon: inference — user-defined function with lambda", () => {
    testCompile(
        `
        func apply(fn: Func[Num: Num], x: Num): Num { fn(x) }
        apply(\\x { x + 1 }, 5)
    `,
        6
    );
});

test("anon: inference — user-defined function, structural match", () => {
    testCompile(
        `
        func transform(arr: Arr[Num], fn: Func[Num: Num]): Iter[Num] { map(fn, arr) }
        collect(transform([1, 2, 3], \\x { x * 2 }))
    `,
        [2, 4, 6]
    );
});

test("anon: inference — user-defined generic function", () => {
    testCompile(
        `
        func [T] apply(fn: Func[T: T], x: T): T { fn(x) }
        apply(\\x { x + 1 }, 5)
    `,
        6
    );
    testCompile(
        `
        func [T] apply(fn: Func[T: T], x: T): T { fn(x) }
        apply(\\x { x + "!" }, "hello")
    `,
        "hello!"
    );
});

test("anon: inference — user-defined function checks return type", () => {
    // Lambda body returns Str but function expects Func[Num: Num] → error
    testParseExpectError(`
        func apply(fn: Func[Num: Num], x: Num): Num { fn(x) }
        apply(\\x { "oops" }, 5)
    `);
});

test("anon: inference — user-defined function with 2-param lambda", () => {
    testCompile(
        `
        func fold(fn: Func[Num, Num: Num], init: Num, arr: Arr[Num]): Num {
            reduce(fn, init, arr)
        }
        fold(\\(acc, x) { acc + x }, 0, [1, 2, 3])
    `,
        6
    );
});

test("anon: inference — lambda as non-first arg to user-defined function", () => {
    testCompile(
        `
        func schedule(x: Num, fn: Func[Num: Num]): Num { fn(x) }
        schedule(5, \\x { x * 3 })
    `,
        15
    );
});

test("anon: inference — unambiguous by lambda param count", () => {
    // Two overloads differing in the FuncType's param count — the lambda's
    // param count should disambiguate.
    testCompile(
        `
        func foo(f: Func[Num, Num: Num]) { f(1, 2) }
        func foo(f: Func[Num: Num]) { f(1) }

        foo(\\x { x + 1 })
    `,
        2
    );
});
