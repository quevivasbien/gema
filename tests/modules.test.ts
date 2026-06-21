import { expect, test } from "bun:test";
import { testCompileMulti, testCompileMultiExpectError } from "./helpers";

test("basic: function from module", () => {
    testCompileMulti(
        {
            "math.gema": `func add(x: Int, y: Int) { x + y }`,
            "main.gema": `use "math.gema"\nadd(3, 4)`,
        },
        "main.gema",
        7n
    );
});

test("basic: struct from module", () => {
    testCompileMulti(
        {
            "structs.gema": `struct Point { x: Int, y: Int }`,
            "main.gema": `use "structs.gema"\nPoint(3, 4)`,
        },
        "main.gema",
        { x: 3n, y: 4n }
    );
});

test("basic: variable from module", () => {
    testCompileMulti(
        {
            "config.gema": `pi = 3`,
            "main.gema": `use "config.gema"\npi`,
        },
        "main.gema",
        3n
    );
});

test("chain: module A imports module B", () => {
    testCompileMulti(
        {
            "helpers.gema": `func double(x: Int) { x * 2 }`,
            "math.gema": `use "helpers.gema"\nfunc addDouble(x: Int, y: Int) { x + double(y) }`,
            "main.gema": `use "math.gema"\naddDouble(3, 4)`,
        },
        "main.gema",
        11n
    );
});

test("missing module: compile error", () => {
    testCompileMultiExpectError(
        {
            "main.gema": `use "nonexistent.gema"\n1`,
        },
        "main.gema",
        "not found"
    );
});

test("circular dependency: compile error", () => {
    testCompileMultiExpectError(
        {
            "a.gema": `use "b.gema"\nfunc a() { 1 }`,
            "b.gema": `use "a.gema"\nfunc b() { 2 }`,
            "main.gema": `use "a.gema"\na()`,
        },
        "main.gema",
        "Circular dependency"
    );
});

test("self-use: module that uses itself is an error", () => {
    testCompileMultiExpectError(
        {
            "main.gema": `use "main.gema"\n1`,
        },
        "main.gema",
        "Circular dependency"
    );
});

test("multiple modules: three independent modules", () => {
    testCompileMulti(
        {
            "a.gema": `func a() { 1 }`,
            "b.gema": `func b() { 2 }`,
            "c.gema": `use "a.gema"\nuse "b.gema"\nfunc c() { a() + b() }`,
            "main.gema": `use "c.gema"\nc()`,
        },
        "main.gema",
        3n
    );
});

test("struct + func from same module", () => {
    testCompileMulti(
        {
            "calc.gema": `struct Pair { x: Int, y: Int }
func makePair(v: Int) { Pair(v, v * 2) }`,
            "main.gema": `use "calc.gema"\nmakePair(5)`,
        },
        "main.gema",
        { x: 5n, y: 10n }
    );
});

test("trait from module", () => {
    testCompileMulti(
        {
            "traits.gema": `trait Doublable { double[(self: Self): Int], }
struct S { v: Int }
func double(s: S): Int { s.v * 2 }`,
            "main.gema": `use "traits.gema"\ndouble(S(3))`,
        },
        "main.gema",
        6n
    );
});

test("module with iterator: use in pipeline", () => {
    testCompileMulti(
        {
            "utils.gema": `func square(x: Int) { x * x }`,
            "main.gema": `use "utils.gema"\n1..3 | map(\\x square(x)) | collect`,
        },
        "main.gema",
        [1n, 4n, 9n]
    );
});

test("parse multi-file source: #--- markers", () => {
    const source = `#--- math.gema ---
func add(x: Int, y: Int) { x + y }
#--- main.gema ---
use "math.gema"
add(3, 4)`;

    // Split the source by #--- markers
    const files = parseMultiFileSource(source);
    expect(files).toEqual({
        "math.gema": "func add(x: Int, y: Int) { x + y }",
        "main.gema": 'use "math.gema"\nadd(3, 4)',
    });
});

test("parse multi-file source: no markers falls back to single file", () => {
    const source = `1 + 2`;
    const files = parseMultiFileSource(source);
    expect(files).toEqual({ "main.gema": "1 + 2" });
});

test("parse multi-file source: windows-style line endings", () => {
    const source =
        '#--- math.gema ---\r\nfunc add(x: Int, y: Int) { x + y }\r\n#--- main.gema ---\r\nuse "math.gema"\r\nadd(3, 4)';
    const files = parseMultiFileSource(source);
    expect(files).toEqual({
        "math.gema": "func add(x: Int, y: Int) { x + y }",
        "main.gema": 'use "math.gema"\nadd(3, 4)',
    });
});

// ── Module builtin integration tests ────────────────────────────

test("module: function uses reduce builtin", () => {
    testCompileMulti(
        {
            "math.gema": `func sum(xs: Iter[Int]): Int {
    reduce(\\(acc, x) { acc + x }, 0, xs)
}`,
            "main.gema": `use "math.gema"\nsum(1..3)`,
        },
        "main.gema",
        6n
    );
});

test("module: function uses collect builtin", () => {
    testCompileMulti(
        {
            "utils.gema": `func toArray(xs: Iter[Int]): Arr[Int] { collect(xs) }`,
            "main.gema": `use "utils.gema"\ntoArray(1..3)`,
        },
        "main.gema",
        [1n, 2n, 3n]
    );
});

test("module: function uses map with lambda", () => {
    testCompileMulti(
        {
            "utils.gema": `func doubleAll(xs: Iter[Int]): Iter[Int] {
    map(\\x { x * 2 }, xs)
}`,
            "main.gema": `use "utils.gema"\ncollect(doubleAll(1..4))`,
        },
        "main.gema",
        [2n, 4n, 6n, 8n]
    );
});

test("module: function uses iterate builtin", () => {
    testCompileMulti(
        {
            "utils.gema": `func countFrom(n: Int): Iter[Int] {
    iterate(\\x { x + 1 }, n)
}`,
            "main.gema": `use "utils.gema"\ncollect(take(3, countFrom(5)))`,
        },
        "main.gema",
        [5n, 6n, 7n]
    );
});

test("module: generic function with trait bound", () => {
    // A simpler generic test: trait in module, implementation in entry
    testCompileMulti(
        {
            "traits.gema": `trait Any {}

func getLength(arr: Arr[T]): Int where T is Any {
    length(arr)
}`,
            "main.gema": `use "traits.gema"
getLength([10, 20, 30])`,
        },
        "main.gema",
        3n
    );
});

test("module: trait used across module boundary", () => {
    testCompileMulti(
        {
            "traits.gema": `trait Doublable { double[(self: Self): Int], }`,
            "impl.gema": `use "traits.gema"
struct S { v: Int }
func double(s: S): Int { s.v * 2 }`,
            "main.gema": `use "impl.gema"\ndouble(S(3))`,
        },
        "main.gema",
        6n
    );
});

test("module: transitive builtins (module imports module that uses builtins)", () => {
    testCompileMulti(
        {
            "base.gema": `func collectAndDouble(xs: Iter[Int]): Arr[Int] {
    collect(xs) | map(\\x { x * 2 }) | collect
}`,
            "utils.gema": `use "base.gema"
func process(xs: Iter[Int]): Arr[Int] { collectAndDouble(xs) }`,
            "main.gema": `use "utils.gema"\nprocess(1..3)`,
        },
        "main.gema",
        [2n, 4n, 6n]
    );
});

test("module: same builtin used in both entry and module", () => {
    testCompileMulti(
        {
            "utils.gema": `func collectOne(xs: Iter[Int]): Arr[Int] { collect(take(1, xs)) }`,
            "main.gema": `use "utils.gema"\ncollect(1..3) + collectOne(4..6)`,
        },
        "main.gema",
        [1n, 2n, 3n, 4n]
    );
});

test("module: filter + take builtins in module", () => {
    testCompileMulti(
        {
            "utils.gema": `func firstEven(xs: Iter[Int]): Iter[Int] {
    take(1, filter(\\x { x % 2 == 0 }, xs))
}`,
            "main.gema": `use "utils.gema"\ncollect(firstEven(1..10))`,
        },
        "main.gema",
        [2n]
    );
});

test("module: step builtin in module", () => {
    testCompileMulti(
        {
            "utils.gema": `func everyOther(xs: Iter[Int]): Iter[Int] { step(xs, 2) }`,
            "main.gema": `use "utils.gema"\ncollect(everyOther(1..6))`,
        },
        "main.gema",
        [1n, 3n, 5n]
    );
});

test("module: custom type defined in module", () => {
    testCompileMulti(
        {
            "point.gema": `
                struct Point { x: Float, y: Float, }
                func abs(p: Point) { (p.x^2.0 + p.y^2.0)^0.5 }
`,
            "main.gema": `
                use "point.gema"
                p = Point(3., 4.);
                abs(p)
`,
        },
        "main.gema",
        5.0
    );
});

test("module: use struct defined in another module", () => {
    testCompileMulti(
        {
            "point.gema": `
                struct Point { x: Float, y: Float, }
`,
            "main.gema": `
                use "point.gema"
                func abs(p: Point) { (p.x^2.0 + p.y^2.0)^0.5 }
                p = Point(3., 4.);
                abs(p)
`,
        },
        "main.gema",
        5.0
    );
});


// ── Helper used by tests above ──

function parseMultiFileSource(source: string): Record<string, string> {
    const lines = source.split("\n");
    const files: Record<string, string> = {};
    let currentFile: string | null = null;
    let currentContent: string[] = [];

    for (const raw of lines) {
        // Strip trailing \r for Windows line endings
        const line = raw.replace(/\r$/, "");
        const m = line.match(/^#---\s+(.+?)\s*---$/);
        if (m) {
            if (currentFile !== null && currentContent.length > 0) {
                files[currentFile] = currentContent.join("\n");
            }
            currentFile = m[1];
            currentContent = [];
        } else {
            currentContent.push(line);
        }
    }
    if (currentFile !== null && currentContent.length > 0) {
        files[currentFile] = currentContent.join("\n");
    }

    if (currentFile === null) {
        // No markers found — treat entire source as main.gema
        return { "main.gema": source };
    }

    return files;
}
