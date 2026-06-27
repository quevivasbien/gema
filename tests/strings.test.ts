import { test } from "bun:test";
import { testCompile, testParseExpectError } from "./helpers";

// ============================================================
// String ops — length, last
// ============================================================

test("string: length", () => {
    testCompile('length("hello")', 5);
    testCompile('length("")', 0);
    testCompile('length("abc")', 3);
});

test("string: last", () => {
    testCompile('last("hello")', "o");
    testCompile('last("a")', "a");
});

test("string: last on empty string returns None", () => {
    testCompile('isnone(last(""))', true);
});

// ============================================================
// String ops — indexing
// ============================================================

test("string: index access", () => {
    testCompile('unwrap("hello"(0))', "h");
    testCompile('unwrap("hello"(1))', "e");
    testCompile('unwrap("hello"(4))', "o");
});

test("string: index out of bounds returns None", () => {
    testCompile('isnone("hello"(99))', true);
    testCompile('isnone(""(0))', true);
});

test("string: unsafe index access", () => {
    testCompile('"hello"!(0)', "h");
    testCompile('"hello"!(4)', "o");
});

test("string: cannot use Maybe result directly", () => {
    testParseExpectError('"hello"(0) + "a"');
});

// ============================================================
// String ops — slicing with ranges
// ============================================================

test("string: slice with range a..b", () => {
    testCompile('"hello"(1..3)', "ell");
    testCompile('"hello"(0..4)', "hello");
    testCompile('"hello"(0..0)', "h");
});

test("string: slice with a.. (to end)", () => {
    testCompile('"hello"(1..)', "ello");
    testCompile('"hello"(3..)', "lo");
});

test("string: slice with ..b (from start)", () => {
    testCompile('"hello"(..3)', "hell");
    testCompile('"hello"(..0)', "h");
});

test("string: slice string variable", () => {
    testCompile('x = "hello"; x(1..2)', "el");
    testCompile('x = "hello"; x(..2)', "hel");
    testCompile('x = "hello"; x(1..)', "ello");
});

// ============================================================
// String ops — contains and find
// ============================================================

test("string: contains", () => {
    testCompile('contains("hello", "ll")', true);
    testCompile('contains("hello", "xyz")', false);
    testCompile('contains("", "")', true);
});

test("string: find", () => {
    testCompile('unwrap(find("ll", "hello"))', 2);
    testCompile('isnone(find("xyz", "hello"))', true);
    testCompile('unwrap(find("h", "hello"))', 0);
});

// ============================================================
// String ops — split and replace
// ============================================================

test("string: split", () => {
    testCompile('split("a,b,c", ",")', ["a", "b", "c"]);
    testCompile('split("hello", "")', ["h", "e", "l", "l", "o"]);
    testCompile('split("abc", ",")', ["abc"]);
});

test("string: replace", () => {
    testCompile('replace("hello", "l", "z")', "hezzo");
    testCompile('replace("hello", "x", "y")', "hello");
    testCompile('replace("hello", "el", "y")', "hylo");
});

// ============================================================
// String as iterator — map, filter, collect
// ============================================================

test("string: collect characters", () => {
    testCompile('collect("abc")', ["a", "b", "c"]);
});

test("string: map over characters", () => {
    testCompile('collect(map(\\c { c }, "abc"))', ["a", "b", "c"]);
});

test("string: filter characters", () => {
    testCompile('collect(filter(\\c { c != "l" }, "hello"))', ["h", "e", "o"]);
});

test("string: pipe into iterator", () => {
    testCompile('"hello" | filter(\\c { c != "l" }) | collect', ["h", "e", "o"]);
});

// ============================================================
// String as iterator — take, drop, takeWhile, dropWhile, step
// ============================================================

test("string: take", () => {
    testCompile('collect(take(3, "hello"))', ["h", "e", "l"]);
    testCompile('collect(take(0, "hello"))', []);
    testCompile('collect(take(10, "hi"))', ["h", "i"]);
});

test("string: drop", () => {
    testCompile('collect(drop(2, "hello"))', ["l", "l", "o"]);
    testCompile('collect(drop(0, "hello"))', ["h", "e", "l", "l", "o"]);
    testCompile('collect(drop(10, "hi"))', []);
});

test("string: takeWhile", () => {
    testCompile('collect(takeWhile(\\c { c != "o" }, "hello"))', ["h", "e", "l", "l"]);
});

test("string: dropWhile", () => {
    testCompile('collect(dropWhile(\\c { c != "o" }, "hello"))', ["o"]);
});

test("string: step", () => {
    testCompile('collect(step(2, "hello"))', ["h", "l", "o"]);
    testCompile('collect(step(1, "abc"))', ["a", "b", "c"]);
});

test("string: zip", () => {
    testCompile('collect(zip("abc", "xyz"))', [
        ["a", "x"],
        ["b", "y"],
        ["c", "z"],
    ]);
});
