import { test, describe } from "bun:test";
import { testCompile, testParseExpectError } from "./helpers";

// ─── Generic structs ────────────────────────────────────────────

describe("generic structs", () => {
    test("basic single type param", () => {
        testCompile(
            `
            struct Pair[T] { a: T, b: T }
            Pair(1, 2)
            `,
            { a: 1, b: 2 }
        );
    });

    test("type param inferred as Int", () => {
        testCompile(
            `
            struct Pair[T] { a: T, b: T }
            Pair(1i, 2i)
            `,
            { a: 1n, b: 2n }
        );
    });

    test("multiple type params", () => {
        testCompile(
            `
            struct Triple[T, U, V] { a: T, b: U, c: V }
            Triple(1, "hello", true)
            `,
            { a: 1, b: "hello", c: true }
        );
    });

    test("error: unused type param", () => {
        testParseExpectError(
            `
            struct Foo[T, U] {
                x: T,
                y: T,
            };
            Foo(1,1)
            `
        );
    });

    test("field access on generic struct instance", () => {
        testCompile(
            `
            struct Pair[T] { a: T, b: T }
            p = Pair(10, 20);
            p.a + p.b
            `,
            30
        );
    });

    test("generic struct in function param", () => {
        testCompile(
            `
            struct Pair[T] { a: T, b: T }
            func [T] first(p: Pair[T]): T { p.a }
            first(Pair(3, 4))
            `,
            3
        );
    });

    test("generic struct in function return type", () => {
        testCompile(
            `
            struct Pair[T] { a: T, b: T }
            func [T] makePair(x: T): Pair[T] { Pair(x, x) }
            makePair(5)
            `,
            { a: 5, b: 5 }
        );
    });

    test("concretized generic struct type in function param", () => {
        testCompile(
            `
            struct Foo[T] {
                x: T,
                y: T,
            };

            func sum(f: Foo[Num]) {
                f.x + f.y
            };

            sum(Foo(1, 1))
            `,
            2
        );
    });

    test("nested generic structs", () => {
        testCompile(
            `
            struct Pair[T] { a: T, b: T }
            outer = Pair(Pair(1, 2), Pair(3, 4));
            outer.a.a + outer.b.b
            `,
            5
        );
    });

    test("generic struct with array field", () => {
        testCompile(
            `
            struct Box[T] { items: Arr[T] }
            Box([1, 2, 3])
            `,
            { items: [1, 2, 3] }
        );
    });

    test("struct param used as field type for another generic struct", () => {
        testCompile(
            `
            struct Pair[T] { a: T, b: T }
            struct Wrapper[T] { inner: Pair[T] }
            Wrapper(Pair(1, 2))
            `,
            { inner: { a: 1, b: 2 } }
        );
    });

    test("generic struct with non-generic sibling struct", () => {
        testCompile(
            `
            struct Point { x: Num, y: Num }
            struct Pair[T] { a: T, b: T }
            (Point(1, 2), Pair(3, 4))
            `,
            [
                { x: 1, y: 2 },
                { a: 3, b: 4 },
            ]
        );
    });

    test("multiple instantiations of same generic struct", () => {
        testCompile(
            `
            struct Pair[T] { a: T, b: T }
            p1 = Pair(1, 2);
            p2 = Pair(3i, 4i);
            (p1.a + p1.b, p2.a + p2.b)
            `,
            [3, 7n]
        );
    });

    test("generic struct with struct field type", () => {
        testCompile(
            `
            struct Inner { x: Num, y: Num }
            struct Outer[T] { value: T, inner: Inner }
            Outer("hi", Inner(1, 2))
            `,
            { value: "hi", inner: { x: 1, y: 2 } }
        );
    });

    test("generic struct used in pipe", () => {
        testCompile(
            `
            struct Pair[T] { a: T, b: T }
            1..3 | map(\\x Pair(x, x * 2)) | map(\\p p.a) | collect
            `,
            [1, 2, 3]
        );
    });

    test("error: type param count mismatch on call", () => {
        testParseExpectError(
            `
            struct Pair[T, U] { a: T, b: U }
            Pair(1)
            `
        );
    });

    test("error: field type mismatch", () => {
        testParseExpectError(
            `
            struct Pair[T] { a: T, b: T }
            Pair(1, "hi")
            `
        );
    });

    test("generic struct with MutArr field", () => {
        testCompile(
            `
            struct MutContainer[T] { values: MutArr[T] }
            MutContainer([1, 2] | trans)
            `,
            { values: [1, 2] }
        );
    });

    test("generic struct with Dict field", () => {
        testCompile(
            `
            struct DictBox[T, U] { dict: Dict[T, U] }
            b = DictBox(Dict([("a", 1), ("b", 2)]));
            b.dict("a")
            `,
            1
        );
    });

    test("generic struct with MutDict field", () => {
        testCompile(
            `
            struct MDictBox[T, U] { dict: MutDict[T, U] }
            b = MDictBox(Dict([("a", 1), ("b", 2)]) | trans);
            b.dict("b")
            `,
            2
        );
    });

    test("generic struct with Set field", () => {
        testCompile(
            `
            struct SetBox[T] { items: Set[T] }
            b = SetBox(Set([1, 2, 3]));
            contains(2, b.items)
            `,
            true
        );
    });

    test("generic struct with MutSet field", () => {
        testCompile(
            `
            struct MSetBox[T] { items: MutSet[T] }
            b = MSetBox(Set([1, 2, 3]) | trans);
            contains(3, b.items)
            `,
            true
        );
    });

    test("doubly-nested generic struct", () => {
        testCompile(
            `
            struct Pair[T] { a: T, b: T }
            struct Nested[V] { inner: Pair[V] }
            Nested(Pair("hi", "there"))
            `,
            { inner: { a: "hi", b: "there" } }
        );
    });

    test("doubly-nested with MutArr", () => {
        testCompile(
            `
            struct Inner[T] { items: MutArr[T] }
            struct Outer[V] { inner: Inner[V] }
            Outer(Inner([1, 2, 3] | trans))
            `,
            { inner: { items: [1, 2, 3] } }
        );
    });

    test("generic struct with mixed MutArr and plain fields", () => {
        testCompile(
            `
            struct Mixed[T, U] { mutArr: MutArr[T], plain: U }
            Mixed([1, 2] | trans, "hello")
            `,
            { mutArr: [1, 2], plain: "hello" }
        );
    });
});
