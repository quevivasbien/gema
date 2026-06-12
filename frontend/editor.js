import { EditorView, basicSetup } from "codemirror";
import { oneDark } from "@codemirror/theme-one-dark";
import { gema } from "./gema-language.js";
import { keymap, Decoration } from "@codemirror/view";
import { compile } from "./compiler.js";
/* global document, window, Worker */

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
    factorial: {
        label: "Factorial (3 ways)",
        code: `# Compute the first 6 factorials three ways and show they match.

# 1. Recursive
func factRec(n: Int): Int {
    if (n <= 1) {
        1
    } else {
        n * factRec(n - 1)
    }
};

rec = collect(map(factRec[Int], range(0, 6)));

# 2. Reduce (functional)
func factReduce(n: Int): Int {
    if (n < 1) {
        1
    } else {
        reduce(
            func(acc: Int, x: Int) { acc * x },
            1,
            range(1, n)
        )
    }
};

fld = collect(map(factReduce[Int], range(0, 6)));

# 3. For loop (imperative)
func factFor(n: Int): Int {
    if (n < 1) {
        1
    } else {
        mut result = 1;
        for i = range(1, n) {
            result = result * i
        };
        result
    }
};

imp = collect(map(factFor[Int], range(0, 6)));

# All three produce the same result
rec == fld and fld == imp   # true
`,
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
plus1 = collect(map(add1, evens));

sum = reduce(
    func(acc: Int, x: Int) { acc + x },
    0,
    plus1
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
        code: `trait Concatenatable {
  concat[(a: Self, b: Self): Self],
}

func tacnoc(a: T, b: T): T where T is Concatenatable {
  concat(b, a)
}

# Implement Concatenatable for strings
func concat(a: Str, b: Str) {
  a + b
}

tacnoc("hello", "there")  # "therehello"

# Implement Concatenatable for integers
func concat(a: Int, b: Int) {
  func getNDigits(x: Int, n: Int): Int {
    if x <= 0 { n }
    else { getNDigits(x / 10, n + 1) }
  }
  a*10^getNDigits(b, 0) + b
}

tacnoc(123, 45)  # 45123

# Implement Concatenatable for a custom type
struct Pair { first: Int, second: Int }

func concat(a: Pair, b: Pair) {
  Pair(concat(a.first, b.first), concat(a.second, b.second))
}

# To help us view the result
func toStr(p: Pair) {
  "(" + toStr(p.first) + ", " + toStr(p.second) + ")"
}

toStr(tacnoc(Pair(1, 2), Pair(34, 56)))  # (341, 562)`,
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
    reduce(func(acc:Str, x:Str){acc+x}, "", strs)
}

func toStr(arr: Iter[Bool]) {
    strs = map(func(x: Bool){ if x { "*" } else { " " }}, arr);
    concat(strs) + "\\n"
}

grid = {
    xs = collect(linspace(-1.75, 0.25, 19));
    ys = collect(linspace(-1., 1., 19));
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
    mutableVars: {
        label: "Mutable Variables",
        code: `# Mutable variables with reassignment and compound ops

mut counter = 0;
counter = counter + 1;   # 1
counter += 2;            # 3 (compound +=)
counter *= 3;            # 9 (compound *=)

# Closures capture mutable vars by reference
func makeCounter(): Func[:Int] {
    mut count = 0;
    func() { count = count + 1; count }
};

a = makeCounter();
b = makeCounter();
[a(), a(), b(), b()]   # [1, 2, 1, 2]`,
    },
    mutableStructs: {
        label: "Mutable Struct Fields",
        code: `# Struct fields can be declared mutable
struct Point {
    mut x: Int,
    mut y: Int,
};

p = Point(1, 2);
p.x = 10;       # Field mutation
p.y += 5;       # Compound field assignment
p.x + p.y       # 15

# Operator overloading still works with mutability
struct Adder {
    mut val: Int,
};

func add(a: Adder, b: Adder): Adder {
    Adder(a.val + b.val)
};

mut a = Adder(3);
a += Adder(4);
a.val   # 7`,
    },
    tuplesAndZip: {
        label: "Tuples & Zip",
        code: `# ── Tuples ──────────────────────────────────────────

# Tuple literals group values of different types
t = (1, "hello", 3.0);

# Index with a literal to access elements
t(0)          # 1
t(1)          # "hello"
t(2)          # 3.0

# Nested tuples
nested = (1, (2, 3));
nested(1)(0)  # 2

# Tuple unpacking
(a, b, c) = (10, 20, 30);
a + b + c      # 60

# Unpacking from a function
func point(): Tuple[Int, Int] { (3, 4) };
(x, y) = point();
x * x + y * y  # 25

# ── Zip Iterator ─────────────────────────────────────

# zip combines iterables into an iterator of tuples
collect(zip([1, 2, 3], ["a", "b", "c"]))
# [(1, "a"), (2, "b"), (3, "c")]

# Stops at the shortest input
collect(zip([1, 2], ["a", "b", "c"]))
# [(1, "a"), (2, "b")]

# Three or more iterables
collect(zip([1, 2], ["a", "b"], [true, false]))
# [(1, "a", true), (2, "b", false)]

# Combine zip with map — tuple elements are accessed by index
collect(map(
    func(pair: Tuple[Int, Int]) { pair(0) + pair(1) },
    zip([1, 2, 3], [10, 20, 30])
))   # [11, 22, 33]`,
    },
    mutableArrays: {
        label: "Mutable Arrays",
        code: `# trans() creates a mutable array (deep copy from Arr)
mutarr = trans([1, 2, 3]);

# push returns the array (chainable)
push(mutarr, 4);
push(mutarr, 5);

# set(index, value) returns the new value
set(mutarr, 0, 99);

# detrans() freezes back to a regular array
arr = detrans(mutarr)   # [99, 2, 3, 4, 5]

# unsafeTrans avoids the copy
x = [1, 2, 3];
y = unsafeTrans(x);
set(y, 0, 99);
x   # [99, 2, 3] — original was modified!`,
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

// ── Worker pool (singleton) ─────────────────────────────────────

let workerInstance = null;

/** Get or create the sandboxed execution Worker. */
function getWorker() {
    if (workerInstance) return workerInstance;
    // Create the Worker inline via Blob URL — no separate file needed at runtime.
    // eval() is safe inside a Worker because Workers have no DOM access.
    const blob = new Blob(
        [
            `self.onmessage=function(e){
        const js=e.data.js;
        if(typeof js!=="string"){self.postMessage({runtimeError:"No JS code provided."});return}
        try{const r=eval(js);self.postMessage({result:String(r)})}
        catch(err){self.postMessage({runtimeError:err instanceof Error?err.message:String(err)})}
      }`,
        ],
        { type: "application/javascript" }
    );
    workerInstance = new Worker(URL.createObjectURL(blob));
    return workerInstance;
}

/** Display error lines by highlighting them in the editor. */
function displayErrors(view, errors, code) {
    const outputEl = document.getElementById("output");
    const lines = code.split("\n");
    const errorText = errors
        .map((err) => {
            const lineNum = err.line + 1;
            const context = lines[err.line] || "";
            return `Error on line ${lineNum}, column ${err.col + 1}: ${err.message}\n  ${lineNum} | ${context}\n  ${" ".repeat(String(lineNum).length + err.col + 3)}^`;
        })
        .join("\n\n");
    outputEl.innerText = errorText;
    outputEl.className = "output-panel output-error";

    const errorLines = errors.map((e) => e.line);
    view.dispatch({ effects: addErrorLine.of(errorLines) });

    const firstErrorLine = Math.min(...errorLines);
    const line = view.state.doc.line(firstErrorLine + 1);
    view.dispatch({
        effects: EditorView.scrollIntoView(line.from, { y: "center" }),
    });
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
    jsContent.classList.add("collapsed");
    runBtn.disabled = true;
    runBtn.textContent = "Running...";

    try {
        // Step 1: Compile (runs in main thread — pure string manipulation, safe)
        const compiled = compile(code);

        if (compiled.errors && compiled.errors.length > 0) {
            displayErrors(view, compiled.errors, code);
            runBtn.disabled = false;
            runBtn.textContent = "Run (Ctrl+Enter)";
            return;
        }

        // Show compiled JS immediately
        jsOutputEl.innerText = compiled.js;
        jsContent.classList.remove("collapsed");

        // Step 2: Execute in a sandboxed Worker
        const result = await new Promise((resolve, reject) => {
            const worker = getWorker();
            const onMessage = (e) => {
                worker.removeEventListener("message", onMessage);
                worker.removeEventListener("error", onError);
                resolve(e.data);
            };
            const onError = (err) => {
                worker.removeEventListener("message", onMessage);
                worker.removeEventListener("error", onError);
                reject(err);
            };
            worker.addEventListener("message", onMessage);
            worker.addEventListener("error", onError);
            worker.postMessage({ js: compiled.js });
        });

        if (result.runtimeError) {
            outputEl.innerText = `Runtime error: ${result.runtimeError}`;
            outputEl.className = "output-panel output-error";
        } else {
            outputEl.innerText = result.result;
            outputEl.className = "output-panel output-success";
        }
    } catch (err) {
        outputEl.innerText = `Execution failed: ${err.message}`;
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
