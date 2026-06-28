import { test } from "bun:test";

import {
    testCompile,
    testCompileExpectRuntimeError,
    testParse,
    testParseExpectError,
} from "./helpers";

// ============================================================
// Maybe type — handling undefined values
// ============================================================
//
// The Maybe type is a compile-time wrapper that tracks values
// that could be undefined (e.g., out-of-bounds array access).
// It does NOT wrap values at runtime — it's purely a type-system
// construct that forces explicit handling of undefined.

// ── Array/iterator access returns Maybe ───────────────────

// ============================================================
// Null prohibition — cannot assign null values to variables
// ============================================================

test("cannot assign null from dropped block", () => {
    testParseExpectError("x = { 1; }");
});

test("cannot assign null from else-less if", () => {
    testParseExpectError("x = if true { 1 }");
});

test("can use dropped statement on assignment", () => {
    // The semicolon on the assignment itself is fine (x = 1;)
    testCompile("x = 1; x", 1);
});

test("can use else-less if as statement", () => {
    // else-less if as a statement (not assigned) is fine
    testCompile(`mut x = 0; if true { x = 5 }; x`, 5);
});

test("array index out of bounds compiles but returns undefined", () => {
    // This should compile and run, returning undefined at runtime
    testCompile("[1, 2, 3](5)", undefined);
});

// ── Maybe cannot be used directly in operations ───────────

test("cannot add Maybe to Int", () => {
    testParseExpectError("arr = [1, 2, 3]; arr(0) + 1");
});

test("cannot compare Maybe with ==", () => {
    testParseExpectError("arr = [1, 2, 3]; arr(0) == arr(1)");
});

test("cannot pass Maybe to function expecting plain type", () => {
    testParseExpectError(`
        func double(x: Num): Num { x * 2 };
        double([1, 2, 3](0))
    `);
});

// ── unwrap with default ──────────────────────────────────

test("unwrap with default returns value when in bounds", () => {
    testCompile("unwrap(0, [10, 20, 30](1))", 20);
    testCompile("[10, 20, 30](1) | unwrap(0)", 20);
});

test("unwrap with default returns default when out of bounds", () => {
    testCompile("unwrap(0, [10, 20, 30](99))", 0);
    testCompile("[10, 20, 30](99) | unwrap(0)", 0);
});

test("unwrap with default on nested access", () => {
    testCompile("x = unwrap([]:Num, [[1, 2], [3, 4]](0)); unwrap(-1, x(1))", 2);
});

test("unwrap with default on multi-dimensional access", () => {
    testCompile("unwrap(-1, [[1, 2], [3, 4]](0, 1))", 2);
});

test("unwrap with default type mismatch errors", () => {
    testParseExpectError('unwrap("hello", [1, 2](0))');
});

// ── unwrap without default (abort) ────────────────────────

test("unwrap without default returns value when in bounds", () => {
    testCompile("unwrap([10, 20, 30](1))", 20);
});

test("unwrap without default throws when out of bounds", () => {
    // Expect a runtime error/throw
    testCompileExpectRuntimeError("unwrap([1, 2, 3](99))");
});

// ── isnone ────────────────────────────────────────────────

test("isnone returns false for in-bounds access", () => {
    testCompile("isnone([10, 20, 30](1))", false);
});

test("isnone returns true for out-of-bounds access", () => {
    testCompile("isnone([10, 20, 30](99))", true);
});

test("isnone cannot be called on non-Maybe type", () => {
    testParseExpectError("isnone(42)");
});

// ── Maybe in variable assignments ─────────────────────────

test("Maybe array access can be assigned to variable", () => {
    testCompile(
        `
        x = [1, 2, 3](0);
        if isnone(x) {
            -1
        } else {
            unwrap(x)
        }
        `,
        1
    );
});

test("Maybe variable cannot be used without unwrapping", () => {
    testParseExpectError("x = [1, 2, 3](0); x + 1");
});

// ── Maybe as function return type ─────────────────────────

test("function returning Maybe", () => {
    testParse(`
        func safeHead(arr: Arr[Num]): Maybe[Num] {
            arr(0)
        }
        safeHead[Arr[Num]]
    `);
});

test("calling function that returns Maybe requires unwrap", () => {
    testParseExpectError(`
        func safeHead(arr: Arr[Num]): Maybe[Num] {
            arr(0)
        };
        safeHead([1, 2, 3]) + 1
    `);
});

test("unwrap on function returning Maybe", () => {
    testCompile(
        `
        func safeHead(arr: Arr[Num]): Maybe[Num] {
            arr(0)
        };
        unwrap(-1, safeHead([10, 20, 30]))
    `,
        10
    );
});

// ── Maybe as function parameter type ─────────────────────────

test("function with Maybe parameter", () => {
    testCompile(
        `
        func issome(x: Maybe[Num]): Bool {
            !isnone(x)
        }
        x = [1,2](0);
        issome(x)
        `,
        true
    );
});

test("function with generic Maybe parameter", () => {
    testCompile(
        `
        trait Any {}
        func issome(x: Maybe[T]): Bool where T is Any {
            !isnone(x)
        }
        x = [1,2](0);
        issome(x)
        `,
        true
    );
});

// ── Unsafe call (!) syntax ──────────────────────────────

test("unsafe call returns raw type not Maybe", () => {
    testCompile("[10, 20, 30]!(1)", 20);
});

test("unsafe call can be used in operations directly", () => {
    testCompile("[10, 20, 30]!(1) + 1", 21);
});

test("unsafe call on multi-dimensional array", () => {
    testCompile("[[1, 2], [3, 4]]!(0, 1)", 2);
});

test("unsafe call on nested access", () => {
    testCompile("[[1, 2], [3, 4]]!(0)!(1)", 2);
});

test("unsafe call on variable", () => {
    testCompile("x = [1, 2, 3]; x!(1)", 2);
});

test("unsafe call out of bounds still returns undefined at runtime", () => {
    testCompile("[1, 2, 3]!(5)", undefined);
});

test("unsafe call in map iterator", () => {
    testCompile(
        `
        n = 5;
        p = 4;
        x = 1..n | collect;
        map(func(i: Num){x!((i*p) % n)}, 1..n) | collect
        `,
        [5, 4, 3, 2, 1]
    );
    testCompile(
        `
        n = 5;
        p = 4;
        x = 1..n | collect;
        map(\\i x!((i*p) % n), 1..n) | collect
        `,
        [5, 4, 3, 2, 1]
    );
});

// ── `some()` builtin ─────────────────────────────────────

test("some wraps a value", () => {
    testCompile("some(42)", 42);
});

test("some returns Maybe type (cannot be used directly)", () => {
    testParseExpectError("some(42) + 1");
});

test("some result can be unwrapped", () => {
    testCompile("unwrap(some(42))", 42);
});

test("some result isnone returns false", () => {
    testCompile("isnone(some(42))", false);
});

test("some with string type", () => {
    testCompile('unwrap(some("hello"))', "hello");
});

test("some can be chained with unwrap default", () => {
    testCompile("some(7) | unwrap(0)", 7);
});

// ── `none` keyword ──────────────────────────────────────

test("none creates Maybe type (cannot be used directly)", () => {
    testParseExpectError("none:Int + 1");
});

test("none can be used with unwrap default", () => {
    testCompile("none:Num | unwrap(42)", 42);
});

test("none result isnone returns true", () => {
    testCompile("isnone(none:Int)", true);
});

test("none with string type", () => {
    testCompile('unwrap("default", none:Str)', "default");
});

test("none with inferred usage in if-else", () => {
    testCompile(
        `
        x = none:Num;
        if isnone(x) {
            -1
        } else {
            unwrap(x)
        }
        `,
        -1
    );
});

// ── `match` expression ───────────────────────────────────

test("match some extracts value", () => {
    testCompile("match some(42) { some(v) v, none 0 }", 42);
});

test("match none returns default", () => {
    testCompile("match none:Num { some(v) v, none 0 }", 0);
});

test("match some with expression", () => {
    testCompile("match some(5) { some(v) v * 2, none -1 }", 10);
});

test("match some with block expression", () => {
    testCompile("match some(5) { some(v) { w = v * 2; w + 1 }, none -1 }", 11);
});

test("match some from array access", () => {
    testCompile(
        `
        x = [10, 20, 30](1);
        match x { some(v) v, none -1 }
        `,
        20
    );
});

test("match none from out-of-bounds access", () => {
    testCompile(
        `
        x = [10, 20, 30](99);
        match x { some(v) v, none -1 }
        `,
        -1
    );
});

test("match on function returning Maybe", () => {
    testCompile(
        `
        func safeHead(arr: Arr[Num]): Maybe[Num] {
            arr(0)
        };
        match safeHead([10, 20, 30]) { some(v) v, none -1 }
        `,
        10
    );
});

test("match on function returning Maybe with out-of-bounds", () => {
    testCompile(
        `
        func safeHead(arr: Arr[Num]): Maybe[Num] {
            arr(0)
        };
        match safeHead([]:Num) { some(v) v, none -1 }
        `,
        -1
    );
});

test("match on value of variable with same name as unwrapped var", () => {
    testCompile(
        `
        x = some(1);
        match x {
            some(x) x + 1,
            none 1
        }
        `,
        2
    );
});

test("match type mismatch errors", () => {
    testParseExpectError('match some(42) { some(v) v, none "hello" }');
});

test("match on non-Maybe type errors", () => {
    testParseExpectError("match 42 { some(v) v, none 0 }");
});

test("match value used as expression", () => {
    testCompile("(match some(3) { some(v) v + 1, none 0 }) + 10", 14);
});

test("match some arm uses binding in expression", () => {
    testCompile("match some(7) { some(n) n * n, none 0 }", 49);
});

test("match without check for all conditions has null type", () => {
    testParseExpectError("match some(1) { some(v) v }", "cannot have Null type");
    testParseExpectError("match some(1) { none 1 }", "cannot have Null type");
});
