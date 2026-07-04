import { expect, test } from "bun:test";
import { testCompile, testCompileMulti, testCompileMultiExpectError } from "./helpers";

test("basic: function from module", () => {
    testCompileMulti(
        {
            "math.gema": `func add(x: Num, y: Num) { x + y }`,
            "main.gema": `use "math.gema"\nadd(3, 4)`,
        },
        "main.gema",
        7
    );
});

test("basic: struct from module", () => {
    testCompileMulti(
        {
            "structs.gema": `struct Point { x: Num, y: Num }`,
            "main.gema": `use "structs.gema"\nPoint(3, 4)`,
        },
        "main.gema",
        { x: 3, y: 4 }
    );
});

test("basic: variable from module", () => {
    testCompileMulti(
        {
            "config.gema": `pi = 3`,
            "main.gema": `use "config.gema"\npi`,
        },
        "main.gema",
        3
    );
});

test("chain: module A imports module B", () => {
    testCompileMulti(
        {
            "helpers.gema": `func double(x: Num) { x * 2 }`,
            "math.gema": `use "helpers.gema"\nfunc addDouble(x: Num, y: Num) { x + double(y) }`,
            "main.gema": `use "math.gema"\naddDouble(3, 4)`,
        },
        "main.gema",
        11
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
        3
    );
});

test("struct + func from same module", () => {
    testCompileMulti(
        {
            "calc.gema": `struct Pair { x: Num, y: Num }
func makePair(v: Num) { Pair(v, v * 2) }`,
            "main.gema": `use "calc.gema"\nmakePair(5)`,
        },
        "main.gema",
        { x: 5, y: 10 }
    );
});

test("trait from module", () => {
    testCompileMulti(
        {
            "traits.gema": `trait Doublable { double[Self: Num], }
struct S { v: Num }
func double(s: S): Num { s.v * 2 }`,
            "main.gema": `use "traits.gema"\ndouble(S(3))`,
        },
        "main.gema",
        6
    );
});

test("module with iterator: use in pipeline", () => {
    testCompileMulti(
        {
            "utils.gema": `func square(x: Num) { x * x }`,
            "main.gema": `use "utils.gema"\n1..3 | map(\\x square(x)) | collect`,
        },
        "main.gema",
        [1, 4, 9]
    );
});

test("parse multi-file source: #--- markers", () => {
    const source = `#--- math.gema ---
func add(x: Num, y: Num) { x + y }
#--- main.gema ---
use "math.gema"
add(3, 4)`;

    // Split the source by #--- markers
    const files = parseMultiFileSource(source);
    expect(files).toEqual({
        "math.gema": "func add(x: Num, y: Num) { x + y }",
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
        '#--- math.gema ---\r\nfunc add(x: Num, y: Num) { x + y }\r\n#--- main.gema ---\r\nuse "math.gema"\r\nadd(3, 4)';
    const files = parseMultiFileSource(source);
    expect(files).toEqual({
        "math.gema": "func add(x: Num, y: Num) { x + y }",
        "main.gema": 'use "math.gema"\nadd(3, 4)',
    });
});

// ── Module builtin integration tests ────────────────────────────

test("module: function uses reduce builtin", () => {
    testCompileMulti(
        {
            "math.gema": `func sum(xs: Iter[Num]): Num {
    reduce(\\(acc, x) { acc + x }, 0, xs)
}`,
            "main.gema": `use "math.gema"\nsum(1..3)`,
        },
        "main.gema",
        6
    );
});

test("module: function uses collect builtin", () => {
    testCompileMulti(
        {
            "utils.gema": `func toArray(xs: Iter[Num]): Arr[Num] { collect(xs) }`,
            "main.gema": `use "utils.gema"\ntoArray(1..3)`,
        },
        "main.gema",
        [1, 2, 3]
    );
});

test("module: function uses map with lambda", () => {
    testCompileMulti(
        {
            "utils.gema": `func doubleAll(xs: Iter[Num]): Iter[Num] {
    map(\\x { x * 2 }, xs)
}`,
            "main.gema": `use "utils.gema"\ncollect(doubleAll(1..4))`,
        },
        "main.gema",
        [2, 4, 6, 8]
    );
});

test("module: function uses iterate builtin", () => {
    testCompileMulti(
        {
            "utils.gema": `func countFrom(n: Num): Iter[Num] {
    iterate(\\x { x + 1 }, n)
}`,
            "main.gema": `use "utils.gema"\ncollect(take(3, countFrom(5)))`,
        },
        "main.gema",
        [5, 6, 7]
    );
});

test("module: generic function with trait bound", () => {
    // A simpler generic test: trait in module, implementation in entry
    testCompileMulti(
        {
            "traits.gema": `trait Foo { foo[Num: Num] }

func [T: Foo] getLength(arr: Arr[T]): Num {
    length(arr)
}`,
            "main.gema": `use "traits.gema"
func foo(a: Num) { 1 }
getLength([10, 20, 30])`,
        },
        "main.gema",
        3
    );
});

test("module: trait used across module boundary", () => {
    testCompileMulti(
        {
            "traits.gema": `trait Doublable { double[Self: Num], }`,
            "impl.gema": `use "traits.gema"
struct S { v: Num }
func double(s: S): Num { s.v * 2 }`,
            "main.gema": `use "impl.gema"\ndouble(S(3))`,
        },
        "main.gema",
        6
    );
});

test("module: transitive builtins (module imports module that uses builtins)", () => {
    testCompileMulti(
        {
            "base.gema": `func collectAndDouble(xs: Iter[Num]): Arr[Num] {
    collect(xs) | map(\\x { x * 2 }) | collect
}`,
            "utils.gema": `use "base.gema"
func process(xs: Iter[Num]): Arr[Num] { collectAndDouble(xs) }`,
            "main.gema": `use "utils.gema"\nprocess(1..3)`,
        },
        "main.gema",
        [2, 4, 6]
    );
});

test("module: same builtin used in both entry and module", () => {
    testCompileMulti(
        {
            "utils.gema": `func collectOne(xs: Iter[Num]): Arr[Num] { collect(take(1, xs)) }`,
            "main.gema": `use "utils.gema"\ncollect(1..3) + collectOne(4..6)`,
        },
        "main.gema",
        [1, 2, 3, 4]
    );
});

test("module: filter + take builtins in module", () => {
    testCompileMulti(
        {
            "utils.gema": `func firstEven(xs: Iter[Num]): Iter[Num] {
    take(1, filter(\\x { x % 2 == 0 }, xs))
}`,
            "main.gema": `use "utils.gema"\ncollect(firstEven(1..10))`,
        },
        "main.gema",
        [2]
    );
});

test("module: step builtin in module", () => {
    testCompileMulti(
        {
            "utils.gema": `func everyOther(xs: Iter[Num]): Iter[Num] { step(2, xs) }`,
            "main.gema": `use "utils.gema"\ncollect(everyOther(1..6))`,
        },
        "main.gema",
        [1, 3, 5]
    );
});

test("module: custom type defined in module", () => {
    testCompileMulti(
        {
            "point.gema": `
                struct Point { x: Num, y: Num, }
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
                struct Point { x: Num, y: Num, }
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

// ── Tree-shaking tests ─────────────────────────────────────────

test("tree-shaking: unused function eliminated", () => {
    const js = testCompileMulti(
        {
            "utils.gema": "func used() { 1 }\nfunc unused() { 2 }",
            "main.gema": 'use "utils.gema"\nused()',
        },
        "main.gema",
        1
    );
    expect(js).not.toInclude("unused");
});

test("tree-shaking: unused variable eliminated", () => {
    const js = testCompileMulti(
        {
            "config.gema": "used = 1\nunused = 2",
            "main.gema": 'use "config.gema"\nused',
        },
        "main.gema",
        1
    );
    expect(js).not.toInclude("unused");
});

test("tree-shaking: struct used as type is kept", () => {
    testCompileMulti(
        {
            "point.gema": "struct Point { x: Num, y: Num }",
            "main.gema":
                'use "point.gema"\nfunc abs(p: Point) { (p.x^2.0 + p.y^2.0)^0.5 }\nabs(Point(3., 4.))',
        },
        "main.gema",
        5.0
    );
});

test("tree-shaking: transitive reachability", () => {
    testCompileMulti(
        {
            "utils.gema":
                "func square(x: Num) { x * x }\nfunc double(x: Num) { x * 2 }\nfunc process(x: Num) { square(x) }",
            "main.gema": 'use "utils.gema"\nprocess(3)',
        },
        "main.gema",
        9
    );
});

test("tree-shaking: unreferenced struct eliminated", () => {
    const js = testCompileMulti(
        {
            "shapes.gema":
                "struct Point { x: Num, y: Num }\nstruct Line { a: Num, b: Num }\nfunc makePoint(x: Num, y: Num) { Point(x, y) }",
            "main.gema": 'use "shapes.gema"\nmakePoint(1, 2)',
        },
        "main.gema",
        { x: 1, y: 2 }
    );
    expect(js).toInclude("Point");
    expect(js).not.toInclude("Line");
});

test("tree-shaking: retain variable referenced in for loop", () => {
    const js = testCompile(
        `
        x = 1;
        mut max = 0;
        for i = 1..x {
            if i == x {
                break
            }
            max = i;
        }
        max
        `,
        0
    );
    expect(js).toInclude("x = ");
});

// ── Selective import tests ────────────────────────────────────

test("selective: basic function import", () => {
    testCompileMulti(
        {
            "math.gema": `func add(x: Num, y: Num) { x + y }`,
            "main.gema": `use (add) from "math.gema"\nadd(3, 4)`,
        },
        "main.gema",
        7
    );
});

test("selective: function import without parens", () => {
    testCompileMulti(
        {
            "math.gema": `func add(x: Num, y: Num) { x + y }`,
            "main.gema": `use add from "math.gema"\nadd(3, 4)`,
        },
        "main.gema",
        7
    );
});

test("selective: multiple symbols imported", () => {
    testCompileMulti(
        {
            "utils.gema": `func add(x: Num, y: Num) { x + y }
func sub(x: Num, y: Num) { x - y }`,
            "main.gema": `use (add, sub) from "utils.gema"\nadd(sub(10, 3), 2)`,
        },
        "main.gema",
        9
    );
});

test("selective: struct import", () => {
    testCompileMulti(
        {
            "shapes.gema": `struct Point { x: Num, y: Num }`,
            "main.gema": `use (Point) from "shapes.gema"\nPoint(3, 4)`,
        },
        "main.gema",
        { x: 3, y: 4 }
    );
});

test("selective: variable import", () => {
    testCompileMulti(
        {
            "config.gema": `pi = 3`,
            "main.gema": `use (pi) from "config.gema"\npi`,
        },
        "main.gema",
        3
    );
});

test("selective: error on non-imported function", () => {
    testCompileMultiExpectError(
        {
            "math.gema": `func add(x: Num, y: Num) { x + y }
func sub(x: Num, y: Num) { x - y }`,
            "main.gema": `use (add) from "math.gema"\nsub(5, 3)`,
        },
        "main.gema",
        "not found"
    );
});

test("selective: error on non-imported variable", () => {
    testCompileMultiExpectError(
        {
            "config.gema": `a = 1\nb = 2`,
            "main.gema": `use (a) from "config.gema"\nb`,
        },
        "main.gema",
        "unable to resolve type"
    );
});

test("selective: transitive deps of imported symbol work", () => {
    testCompileMulti(
        {
            "utils.gema": `func square(x: Num) { x * x }
func double(x: Num) { x * 2 }
func process(x: Num) { square(x) + double(x) }`,
            "main.gema": `use (process) from "utils.gema"\nprocess(3)`,
        },
        "main.gema",
        15
    );
});

test("selective: importing function that uses module-internal helper", () => {
    testCompileMulti(
        {
            "utils.gema": `func helper(x: Num) { x * 10 }
func foo(x: Num) { helper(x) + 1 }`,
            "main.gema": `use (foo) from "utils.gema"\nfoo(3)`,
        },
        "main.gema",
        31
    );
});

test("selective: chain through intermediate module", () => {
    testCompileMulti(
        {
            "helpers.gema": `func double(x: Num) { x * 2 }`,
            "math.gema": `use "helpers.gema"\nfunc addDouble(x: Num, y: Num) { x + double(y) }`,
            "main.gema": `use (addDouble) from "math.gema"\naddDouble(3, 4)`,
        },
        "main.gema",
        11
    );
});

test("selective: non-imported function still tree-shaken", () => {
    const js = testCompileMulti(
        {
            "utils.gema": `func used() { 1 }\nfunc unused() { 2 }`,
            "main.gema": `use (used) from "utils.gema"\nused()`,
        },
        "main.gema",
        1
    );
    expect(js).not.toInclude("unused");
});

test("selective: trailing comma", () => {
    testCompileMulti(
        {
            "math.gema": `func add(x: Num, y: Num) { x + y }`,
            "main.gema": `use (add,) from "math.gema"\nadd(3, 4)`,
        },
        "main.gema",
        7
    );
});

test("selective: can also use regular imports alongside selective", () => {
    testCompileMulti(
        {
            "utils.gema": `func a() { 1 }\nfunc b() { 2 }`,
            "main.gema": `use "utils.gema"\na() + b()`,
        },
        "main.gema",
        3
    );
});

test("selective: mixed regular and selective imports", () => {
    testCompileMulti(
        {
            "alpha.gema": `func a() { 10 }`,
            "beta.gema": `func b() { 20 }\nfunc c() { 30 }`,
            "main.gema": `use "alpha.gema"\nuse (b) from "beta.gema"\na() + b()`,
        },
        "main.gema",
        30
    );
});

test("selective: same-named function in entry shadows module", () => {
    // The entry defines its own `foo` with a different type; the module's `foo`
    // should not interfere. Only the module's `bar` is imported.
    testCompileMulti(
        {
            "module.gema": `
                func foo(x: Num, y: Num) { x + y }
                func bar(x: Num) { x }
            `,
            "main.gema": `
                use (bar) from "module.gema"
                func foo(x: Num, y: Num) { x + y }
                foo(1.0, 2.0)
            `,
        },
        "main.gema",
        3.0
    );
});

test("selective: same-named function in entry with same type", () => {
    // Even with the same type, the entry's definition takes priority
    testCompileMulti(
        {
            "module.gema": `
                func greet() { "from module" }
                func other() { 42 }
            `,
            "main.gema": `
                use (other) from "module.gema"
                func greet() { "from entry" }
                greet()
            `,
        },
        "main.gema",
        "from entry"
    );
});

test("selective: import function where matching symbol exists in multiple modules", () => {
    testCompileMulti(
        {
            "module1.gema": `
                func foo(x: Num) { x + 1 }
                func bar(x: Num) { x + 2 }
            `,
            "module2.gema": `
                func foo(x: Num) { x + 3 }
                func bar(x: Num) { x + 4 }
            `,
            "main.gema": `
                use (foo) from "module1.gema"
                use (bar) from "module2.gema"
                foo(0) + bar(1)
            `,
        },
        "main.gema",
        6
    );
});

test("selective: definition of same variable in multiple modules", () => {
    testCompileMulti(
        {
            "module1.gema": `
                x = 1;
                y = 2;
            `,
            "module2.gema": `
                x = 4;
                y = 3;
            `,
            "main.gema": `
                use (x) from "module1.gema"
                use (y) from "module2.gema"
                x + y
            `,
        },
        "main.gema",
        4
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
