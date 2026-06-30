import { test } from "bun:test";

import {
    testParse,
    testCompile,
    requireIdenticalCompilation,
    testParseExpectError,
} from "./helpers";

// ============================================================
// Dict
// ============================================================

test("Dict: basic", () => {
    testParse(`Dict([("a", 1), ("b", 2)])`);
});

test("Dict: create empty Dict", () => {
    testParse(`Dict([]:Tup[Int, Int])`);
    testCompile(`d = Dict([]:Tup[Int, Int]); d(1)`, null);
});

test("Dict: compile and access with numeric key", () => {
    testCompile(`m = Dict([(1, 1), (2, 2)]); m(1)`, 1);
    testCompile(`m = Dict([(1, 1), (2, 2)]); m(2)`, 2);
    testCompile(`m = Dict([(1., 1.), (2., 2.)]); m(2.)`, 2.0);
});

test("Dict: compile and access with non-numeric key", () => {
    testCompile(`m = Dict([("a", 1), ("b", 2)]); m("a")`, 1);
    testCompile(`m = Dict([("a", 1), ("b", 2)]); m("b")`, 2);
    testCompile(`arr = [1, 2]; m = Dict([(arr, 1),]); m(arr)`, 1);
    testCompile(`struct S {}; s = S(); m = Dict([(s, 1),]); m(s)`, 1);
});

test("Dict: access missing key", () => {
    testCompile(`m = Dict([("a", 1)]); m("x")`, null);
    testCompile(`m = Dict([([1,2], 1),]); m([1,2])`, null); // This should be null, since [1,2] is not actually the same object as the array that was used in the map
});

test("Dict: contains", () => {
    testCompile("m = Dict([(1,1)]); contains(1, m)", true);
    testCompile("m = Dict([(1,1)]); contains(2, m)", false);
    testCompile('m = Dict([("a",1)]); contains("a", m)', true);
    testParseExpectError('m = Dict([("a",1)]); contains(1, m)');
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
    testCompile(`m = trans(Dict([("a", 1),])); put(2, "b", m); m("b")`, 2);
    testCompile(`m = trans(Dict([("a", 1),])); put(2, "b", m)("b")`, 2); // Put should return the MutDict itself (chainable)
});

test("MutDict: remove from a mutable dict", () => {
    testCompile(`m = trans(Dict([("a", 1),])); remove("a", m); m("a")`, null);
    testCompile(`m = trans(Dict([("a", 1),])); remove("a", m)("a")`, null); // Remove should return the MutDict
});

test("MutDict: when using trans, mutating a mutable dict does not change the original", () => {
    testCompile(`d = Dict([("a", 1),]); m = trans(d); remove("a", m); d("a")`, 1);
});

test("MutDict: when using unsafeTrans, mutating a mutable dict does change the original", () => {
    testCompile(`d = Dict([("a", 1),]); m = unsafeTrans(d); remove("a", m); d("a")`, null);
});

test("MutDict: detrans gives an immutable Dict", () => {
    testCompile(`m = trans(Dict([("a", 1),])); d = detrans(m); d("a")`, 1);
    testParseExpectError(`m = trans(Dict([("a", 1),])); d = detrans(m); put(2, "b", d)`);
});

test("MutDict: cannot use after detrans", () => {
    testParseExpectError(`m = trans(Dict([("a", 1),])); d = detrans(m); put(2, "b", m)`);
    testParseExpectError(`m = trans(Dict([("a", 1),])); d = detrans(m); remove("a", m)`);
    testParseExpectError(`m = trans(Dict([("a", 1),])); d = detrans(m); m("a")`); // Not even non-mutating operations are allowed
    testParseExpectError(`m = trans(Dict([("a", 1),])); d = detrans(m); m2 = m;`);
    testParseExpectError(`m = trans(Dict([("a", 1),])); d = detrans(m); m`); // Cannot even reference the variable
});

test("MutDict: unsafeTrans is a no-op", () => {
    requireIdenticalCompilation(`unsafeTrans(Dict([("a", 1),]))`, `Dict([("a", 1),])`);
});

test("MutDict: detrans is a no-op", () => {
    requireIdenticalCompilation(`detrans(trans(Dict([("a", 1),])))`, `trans(Dict([("a", 1),]))`);
});

test("MutDict: contains", () => {
    testCompile("m = Dict([(1,1)]) | trans; contains(1, m)", true);
    testCompile("m = Dict([(1,1)]) | trans; contains(2. m)", false);
    testCompile('m = Dict([("a",1)]) | trans; contains("a", m)', true);
    testParseExpectError('m = Dict([("a",1)]) | trans; contains(1, m)');
});

// ============================================================
// Set
// ============================================================

test("Set: basic", () => {
    testParse("Set([1, 2, 3])");
});

test("Set: compile", () => {
    testCompile("s = Set([1, 2, 3]); s", new Set([1, 2, 3]));
});

test("Set: contains", () => {
    testCompile("s = Set([1, 2, 3]); contains(1, s)", true);
    testCompile("s = Set([1, 2, 3]); contains(4, s)", false);
});

test("Set: union", () => {
    testCompile("a = Set([1, 2]); b = Set([2, 3]); union(a, b)", new Set([1, 2, 3]));
});

test("Set: intersect", () => {
    testCompile("a = Set([1, 2, 3]); b = Set([2, 3, 4]); intersect(a, b)", new Set([2, 3]));
});

test("MutSet: create mutable set with trans", () => {
    testParse(`m = trans(Set([1, 2]))`);
    testParse(`s = Set([1, 2]); trans(s)`);
});

test("MutSet: create mutable set with unsafeTrans", () => {
    testParse(`m = unsafeTrans(Set([1, 2]))`);
    testParse(`s = Set([1, 2]); unsafeTrans(s)`);
});

test("MutSet: add to a mutable set", () => {
    testCompile(`m = trans(Set([1, 2])); push(3, m); contains(3, m)`, true);
    testCompile(`m = trans(Set([1, 2])); contains(2, push(3, m))`, true); // Push should return the MutSet itself (chainable)
    testCompile(`m = trans(Set([1, 2])); m | push(3) | contains(3)`, true); // Push should return the MutSet itself (chainable)
});

test("MutSet: remove from a mutable set", () => {
    testCompile(`m = trans(Set([1, 2])); remove(2, m); contains(2, m)`, false);
    testCompile(`m = trans(Set([1, 2])); contains(2, remove(2, m))`, false); // Remove should return the MutSet
});

test("MutSet: when using trans, mutating a mutable set does not change the original", () => {
    testCompile(`s = Set([1, 2]); m = trans(s); remove(2, m); contains(2, s)`, true);
});

test("MutSet: when using unsafeTrans, mutating a mutable set does change the original", () => {
    testCompile(`s = Set([1, 2]); m = unsafeTrans(s); remove(2, m); contains(2, s)`, false);
});

test("MutSet: detrans gives an immutable Set", () => {
    testCompile(`m = trans(Set([1, 2])); s = detrans(m); contains(2, s)`, true);
    testParseExpectError(`m = trans(Set([1, 2])); s = detrans(m); push(2, s)`);
});

test("MutSet: cannot use after detrans", () => {
    testParseExpectError(`m = trans(Set([1, 2])); s = detrans(m); push(2, m)`);
    testParseExpectError(`m = trans(Set([1, 2])); s = detrans(m); remove(2, m)`);
    testParseExpectError(`m = trans(Set([1, 2])); s = detrans(m); contains(2, m)`); // Not even non-mutating operations are allowed
    testParseExpectError(`m = trans(Set([1, 2])); s = detrans(m); m2 = m;`);
    testParseExpectError(`m = trans(Set([1, 2])); s = detrans(m); m`); // Cannot even reference the variable
});

test("MutSet: unsafeTrans is a no-op", () => {
    requireIdenticalCompilation(`unsafeTrans(Set([1, 2]))`, `Set([1, 2])`);
});

test("MutSet: detrans is a no-op", () => {
    requireIdenticalCompilation(`detrans(trans(Set([1, 2])))`, `trans(Set([1, 2]))`);
});

// ── Monomorphization with different Dict/Set types ──────
// Note: these tests verify that typeToName correctly distinguishes types.
// If they fail with "function foo[...] not found", the monomorphization
// cache is likely creating colliding function signatures.

test("Dict: monomorphization with different value types", () => {
    testCompile(
        `
        func foo(d: Dict[Str, Int]) { contains("a", d) }
        func foo(d: Dict[Str, Str]) { contains("a", d) }
        foo(Dict([]:Tup[Str, Int]))
        `,
        false
    );
});

test("Set: monomorphization with different inner types", () => {
    testCompile(
        `
        func foo(s: Set[Num]) { contains(1, s) }
        func foo(s: Set[Str]) { contains("a", s) }
        (foo(Set([]:Num)), foo(Set(["a"])))
        `,
        [false, true]
    );
});
