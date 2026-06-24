import { test, expect, beforeAll } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { compile } from "../src/compiler";
import { resetRegistries } from "../src/ast/index";

const TMP_DIR = join(import.meta.dir, "..", ".rust_test_tmp");

/**
 * Compile a Gema program to Rust, compile it with rustc, run it,
 * and verify the stdout output matches `expectedOutput`.
 */
function testRustCompile(gemaSource: string, expectedOutput: string) {
    resetRegistries();
    const result = compile(gemaSource, "rust", "export");
    if (result.errors.length > 0) {
        throw new Error(
            "Compile errors:\n" +
                result.errors
                    .map(
                        (e: { line: number; col: number; message: string }) =>
                            `${e.line}:${e.col} ${e.message}`
                    )
                    .join("\n")
        );
    }

    // Write the Rust source to a temp file
    const rsPath = join(TMP_DIR, `test_${Bun.hash(gemaSource)}.rs`);
    const binPath = rsPath.replace(/\.rs$/, "");
    writeFileSync(rsPath, result.js);

    // Compile with rustc
    try {
        execSync(`rustc "${rsPath}" -o "${binPath}" 2>&1`, {
            stdio: "pipe",
            timeout: 30000,
        });
    } catch (e: unknown) {
        const stderr =
            e instanceof Error && "stderr" in e
                ? String((e as Record<string, unknown>).stderr ?? "")
                : "";
        const err = new Error(`rustc compilation failed:\n${stderr}`);
        if (e instanceof Error) err.cause = e;
        throw err;
    }

    // Run the binary
    try {
        const stdout = execSync(`"${binPath}"`, {
            stdio: "pipe",
            timeout: 5000,
            encoding: "utf-8",
        });
        const actual = stdout.trim();
        expect(actual).toBe(expectedOutput);
    } catch (e: unknown) {
        const stderr =
            e instanceof Error && "stderr" in e
                ? String((e as Record<string, unknown>).stderr ?? "")
                : "";
        const sout =
            e instanceof Error && "stdout" in e
                ? String((e as Record<string, unknown>).stdout ?? "")
                : "";
        const err = new Error(`Runtime error:\n${stderr}\n${sout}`);
        if (e instanceof Error) err.cause = e;
        throw err;
    }
}

beforeAll(() => {
    if (!existsSync(TMP_DIR)) {
        mkdirSync(TMP_DIR, { recursive: true });
    }
});

// ── Literals ──

test("rust: integer literal", () => {
    testRustCompile("42", "42");
});

test("rust: float literal", () => {
    testRustCompile("3.14", "3.14");
});

test("rust: bool literal", () => {
    testRustCompile("true", "true");
    testRustCompile("false", "false");
});

test("rust: string literal", () => {
    testRustCompile('"hello"', "hello");
});

// ── Binary operations ──

test("rust: integer arithmetic", () => {
    testRustCompile("1 + 2", "3");
    testRustCompile("10 - 4", "6");
    testRustCompile("3 * 7", "21");
    testRustCompile("10 / 3", "3"); // Integer division
    testRustCompile("10 % 3", "1"); // Mathematical mod
});

test("rust: float arithmetic", () => {
    testRustCompile("1.5 + 2.5", "4");
    testRustCompile("10.0 / 3.0", "3.3333333333333335");
});

test("rust: comparisons", () => {
    testRustCompile("1 == 1", "true");
    testRustCompile("1 == 2", "false");
    testRustCompile("1 != 2", "true");
    testRustCompile("3 > 2", "true");
    testRustCompile("2 >= 2", "true");
    testRustCompile("1 < 2", "true");
    testRustCompile("2 <= 1", "false");
});

test("rust: boolean logic", () => {
    testRustCompile("true and false", "false");
    testRustCompile("true or false", "true");
});

test("rust: exponentiation", () => {
    testRustCompile("2 ^ 3", "8");
    testRustCompile("2 ^ 10", "1024");
});

// ── Variables and blocks ──

test("rust: variable assignment", () => {
    testRustCompile("x = 5; x + 3", "8");
});

test("rust: multiple variables", () => {
    testRustCompile("x = 10; y = 20; x + y", "30");
});

test("rust: block expression", () => {
    testRustCompile("{ 1 }", "1");
    testRustCompile("{ 1 + 2 }", "3");
});

// ── If/else ──

test("rust: if else", () => {
    testRustCompile("if true { 42 } else { 0 }", "42");
    testRustCompile("if false { 42 } else { 0 }", "0");
});

test("rust: if with comparison", () => {
    testRustCompile("x = 10; if x > 5 { 1 } else { 0 }", "1");
});

// ── Functions ──

test("rust: simple function", () => {
    testRustCompile(
        `
        func five(): Int { 5 };
        five()
        `,
        "5"
    );
});

test("rust: function with parameters", () => {
    testRustCompile(
        `
        func add(a: Int, b: Int): Int { a + b };
        add(10, 20)
        `,
        "30"
    );
});

test("rust: recursive function", () => {
    testRustCompile(
        `
        func factorial(n: Int): Int {
            if n <= 1 {
                1
            } else {
                n * factorial(n - 1)
            }
        };
        factorial(5)
        `,
        "120"
    );
});

// ── Strings ──

test("rust: string concatenation", () => {
    testRustCompile('"hello" + " " + "world"', "hello world");
});

test("rust: string comparison", () => {
    testRustCompile('"abc" == "abc"', "true");
    testRustCompile('"abc" == "xyz"', "false");
});

// ── Arrays ──

test("rust: array literal", () => {
    testRustCompile("[1, 2, 3]", "[1, 2, 3]");
});

// ── Type conversions ──

test("rust: toStr builtin", () => {
    testRustCompile("toStr(42)", "42");
});

test("rust: toInt builtin", () => {
    testRustCompile("toInt(3.14)", "3");
});

test("rust: toFloat builtin", () => {
    testRustCompile("toFloat(3)", "3");
});
