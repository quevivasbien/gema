import { test, describe } from "bun:test";
import { testCompile, testParseExpectError } from "./helpers";

// ─── Generic enums ─────────────────────────────────────────────

describe("generic enums", () => {
    test("basic single type param — explicit annotation", () => {
        testCompile(
            `
            enum Option[T] { some: T, nothing }
            Option[Int]::some(1i)
            `,
            { $tag: 0, $val: 1n }
        );
    });

    test("multi type param — explicit annotation", () => {
        testCompile(
            `
            enum Result[T, E] { value: T, error: E }
            Result[Int, Str]::value(1i)
            `,
            { $tag: 0, $val: 1n }
        );
    });

    test("match on generic enum variant with value", () => {
        testCompile(
            `
            enum Option[T] { some: T, nothing }
            x = Option[Str]::some("hello");
            match x {
                some(v) { v },
                nothing { "empty" }
            }
            `,
            "hello"
        );
    });

    test("match on generic enum plain variant", () => {
        testCompile(
            `
            enum Option[T] { some: T, nothing }
            x = Option[Int]::nothing;
            match x {
                some(v) { v },
                nothing { 0i }
            }
            `,
            0n
        );
    });

    test("generic enum passed to concrete function", () => {
        testCompile(
            `
            enum Option[T] { some: T, nothing }
            func getStr(opt: Option[Str]): Str {
                match opt {
                    some(v) { v },
                    nothing { "empty" }
                }
            }
            getStr(Option[Str]::some("hi"))
            `,
            "hi"
        );
    });

    test("generic enum with two variants having different types", () => {
        testCompile(
            `
            enum Result[T, E] { value: T, error: E }
            r = Result[Int, Str]::value(42i);
            match r {
                value(v) { v + 1i },
                error(_) { 0i }
            }
            `,
            43n
        );
    });

    test("generic enum error variant — matching with destructure", () => {
        testCompile(
            `
            enum Result[T, E] { value: T, error: E }
            r = Result[Int, Str]::error("oops");
            match r {
                value(_) { "got value" },
                error(e) { e }
            }
            `,
            "oops"
        );
    });

    test("non-generic enum unchanged", () => {
        testCompile(
            `
            enum Color { red: Int, blue: Int }
            Color::red(1i)
            `,
            { $tag: 0, $val: 1n }
        );
    });

    test("multiple instantiations of same generic enum", () => {
        testCompile(
            `
            enum Option[T] { some: T, nothing }
            a = Option[Int]::some(1i);
            b = Option[Str]::some("hi");
            (match a { some(v) { v }, nothing { 0i } },
             match b { some(v) { v }, nothing { "" } })
            `,
            [1n, "hi"]
        );
    });

    test("use function on generic enum with a builtin operation", () => {
        testCompile(
            `
            enum Foo[T] {
                x: T,
                y: Num,
                z
            };

            func [T] y_or_zero(f: Foo[T]) {
                match f {
                    x 0,
                    y(value) value,
                    z 0,
                }
            };

            map(
                y_or_zero[Foo[Str]],
                [
                    Foo[Str]::x("Hello"),
                    Foo[Str]::y(1),
                    Foo[Str]::z,
                ]
            ) | collect
            `,
            [0, 1, 0]
        );
    });

    test("error: wrong number of type params", () => {
        testParseExpectError(
            `
            enum Result[T, E] { value: T, error: E }
            Result[Int]::value(1i)
            `
        );
    });

    test("error: accessing non-existent variant on generic enum", () => {
        testParseExpectError(
            `
            enum Option[T] { some: T, nothing }
            Option[Int]::missing
            `
        );
    });
});
