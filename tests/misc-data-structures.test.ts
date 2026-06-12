import { test } from "bun:test";

import { testParse, testCompile } from "./helpers";

// ============================================================
// HashMap
// ============================================================

test.todo("hashMap basic", () => {
    testParse(`hashMap([("a", 1), ("b", 2)])`);
});

test.todo("hashMap compile and access", () => {
    testCompile(`m = hashMap([("a", 1), ("b", 2)]); m("a")`, 1n);
    testCompile(`m = hashMap([("a", 1), ("b", 2)]); m("b")`, 2n);
});

test.todo("hashMap access missing key", () => {
    testCompile(`m = hashMap([("a", 1)]); m("x")`, undefined);
});

// ============================================================
// HashSet
// ============================================================

test.todo("hashSet basic", () => {
    testParse("hashSet([1, 2, 3])");
});

test.todo("hashSet compile", () => {
    testCompile("s = hashSet([1, 2, 3]); s", [1, 2, 3]);
});

test.todo("contains with hashSet", () => {
    testCompile("s = hashSet([1, 2, 3]); contains(s, 1)", true);
    testCompile("s = hashSet([1, 2, 3]); contains(s, 4)", false);
});

test.todo("union of hashSets", () => {
    testCompile("a = hashSet([1, 2]); b = hashSet([2, 3]); union(a, b)", [1, 2, 3]);
});

test.todo("intersect of hashSets", () => {
    testCompile("a = hashSet([1, 2, 3]); b = hashSet([2, 3, 4]); intersect(a, b)", [2, 3]);
});
