import { EditorView, basicSetup } from "codemirror";
import { oneDark } from "@codemirror/theme-one-dark";
import { gema } from "./gema-language.js";
import { keymap, Decoration } from "@codemirror/view";
import { Prec, StateEffect, StateField } from "@codemirror/state";
import { indentWithTab } from "@codemirror/commands";

// ── Presets ──────────────────────────────────────────────────────

const PRESETS = {
    hello: {
        label: "Hello World",
        code: `func sayHello(name: Str): Str {
    "Hello from " + name + "!"
};

sayHello("Gema")`,
    },
    recursiveFactorial: {
        label: "Factorial (recursive)",
        code: `func factorial(n: Int): Int {
    if (n <= 1) {
        1
    } else {
        n * factorial(n - 1)
    }
};

@map(factorial, range(0, 5))`,
    },
    iterativeFactorial: {
        label: "Factorial (iterative)",
        code: `func factorial(n: Int): Int {
    if (n < 1) {
        1
    } else {
        reduce(
            func(acc: Int, x: Int) { acc * x },
            range(1, n),
            1
        )
    }
};

@map(factorial, range(0, 5))`,
    },
    arrays: {
        label: "Arrays & Indexing",
        code: `# Array creation, concatenation, and indexing
x = [1, 2, 3];
y = [4, 5, 6];

# Concatenation
z = x + y;

# Multi-dimensional indexing
matrix = [[1, 2], [3, 4]];

# Results
z       # [1, 2, 3, 4, 5, 6]
matrix(0, 1)   # 2`,
    },
    mapFilterReduce: {
        label: "Map / Filter / Reduce",
        code: `func isEven(x: Int): Bool {
    x % 2 == 0
};

func add1(x: Int): Int {
    x + 1
};

nums = range(1, 10);

evens = filter(isEven, nums);
plus1 = @map(add1, evens);

sum = reduce(
    func(acc: Int, x: Int) { acc + x },
    plus1,
    0
);

sum   # 30 (sum of even numbers 1-10, each +1)`,
    },
    structs: {
        label: "Struct Types",
        code: `struct Point {
    x: Float,
    y: Float
};

func taxicab(a: Point, b: Point): Float {
    (b.x - a.x) + (b.y - a.y)
};

taxicab(Point(8.0, 7.0), Point(-2.0, 2.0))  # -15.0`,
    },
    generics: {
        label: "Generic Functions",
        code: `trait Any {}

struct Point {
    x: Int,
    y: Int
};

func id(a: T): T where T is Any {
    a
};

p = Point(1, 2);
q = id(p);
q.x + q.y   # 3`,
    },
    typeConversion: {
        label: "Type Conversions",
        code: `# Built-in type conversion functions
x = 42;

toStr(x)        # "42"
toFloat(x)      # 42.0
toBool(x)       # true

# String indexing
msg = "gema";
msg(0)          # "g"
msg(1)          # "e"`,
    },
    mandelbrot: {
        label: "Mandelbrot set",
        code: `struct Complex {
    re: Float,
    im: Float,
}

func abs(z: Complex): Float {
    z.re * z.re + z.im * z.im
}

func mandelIter(z: Complex, c: Complex, i: Int): Bool {
    if (i <= 0) { abs(z) < 4.0 }
    else {
        re = c.re + z.re * z.re - z.im * z.im;
        im = c.im + 2.0 * z.re * z.im;
        mandelIter(Complex(re, im), c, i-1)
    }
}

func isMandel(c: Complex): Bool {
    mandelIter(Complex(0.0, 0.0), c, 20)
}

func linspace(a: Float, b: Float, n: Int): Iter[Float] {
    step = (b - a) / toFloat(n - 1);
    map(func(i: Int) { a + step * toFloat(i) }, range(0, n - 1))
}

func concat(strs: Iter[Str]) {
    reduce(func(acc:Str, x:Str){acc+x}, strs, "")
}

func toStr(arr: Iter[Bool]) {
    strs = map(func(x: Bool){ if x { "*" } else { " " }}, arr);
    concat(strs) + "\\n"
}

grid = {
    xs = @linspace(-1.75, 0.25, 19);
    ys = @linspace(-1., 1., 19);
    concat(
        map(
            func(y: Float) {
                toStr(map(func(x: Float){ isMandel(Complex(x, y)) }, xs))
            },
            ys
        )
    )
};

grid
`,
    },
};

// ── Error decoration state ──────────────────────────────────────

const addErrorLine = StateEffect.define();
const clearErrors = StateEffect.define();

const errorLineDeco = Decoration.line({ class: "cm-error-line" });

const errorField = StateField.define({
    create() {
        return Decoration.none;
    },
    update(decos, tr) {
        for (const effect of tr.effects) {
            if (effect.is(clearErrors)) {
                return Decoration.none;
            }
            if (effect.is(addErrorLine)) {
                const lineNums = effect.value; // array of 0-based line numbers
                const decorations = [];
                for (const ln of lineNums) {
                    const line = tr.state.doc.line(ln + 1);
                    decorations.push(errorLineDeco.range(line.from));
                }
                return Decoration.set(decorations);
            }
        }
        return decos.map(tr.changes);
    },
    provide: (field) => EditorView.decorations.from(field),
});

// ── Editor setup ────────────────────────────────────────────────

function createEditor(parent) {
    const startPreset = "hello";

    const view = new EditorView({
        doc: PRESETS[startPreset].code,
        extensions: [
            basicSetup,
            gema(),
            oneDark,
            Prec.highest(
                keymap.of([
                    indentWithTab,
                    {
                        key: "Mod-Enter",
                        run: (view) => {
                            runCode(view);
                            return true;
                        },
                    },
                ])
            ),
            errorField,
            EditorView.theme({
                "&": { height: "100%" },
                ".cm-scroller": { overflow: "auto" },
            }),
        ],
        parent,
    });

    return view;
}

// ── Run code ────────────────────────────────────────────────────

async function runCode(view) {
    const outputEl = document.getElementById("output");
    const jsOutputEl = document.getElementById("js-compiled");
    const jsContent = document.getElementById("js-panel-content");
    const runBtn = document.getElementById("button-run");

    if (!outputEl) return;

    // Clear previous error decorations
    view.dispatch({ effects: clearErrors.of(null) });

    const code = view.state.doc.toString();

    // Show running state
    outputEl.innerText = "Running...";
    outputEl.className = "output-panel";
    jsOutputEl.innerText = "";
    runBtn.disabled = true;
    runBtn.textContent = "Running...";

    try {
        const response = await fetch("/run", { method: "POST", body: code });
        const data = await response.json();

        if (data.errors && data.errors.length > 0) {
            // Display errors
            const lines = code.split("\n");
            const errorText = data.errors
                .map((err) => {
                    const lineNum = err.line + 1;
                    const context = lines[err.line] || "";
                    return `Error on line ${lineNum}, column ${err.col + 1}: ${err.message}\n  ${lineNum} | ${context}\n  ${" ".repeat(String(lineNum).length + err.col + 3)}^`;
                })
                .join("\n\n");
            outputEl.innerText = errorText;
            outputEl.className = "output-panel output-error";

            // Highlight error lines in editor
            const errorLines = data.errors.map((e) => e.line);
            view.dispatch({ effects: addErrorLine.of(errorLines) });

            // Scroll to first error
            const firstErrorLine = Math.min(...errorLines);
            const line = view.state.doc.line(firstErrorLine + 1);
            view.dispatch({
                effects: EditorView.scrollIntoView(line.from, { y: "center" }),
            });
        } else if (data.runtimeError) {
            outputEl.innerText = `Runtime error: ${data.runtimeError}`;
            outputEl.className = "output-panel output-error";
            if (data.js) {
                jsOutputEl.innerText = data.js;
                jsContent.classList.remove("collapsed");
            }
        } else {
            // Success
            outputEl.innerText = data.result;
            outputEl.className = "output-panel output-success";
            if (data.js) {
                jsOutputEl.innerText = data.js;
                jsContent.classList.remove("collapsed");
            }
        }
    } catch (err) {
        outputEl.innerText = `Request failed: ${err.message}`;
        outputEl.className = "output-panel output-error";
    } finally {
        runBtn.disabled = false;
        runBtn.textContent = "Run (Ctrl+Enter)";
    }
}

// ── Preset selector ─────────────────────────────────────────────

function setupPresets(view) {
    const select = document.getElementById("select-preset");
    if (!select) return;

    // Populate the dropdown
    for (const [key, preset] of Object.entries(PRESETS)) {
        const opt = document.createElement("option");
        opt.value = key;
        opt.textContent = preset.label;
        select.appendChild(opt);
    }

    select.value = "hello";
    select.addEventListener("change", () => {
        const code = PRESETS[select.value]?.code;
        if (!code) return;
        view.dispatch({
            changes: {
                from: 0,
                to: view.state.doc.length,
                insert: code,
            },
        });
        // Clear errors
        view.dispatch({ effects: clearErrors.of(null) });
        document.getElementById("output").innerText = "-- Run code to view output here --";
        document.getElementById("output").className = "output-panel";
        document.getElementById("js-compiled").innerText = "";
        document.getElementById("js-panel-content").classList.add("collapsed");
    });
}

// ── Initialization ──────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
    const editorContainer = document.getElementById("editor");
    if (!editorContainer) {
        console.error("Editor container not found");
        return;
    }

    const view = createEditor(editorContainer);
    setupPresets(view);

    // Run button
    const runBtn = document.getElementById("button-run");
    if (runBtn) {
        runBtn.addEventListener("click", () => runCode(view));
    }

    // Toggle compiled JS visibility — header stays visible, content toggles
    const jsHeader = document.getElementById("js-panel-header");
    const jsContent = document.getElementById("js-panel-content");
    if (jsHeader && jsContent) {
        jsHeader.addEventListener("click", () => {
            jsContent.classList.toggle("collapsed");
        });
    }

    // Expose for debugging
    window.__gemaEditor = view;
});
