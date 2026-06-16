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
    testCompile("x = 1; x", 1n);
});

test("can use else-less if as statement", () => {
    // else-less if as a statement (not assigned) is fine
    testCompile(`mut x = 0; if true { x = 5 }; x`, 5n);
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
        func double(x: Int): Int { x * 2 };
        double([1, 2, 3](0))
    `);
});

// ── unwrap with default ──────────────────────────────────

test("unwrap with default returns value when in bounds", () => {
    testCompile("unwrap([10, 20, 30](1), 0)", 20n);
});

test("unwrap with default returns default when out of bounds", () => {
    testCompile("unwrap([10, 20, 30](99), 0)", 0n);
});

test("unwrap with default on nested access", () => {
    testCompile("x = unwrap([[1, 2], [3, 4]](0), []:Int); unwrap(x(1), -1)", 2n);
});

test("unwrap with default on multi-dimensional access", () => {
    testCompile("unwrap([[1, 2], [3, 4]](0, 1), -1)", 2n);
});

test("unwrap with default type mismatch errors", () => {
    testParseExpectError('unwrap([1, 2](0), "hello")');
});

// ── unwrap without default (abort) ────────────────────────

test("unwrap without default returns value when in bounds", () => {
    testCompile("unwrap([10, 20, 30](1))", 20n);
});

test("unwrap without default throws when out of bounds", () => {
    // Expect a runtime error/throw
    testCompileExpectRuntimeError(
        "unwrap([1, 2, 3](99))",
        "Unwrapped on None without a fallback value"
    );
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
        1n
    );
});

test("Maybe variable cannot be used without unwrapping", () => {
    testParseExpectError("x = [1, 2, 3](0); x + 1");
});

// ── Maybe as function return type ─────────────────────────

test("function returning Maybe", () => {
    testParse(`
        func safeHead(arr: Arr[Int]): Maybe[Int] {
            arr(0)
        }
        safeHead[Arr[Int]]
    `);
});

test("calling function that returns Maybe requires unwrap", () => {
    testParseExpectError(`
        func safeHead(arr: Arr[Int]): Maybe[Int] {
            arr(0)
        };
        safeHead([1, 2, 3]) + 1
    `);
});

test("unwrap on function returning Maybe", () => {
    testCompile(
        `
        func safeHead(arr: Arr[Int]): Maybe[Int] {
            arr(0)
        };
        unwrap(safeHead([10, 20, 30]), -1)
    `,
        10n
    );
});

// ── Maybe as function parameter type ─────────────────────────

test("function with Maybe parameter", () => {
    testCompile(
        `
        func issome(x: Maybe[Int]): Bool {
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
    testCompile("[10, 20, 30]!(1)", 20n);
});

test("unsafe call can be used in operations directly", () => {
    testCompile("[10, 20, 30]!(1) + 1", 21n);
});

test("unsafe call on multi-dimensional array", () => {
    testCompile("[[1, 2], [3, 4]]!(0, 1)", 2n);
});

test("unsafe call on nested access", () => {
    testCompile("[[1, 2], [3, 4]]!(0)!(1)", 2n);
});

test("unsafe call on variable", () => {
    testCompile("x = [1, 2, 3]; x!(1)", 2n);
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
        map(func(i: Int){x!((i*p) % n)}, 1..n) | collect
        `,
        [5n, 4n, 3n, 2n, 1n]
    );
    testCompile(
        `
        n = 5;
        p = 4;
        x = 1..n | collect;
        map(\\i x!((i*p) % n), 1..n) | collect
        `,
        [5n, 4n, 3n, 2n, 1n]
    );
});
