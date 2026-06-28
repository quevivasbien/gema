import { expect, test, describe } from "bun:test";
import { compile } from "../src/compiler";
import { testCompileMultiExpectError } from "./helpers";

// ─── Helpers ──────────────────────────────────────────────────

/**
 * Compile a multi-module program that may include JS imports,
 * and verify the generated JS contains the expected import statements.
 * Does NOT run the code (since ESM imports can't be evaled).
 * Returns the compiled JS string.
 */
function testJSCompile(
    files: Record<string, string>,
    entry: string,
    expectedImports: string[]
): string {
    const result = compile(files, "immediate", entry);
    if (result.errors.length > 0) {
        throw new Error(
            "Compile errors:\n" +
                result.errors
                    .map((e) => {
                        const tag = e.filename ? `${e.filename}:` : "";
                        return `${tag}${e.line}:${e.col} ${e.message}`;
                    })
                    .join("\n")
        );
    }
    for (const imp of expectedImports) {
        expect(result.js).toInclude(imp);
    }
    return result.js;
}

/**
 * Run a full JS-interop test end-to-end:
 * 1. Write the JS module file(s) to a temp directory
 * 2. Compile the gema entry file (importing from the temp JS module)
 * 3. Write the compiled JS to a temp .mjs file
 * 4. Dynamically import it and check the result
 */
async function testJSInteropRuntime(
    jsModules: Record<string, string>,
    gemaModules: Record<string, string>,
    entry: string,
    expectEqual: unknown
): Promise<string> {
    const fs = await import("fs");
    const path = await import("path");

    // Create a temp directory
    const tmpDir = fs.mkdtempSync("/tmp/gema-js-test-");

    try {
        // Write JS module files
        const jsPaths: Record<string, string> = {};
        for (const [filename, source] of Object.entries(jsModules)) {
            const fullPath = path.join(tmpDir, filename);
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, source, "utf-8");
            jsPaths[filename] = fullPath;
        }

        // Build the files map — replace placeholder paths with real temp paths
        // The gema source uses paths like "./math.js" and we need them relative to the temp dir
        const files: Record<string, string> = {};
        for (const [filename, source] of Object.entries(gemaModules)) {
            files[filename] = source;
        }

        // Compile in 'export' mode so we can import the result
        const result = compile(files, "export", entry);
        if (result.errors.length > 0) {
            throw new Error(
                "Compile errors:\n" +
                    result.errors
                        .map((e) => {
                            const tag = e.filename ? `${e.filename}:` : "";
                            return `${tag}${e.line}:${e.col} ${e.message}`;
                        })
                        .join("\n")
            );
        }

        // Write the compiled JS to a temp file
        const compiledPath = path.join(tmpDir, "compiled.mjs");
        fs.writeFileSync(compiledPath, result.js, "utf-8");

        // Dynamically import and check the result
        const mod = await import(compiledPath);
        if (expectEqual !== null) {
            expect(mod.main()).toEqual(expectEqual);
        }

        return result.js;
    } finally {
        // Clean up temp directory
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

// ─── Parse / Codegen tests ────────────────────────────────────

describe("JS interop — compilation", () => {
    test("basic: import function from JS module", () => {
        const js = testJSCompile(
            {
                "main.gema": `
                    use (add: Func[Num, Num: Num]) from "math.js"
                    add(3, 4)
                `,
            },
            "main.gema",
            [`import { add } from "./math.js"`]
        );
        // The call to add(3, 4) should remain as a normal function call
        expect(js).toInclude("add(3");
    });

    test("basic: import constant from JS module", () => {
        const _js = testJSCompile(
            {
                "main.gema": `
                    use (PI: Num) from "math.js"
                    PI
                `,
            },
            "main.gema",
            [`import { PI } from "./math.js"`]
        );
    });

    test("basic: multiple imports from same module", () => {
        const _js = testJSCompile(
            {
                "main.gema": `
                    use (
                        add: Func[Num, Num: Num],
                        PI: Num,
                    ) from "math.js"
                    add(1, 2)
                `,
            },
            "main.gema",
            [`import { add, PI } from "./math.js"`]
        );
    });

    test("basic: import with complex function type", () => {
        const _js = testJSCompile(
            {
                "main.gema": `
                    use (map: Func[Func[Num: Num], Iter[Num]: Iter[Num]]) from "utils.js"
                    map
                `,
            },
            "main.gema",
            [`import { map } from "./utils.js"`]
        );
    });

    // Imports from other directories not needed as part of the MVP implementation
    test.todo("basic: import from relative path", () => {
        const _js = testJSCompile(
            {
                "main.gema": `
                    use (helper: Func[Num: Num]) from "./lib/helpers.js"
                    helper(1.0)
                `,
            },
            "main.gema",
            [`import { helper } from "./lib/helpers.js"`]
        );
    });

    test("basic: JS import used in gema function", () => {
        const js = testJSCompile(
            {
                "main.gema": `
                    use (double: Func[Num: Num]) from "math.js"
                    func process(x: Num) { double(x) + 1 }
                    process(5.0)
                `,
            },
            "main.gema",
            [`import { double } from "./math.js"`]
        );
        expect(js).toInclude("double(");
        expect(js).toInclude("process");
    });

    test("basic: multiple JS imports from different modules", () => {
        const _js = testJSCompile(
            {
                "main.gema": `
                    use (add: Func[Num, Num: Num]) from "math.js"
                    use (log: Func[Str: Str]) from "io.js"
                    (add(1, 2), log("Hello"))
                `,
            },
            "main.gema",
            [`import { add } from "./math.js"`, `import { log } from "./io.js"`]
        );
    });

    test("basic: JS import used with gema pipe operator", () => {
        const _js = testJSCompile(
            {
                "main.gema": `
                    use (double: Func[Num: Num]) from "math.js"
                    1..3 | map(\\x double(x)) | collect
                `,
            },
            "main.gema",
            [`import { double } from "./math.js"`]
        );
    });

    test("basic: JS import with user-defined type", () => {
        const _js = testJSCompile(
            {
                "main.gema": `
                    struct Point { x: Num, y: Num };
                    use (abs: Func[Point: Num]) from "points.js"
                    Point(2, 0) | abs
                `,
            },
            "main.gema",
            [`import { abs } from "./points.js"`]
        );
    });
});

// ─── Error tests ──────────────────────────────────────────────

describe("JS interop — compile errors", () => {
    test("error: missing type annotation on JS import", () => {
        testCompileMultiExpectError(
            {
                "main.gema": `
                    use (foo) from "module.js"
                    1
                `,
            },
            "main.gema",
            "Type annotations"
        );
    });

    test("error: bare import from JS module (no parens, no symbols)", () => {
        testCompileMultiExpectError(
            {
                "main.gema": `
                    use "module.js"
                    1
                `,
            },
            "main.gema",
            "module"
        );
    });

    test("error: partial type annotation on JS import", () => {
        testCompileMultiExpectError(
            {
                "main.gema": `
                    use (foo:) from "module.js"
                    1
                `,
            },
            "main.gema",
            "type annotation"
        );
    });

    test.todo("error: unsupported type in JS import", () => {
        testCompileMultiExpectError(
            {
                "main.gema": `
                    use (unknown: FooBar) from "module.js"
                    1
                `,
            },
            "main.gema",
            "FooBar"
        );
    });

    test("error: .gema module still requires file in files map", () => {
        testCompileMultiExpectError(
            {
                "main.gema": `
                    use "nonexistent.gema"
                    1
                `,
            },
            "main.gema",
            "not found"
        );
    });

    test("error: empty parens import from JS module", () => {
        testCompileMultiExpectError(
            {
                "main.gema": `
                    use () from "side-effect.js"
                    1
                `,
            },
            "main.gema",
            "at least one symbol"
        );
    });
});

// ─── Runtime tests ────────────────────────────────────────────

describe("JS interop — runtime", () => {
    test("runtime: call JS function from module", async () => {
        await testJSInteropRuntime(
            {
                "math.js": `export function add(x, y) { return x + y; }`,
            },
            {
                "main.gema": `
                    use (add: Func[Int, Int: Int]) from "math.js"
                    add(3i, 4i)
                `,
            },
            "main.gema",
            7n
        );
    });

    test("runtime: use JS constant", async () => {
        await testJSInteropRuntime(
            {
                "config.js": `export const PI = 3.14159;`,
            },
            {
                "main.gema": `
                    use (PI: Num) from "config.js"
                    PI
                `,
            },
            "main.gema",
            3.14159
        );
    });

    test("runtime: multiple imports from same JS module", async () => {
        await testJSInteropRuntime(
            {
                "math.js": `
                    export function add(x, y) { return x + y; }
                    export function sub(x, y) { return x - y; }
                `,
            },
            {
                "main.gema": `
                    use (add: Func[Num, Num: Num], sub: Func[Num, Num: Num]) from "math.js"
                    add(sub(10, 3), 2)
                `,
            },
            "main.gema",
            9
        );
    });

    test("runtime: JS function used inside gema function", async () => {
        await testJSInteropRuntime(
            {
                "math.js": `export function double(x) { return x * 2; }`,
            },
            {
                "main.gema": `
                    use (double: Func[Num: Num]) from "math.js"
                    func process(x: Num) { double(x) + 1 }
                    process(5.0)
                `,
            },
            "main.gema",
            11.0
        );
    });

    test("runtime: JS import with gema iterators", async () => {
        await testJSInteropRuntime(
            {
                "math.js": `export function double(x) { return x * 2; }`,
            },
            {
                "main.gema": `
                    use (double: Func[Num: Num]) from "math.js"
                    1..3 | map(\\x double(x)) | collect
                `,
            },
            "main.gema",
            [2, 4, 6]
        );
    });

    // Imports from other directories not needed as part of the MVP implementation
    test.todo("runtime: importing from subdirectory", async () => {
        await testJSInteropRuntime(
            {
                "lib/utils.js": `export function greet(name) { return "Hello, " + name; }`,
            },
            {
                "main.gema": `
                    use (greet: Func[Str: Str]) from "./lib/utils.js"
                    greet("world")
                `,
            },
            "main.gema",
            "Hello, world"
        );
    });

    test("runtime: JS import used with gema's builtin map", async () => {
        await testJSInteropRuntime(
            {
                "str.js": `export function exclaim(s) { return s + "!"; }`,
            },
            {
                "main.gema": `
                    use (exclaim: Func[Str: Str]) from "str.js"
                    ["hello", "world"] | map(\\x exclaim(x)) | collect
                `,
            },
            "main.gema",
            ["hello!", "world!"]
        );
    });
});
