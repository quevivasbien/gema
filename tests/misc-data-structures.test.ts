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

test("MutDict: create mutable dict with trans", () => {
    testParse(`m = trans(Dict([("a", 1),]))`);
    testParse(`d = Dict([("a", 1),]); trans(d)`);
});

test("MutDict: create mutable dict with unsafeTrans", () => {
    testParse(`m = unsafeTrans(Dict([("a", 1),]))`);
    testParse(`d = Dict([("a", 1),]); unsafeTrans(d)`);
});

test("MutDict: add to a mutable dict", () => {
    testCompile(`m = trans(Dict([("a", 1),])); put(m, "b", 2); m("b")`, 2n);
    testCompile(`m = trans(Dict([("a", 1),])); put(m, "b", 2)("b")`, 2n);  // Put should return the MutDict itself (chainable)
});

test("MutDict: remove from a mutable dict", () => {
    testCompile(`m = trans(Dict([("a", 1),])); remove(m, "a")("a")`, undefined);  // Remove should return the MutDict
});

test("MutDict: when using trans, mutating a mutable dict does not change the original", () => {
    testCompile(`d = Dict([("a", 1),]); m = trans(d); remove(m, "a"); d("a")`, 1n);
});

test("MutDict: when using unsafeTrans, mutating a mutable dict does change the original", () => {
    testCompile(`d = Dict([("a", 1),]); m = unsafeTrans(d); remove(m, "a"); d("a")`, undefined);
});

test("MutDict: detrans gives an immutable Dict", () => {
    testCompile(`m = trans(Dict([("a", 1),])); d = detrans(m); d("a")`, 1n);
    testParseExpectError(`m = trans(Dict([("a", 1),])); d = detrans(m); put(d, "b", 2)`);
});

test("MutDict: cannot use put/remove after detrans", () => {
    // Detrans still allows reading via indexing; only mutation ops are blocked
    testCompile(`m = trans(Dict([("a", 1),])); d = detrans(m); m("a")`, 1n);
    testParseExpectError(`m = trans(Dict([("a", 1),])); d = detrans(m); put(m, "b", 2)`);
    testParseExpectError(`m = trans(Dict([("a", 1),])); d = detrans(m); remove(m, "a")`);
});

test("MutDict: unsafeTrans is a no-op", () => {
    requireIdenticalCompilation(`unsafeTrans(Dict([("a", 1),]))`, `Dict([("a", 1),])`);
});

test("MutDict: detrans is a no-op", () => {
    requireIdenticalCompilation(`detrans(trans(Dict([("a", 1),])))`, `trans(Dict([("a", 1),]))`);
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

test.todo("MutSet: create mutable set with trans", () => {
    testParse(`m = trans(Set([1, 2]))`);
    testParse(`d = Set([1, 2]); trans(d)`);
});

test.todo("MutSet: create mutable set with unsafeTrans", () => {
    testParse(`m = unsafeTrans(Set([1, 2]))`);
    testParse(`d = Set([1, 2]); unsafeTrans(d)`);
});

test.todo("MutSet: add to a mutable set", () => {
    testCompile(`m = trans(Set([1, 2])); push(m, 3); contains(m, 3)`, true);
    testCompile(`m = trans(Set([1, 2])); contains(push(m, 3), 2)`, true);  // Push should evaluate to the new value of the MutSet
});

test.todo("MutSet: remove from a mutable set", () => {
    testCompile(`m = trans(Set([1, 2])); contains(remove(m, 2), `, undefined);  // Remove should return the MutSet
});

test.todo("MutSet: when using trans, mutating a mutable set does not change the original", () => {
    testCompile(`s = Set([1, 2]); m = trans(s); remove(m, 2); contains(s, 2)`, true);
});

test.todo("MutSet: when using unsafeTrans, mutating a mutable set does change the original", () => {
    testCompile(`s = Set([1, 2]); m = unsafeTrans(s); remove(m, 2); contains(d, 2)`, false);
});

test.todo("MutSet: detrans gives an immutable Set", () => {
    testCompile(`m = trans(Set([1, 2])); s = detrans(m); contains(s, 2)`, true);
    testParseExpectError(`m = trans(Set([1, 2])); s = detrans(m); push(s, 2)`);
});

test.todo("MutSet: cannot use after detrans", () => {
    testParseExpectError(`m = trans(Set([1, 2])); s = detrans(m); contains(m, 2)`);
    testParseExpectError(`m = trans(Set([1, 2])); s = detrans(m); push(m, 2)`);
    testParseExpectError(`m = trans(Set([1, 2])); s = detrans(m); push(m, 2)`);
});

test.todo("MutSet: unsafeTrans is a no-op", () => {
    requireIdenticalCompilation(`unsafeTrans(Set([1, 2]))`, `Set([1, 2]))`);
});

test.todo("MutSet: detrans is a no-op", () => {
    requireIdenticalCompilation(`detrans(trans(Set([1, 2])))`, `trans(Set([1, 2])))`);
});
