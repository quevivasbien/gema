import { test } from "bun:test";

import { testParse, testCompile, requireIdenticalCompilation, testParseExpectError } from "./helpers";

// ============================================================
// Dict
// ============================================================

test("Dict: basic", () => {
    testParse(`Dict([("a", 1), ("b", 2)])`);
});

test("Dict: create empty Dict", () => {
    testParse(`Dict([]:Tuple[Int, Int])`);
    testCompile(`d = Dict([]:Tuple[Int, Int]); d(1)`, undefined);
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

test.todo("MutDict: create mutable dict with trans", () => {
    testParse(`m = trans(Dict[("a", 1),])`);
    testParse(`d = Dict[("a", 1),]; trans(d)`);
});

test.todo("MutDict: create mutable dict with unsafeTrans", () => {
    testParse(`m = unsafeTrans(Dict[("a", 1),])`);
    testParse(`d = Dict[("a", 1),]; unsafeTrans(d)`);
});

test.todo("MutDict: add to a mutable dict", () => {
    testCompile(`m = trans(Dict[("a", 1),]); put(m, "b", 2); m("b")`, 2n);
    testCompile(`m = trans(Dict[("a", 1),]); put(m, "b", 2)("b")`, 2n);  // Put should evaluate to the new value of the MutDict
});

test.todo("MutDict: remove from a mutable dict", () => {
    testCompile(`m = trans(Dict[("a", 1),]); remove(m, "a", 2)("a")`, undefined);
    testCompile(`m = trans(Dict[("a", 1),]); put(m, "b", 2); m("b")`, 2n);
});

test.todo("MutDict: when using trans, mutating a mutable dict does not change the original", () => {
    testCompile(`d = Dict[("a", 1),]; m = trans(d); remove(m, "a", 2); d("a")`, 1n);
});

test.todo("MutDict: when using unsafeTrans, mutating a mutable dict does change the original", () => {
    testCompile(`d = Dict[("a", 1),]; m = unsafeTrans(d); remove(m, "a", 2); d("a")`, undefined);
});

test.todo("MutDict: detrans gives an immutable Dict", () => {
    testCompile(`m = trans(Dict[("a", 1),]); d = detrans(m); d("a")`, 1n);
    testParseExpectError(`m = trans(Dict[("a", 1),]); d = detrans(m); put(d, "b", 2)`);
});

test.todo("MutDict: cannot use after detrans", () => {
    testParseExpectError(`m = trans(Dict[("a", 1),]); d = detrans(m); m("a")`);
    testParseExpectError(`m = trans(Dict[("a", 1),]); d = detrans(m); put(m, "b", 2)`);
    testParseExpectError(`m = trans(Dict[("a", 1),]); d = detrans(m); put(m, "b", 2)`);
});

test.todo("MutDict: unsafeTrans is a no-op", () => {
    requireIdenticalCompilation(`unsafeTrans(Dict[("a", 1),])`, `Dict[("a", 1),])`);
});

test.todo("MutDict: detrans is a no-op", () => {
    requireIdenticalCompilation(`detrans(trans(Dict[("a", 1),]))`, `trans(Dict[("a", 1),]))`);
});

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