import { test } from "bun:test";

import { testCompile, testParse, testParseExpectError } from "./helpers";

// ============================================================
// Basic anonymous functions (func syntax with explicit types)
// ============================================================

test("anon: basic", () => {
    testCompile(
        `
        f = func(a: Int, b: Int) {
            a + b
        };
        f(1, 2)
    `,
        3n
    );
    testParse("func(x:Arr[Int]){x(0)}");
});

test("anon: directly invoked", () => {
    testCompile(
        `
        (func(a: Int, b: Int) {
            a + b
        })(1, 2)
    `,
        3n
    );
});

test("anon: nested in function returning closure", () => {
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
});

test("anon: with return type annotation", () => {
    testCompile(`func (x: Int): Int { x + 1 }(5)`, 6n);
    testCompile(`collect(map(func (x: Int): Int { x + 1 }, [1, 2, 3]))`, [2n, 3n, 4n]);
    testCompile(`collect(filter(func (x: Int): Bool { x > 0 }, [1, 2, 3]))`, [1n, 2n, 3n]);
    testCompile(`reduce(func (acc: Int, x: Int): Int { acc + x }, 0, [1, 2, 3])`, 6n);
});

test("anon: without return type annotation still works", () => {
    testCompile(`func (x: Int) { x + 1 }(5)`, 6n);
});

test("anon: parse return type annotations", () => {
    testParse(`func (x: Int): Int { x + 1 }`);
    testParse(`func (x: Int): Int { x }`);
    testParse(`x = func (a: Int): Int { a }; x(5)`);
    testParse(`collect(map(func (x: Int): Int { x + 1 }, [1, 2, 3]))`);
    testParse(`collect(filter(func (x: Int): Bool { x > 0 }, [1, 2, 3]))`);
    testParse(`reduce(func (acc: Int, x: Int): Int { acc + x }, 0, [1, 2, 3])`);
    testParse(`func (x: Int) { x + 1 }`);
});

test("anon: parse error on conflicting return type", () => {
    testParseExpectError(`func (x: Int): Str { x + 1 }`);
    testParseExpectError(`func (x: Int): Bool { x }`);
    testParseExpectError(`func (x: Bool): Int { x }`);
});

test("anon: closure captures variables by reference", () => {
    testCompile(
        `
        mut x = 1;
        f = func() { x = x + 1; x };
        f()
    `,
        2n
    );
    testCompile(
        `
        mut x = 1;
        f = func() { x = x + 1; x };
        f();
        f();
        x
    `,
        3n
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
        1n
    );
});

test("anon: each factory call gets own mutable var", () => {
    testCompile(
        `
        func makeCounter(): Func[:Int] {
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
        2n
    );
});

// ============================================================
// Backslash syntax (\x { body })
// ============================================================

test("anon: backslash basic", () => {
    // Simple backslash function directly invoked
    testCompile("(\\x { x + 1 })(5)", 6n);
});

test("anon: backslash with no braces", () => {
    testCompile("(\\x x)(5)", 5n);
});

test("anon: backslash multiple params", () => {
    testCompile("(\\(a, b) { a + b })(3, 4)", 7n);
});

test("anon: backslash multiple params, missing comma", () => {
    testParseExpectError("(\\a b { a + b })(3, 4)");
});

test("anon: backslash multiple params, no curly braces", () => {
    testCompile("(\\(a, b)  a + b)(3, 4)", 7n);
});

test("anon: backslash zero params", () => {
    testCompile("(\\ { 42 })()", 42n);
});

test("anon: backslash in map", () => {
    testCompile("collect(map(\\x { x + 1 }, [1, 2, 3]))", [2n, 3n, 4n]);
});

test("anon: backslash in filter", () => {
    testCompile("collect(filter(\\x { x % 2 == 0 }, [1, 2, 3, 4, 5]))", [2n, 4n]);
});

test("anon: backslash in reduce", () => {
    testCompile("reduce(\\(acc, x) { acc + x }, 0, [1, 2, 3])", 6n);
});

test("anon: backslash in takeWhile", () => {
    testCompile("collect(takeWhile(\\x { x < 3 }, range(0, 10)))", [0n, 1n, 2n]);
});

test("anon: backslash in dropWhile", () => {
    testCompile("collect(dropWhile(\\x { x < 3 }, [1, 2, 3, 4, 5]))", [3n, 4n, 5n]);
});

test("anon: backslash in iterate", () => {
    testCompile("collect(take(3, iterate(\\x { x + 1 }, 0)))", [0n, 1n, 2n]);
});

test("anon: backslash nested", () => {
    // Nested backslash: map of map
    testCompile("collect(map(\\row { collect(map(\\x { x * 2 }, row)) }, [[1, 2], [3, 4]]))", [
        [2n, 4n],
        [6n, 8n],
    ]);
});

test("anon: backslash in pipe", () => {
    // Pipe value into a backslash function
    testCompile("5 | \\x { x + 1 }", 6n);
});

test("anon: backslash in pipe, bare function call with no braces", () => {
    // Function with single param
    testCompile(
        `
        func foo(x: Int) { x + 1}
        1  | \\x foo(x)
        `,
        2n
    );
    // Function with multiple params
    testCompile(
        `
        func foo(x: Int, y: Int) { x + y }
        1  | \\x foo(x, 1)
        `,
        2n
    );
});

test("anon: backslash in chained pipe", () => {
    // Function with single param
    testCompile(
        `
        func foo(x: Int) { x + 1}
        1  | \\x foo(x) | \\x foo(x)
        `,
        3n
    );
    // Function with multiple params
    testCompile(
        `
        func foo(x: Int, y: Int) { x + y }
        1  | \\x foo(x, 1) | \\x foo(x, 2)
        `,
        4n
    );
});

test("anon: pipe into map", () => {
    testCompile(
        `
        func foo(x: Int) { x + 1 }
        [1,2,3]  | \\x map(foo[Int], x) | collect
        `,
        [2n, 3n, 4n]
    );
    // Chained pipe
    testCompile(
        `
        func foo(x: Int) { x + 1 }
        [1,2,3]  | \\x map(foo[Int], x) | \\x map(foo[Int], x) | collect
        `,
        [3n, 4n, 5n]
    );
});

test("anon: pipe with func syntax", () => {
    // Pipe with existing func syntax (parenthesized and bare)
    testCompile("3 | (func(x: Int) { x + 1 })", 4n);
    testCompile("3 | func(x: Int) { x + 1 }", 4n);
});

test("anon: backslash inside generic function body", () => {
    testCompile(
        `
        trait Any {}
        func length(arr: Iter[T]): Int where T is Any {
            reduce(\\(acc, x) { acc + 1 }, 0, arr)
        };
        length([10, 20, 30])
    `,
        3n
    );
});

// ============================================================
// Inference — verifying types are correctly inferred
// ============================================================

test("anon: inference — map deduces param type from iterable", () => {
    // x should be inferred as Int from [1,2,3]
    testCompile("collect(map(\\x { x * 2 }, [1, 2, 3]))", [2n, 4n, 6n]);
});

test("anon: inference — map deduces param type from string iterable", () => {
    // x should be inferred as Str
    testCompile('collect(map(\\x { x + "!" }, ["a", "b"]))', ["a!", "b!"]);
});

test("anon: inference — filter deduces param type", () => {
    testCompile("collect(filter(\\x { x > 0 }, [1, 2, 3]))", [1n, 2n, 3n]);
});

test("anon: inference — reduce deduces acc and element types", () => {
    testCompile("reduce(\\(acc, x) { acc + x }, 0, [1, 2, 3])", 6n);
    testCompile('reduce(\\(acc, x) { acc + x }, "", ["a", "b", "c"])', "abc");
});

test("anon: inference — iterate deduces param/return type from start", () => {
    testCompile("collect(take(3, iterate(\\x { x * 2 }, 1)))", [1n, 2n, 4n]);
});

test("anon: inference — from direct call args", () => {
    testCompile("(\\(x, y) { x + y })(10, 20)", 30n);
});

test("anon: inference — return type flows to caller", () => {
    // In map, the return type of the function becomes the element type of the result
    testCompile("first = collect(map(\\x { toStr(x) }, [1, 2, 3]))(0); first", "1");
});

test("anon: inference — complex body with conditionals", () => {
    testCompile("collect(filter(\\x { if x > 0 { true } else { false } }, [-1, 0, 1, 2]))", [
        1n,
        2n,
    ]);
});

// ============================================================
// Error cases — when inference fails or types conflict
// ============================================================

test("anon: error — backslash cannot have type annotations", () => {
    // The \\ syntax is for inference only; annotating types is not allowed
    testParseExpectError("\\x: Int { x + 1 }");
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
