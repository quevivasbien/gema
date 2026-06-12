import { test } from "bun:test";

import { testParse, testCompile } from "./helpers";

// ============================================================
// Dict
// ============================================================

test("Dict: basic", () => {
    testParse(`Dict([("a", 1), ("b", 2)])`);
});

test("Dict: compile and access with numeric key", () => {
    testCompile(`m = Dict([(1, 1), (2, 2)]); m(1)`, 1n);
    testCompile(`m = Dict([(1, 1), (2, 2)]); m(2)`, 2n);
    testCompile(`m = Dict([(1., 1.), (2., 2.)]); m(2.)`, 2.0);
});

test("Dict: compile and access with non-numeric key", () => {
    testCompile(`m = Dict([("a", 1), ("b", 2)]); m("a")`, 1n);
    testCompile(`m = Dict([("a", 1), ("b", 2)]); m("b")`, 2n);
    testCompile(`arr = [1, 2]; m = Dict([(arr, 1),]); m(arr)`, 1n);
    testCompile(`struct S {}; s = S(); m = Dict([(s, 1),]); m(s)`, 1n);
});

test("Dict: access missing key", () => {
    testCompile(`m = Dict([("a", 1)]); m("x")`, undefined);
    testCompile(`m = Dict([([1,2], 1),]); m([1,2])`, undefined);  // This should be undefined, since [1,2] is not actually the same object as the array that was used in the map
});

// TODO: Tests for mutable Dicts

// ============================================================
// Set
// ============================================================

test("Set: basic", () => {
    testParse("Set([1, 2, 3])");
});

test("Set: compile", () => {
    testCompile("s = Set([1, 2, 3]); s", new Set([1n, 2n, 3n]));
});

test("Set: contains", () => {
    testCompile("s = Set([1, 2, 3]); contains(s, 1)", true);
    testCompile("s = Set([1, 2, 3]); contains(s, 4)", false);
});

test("Set: union", () => {
    testCompile("a = Set([1, 2]); b = Set([2, 3]); union(a, b)", new Set([1n, 2n, 3n]));
});

test("Set: intersect", () => {
    testCompile("a = Set([1, 2, 3]); b = Set([2, 3, 4]); intersect(a, b)", new Set([2n, 3n]));
});

// TODO: Tests for mutable sets