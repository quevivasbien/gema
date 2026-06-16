import { EditorView, basicSetup } from "codemirror";
import { oneDark } from "@codemirror/theme-one-dark";
import { gema } from "./gema-language.js";
import { keymap, Decoration } from "@codemirror/view";
import { compile } from "../src/compiler.ts";
/* global document, window, Worker */

import { Prec, StateEffect, StateField } from "@codemirror/state";
import { indentWithTab } from "@codemirror/commands";

// ── Presets ──────────────────────────────────────────────────────

const PRESETS = {
    blank: {
        label: "Blank",
        code: `# Write your code here, or choose a preset above`,
    },
    fizzbuzz: {
        label: "FizzBuzz",
        code: `# Classic FizzBuzz: print Fizz for multiples of 3,
# Buzz for multiples of 5, FizzBuzz for both.

func fizzbuzz(n: Int): Str {
    if (n % 15 == 0) {
        "FizzBuzz"
    } else if (n % 3 == 0) {
        "Fizz"
    } else if (n % 5 == 0) {
        "Buzz"
    } else {
        toStr(n)
    }
};

# Apply to range 1..20, collect into array
1..20 | map(fizzbuzz[Int]) | collect`,
    },
    fibonacci: {
        label: "Fibonacci",
        code: `# Fibonacci sequence shown three ways

# 1. Recursive
func fibRec(n: Int): Int {
    if (n <= 1) { n }
    else { fibRec(n - 1) + fibRec(n - 2) }
};

# 2. With iterate
# iterate(fn, start) produces: start, fn(start), fn(fn(start)), ...
# We iterate a pair (a,b) → (b, a+b) to generate Fibonacci
fibs = iterate(\\pair { (pair(1), pair(0) + pair(1)) }, (0, 1))
       | map(\\p { p(0) })
       | take(10)
       | collect;

# 3. Imperative with mutable vars
func fibLoop(n: Int): Int {
    if (n <= 1) { n }
    else {
        mut a = 0;
        mut b = 1;
        for i = 2..n {
            next = a + b;
            a = b;
            b = next
        };
        b
    }
};

loop10 = 0..9 | map(fibLoop[Int]) | collect;

# All produce the same sequence
[fibRec(9), fibs(9) | unwrap, loop10(9) | unwrap]   # all 34`,
    },
    quicksort: {
        label: "Quicksort",
        code: `# Quicksort using functional style
func quicksort(iter: Iter[Int]): Iter[Int] {
    first = iter(0);
    if isnone(first){
        iter
    } else {
        pivot = unwrap(first);
        rest = (drop(1, iter));
        left = filter(\\x { x <= pivot }, rest);
        right = filter(\\x { x > pivot }, rest);
        quicksort(left) + [pivot] + quicksort(right)
    }
};

unsorted = [3, 7, 8, 5, 2, 1, 9, 6, 4];
quicksort(unsorted) | collect   # [1, 2, 3, 4, 5, 6, 7, 8, 9]`,
    },
    sieve: {
        label: "Sieve of Eratosthenes",
        code: `# Sieve of Eratosthenes using mutable arrays

func sieve(n: Int): Arr[Int] {
    mut isPrime = map(\\_ true, 0..n) | collect | trans;
    put(isPrime, 0, false);
    put(isPrime, 1, false);

    for i = (2..) {
        if i * i > n { break; }
        if (isPrime(i) | unwrap) {
            for j = step((i * 2)..n, i) {
                put(isPrime, j, false)
            }
        }
    };

    (0..n) | filter(\\x { isPrime(x) | unwrap }) | collect
};

sieve(50)   # primes up to 50`,
    },
    fbpipeline: {
        label: "Functional Pipeline",
        code: `# A functional pipeline: compute sum of squares of even
# numbers from 1..100, using pipe and lambdas.

result = 1..100
    | filter(\\x { x % 2 == 0 })    # keep evens
    | map(\\x { x * x })              # square them
    | reduce(\\acc, x { acc + x }, 0) # sum

# Same thing expressed more concisely:
result2 = reduce(\\acc, x {
    if x % 2 == 0 { acc + x * x } else { acc }
}, 0, 1..100);

result == result2   # true (both are 171700)`,
    },
    primeFactors: {
        label: "Prime Factorization",
        code: `# Prime factorization using recursion and iteration

func smallestFactor(n: Int): Int {
    if (n % 2 == 0) { 2 }
    else {
        factors = (3..)
            | takeWhile(\\x { x * x <= n})
            | filter(\\x { n % x == 0 });
        unwrap(factors(0), n)
    }
};

func factors(n: Int): Arr[Int] {
    if (n <= 1) { []:Int }
    else {
        sf = smallestFactor(n);
        [sf] + factors(n / sf)
    }
};

factors(84)   # [2, 2, 3, 7]`,
    },
    wordCount: {
        label: "Word Frequency",
        code: `# Count word frequencies using Dict and functional combinators

# Sample text as an array of words
words = ["the", "quick", "brown", "fox", "jumps", "over",
         "the", "lazy", "dog", "the", "fox"];

# Build a frequency dict manually
func countWords(words: Arr[Str]): Dict[Str, Int] {
    freq = trans(Dict([]:Tuple[Str, Int]));
    for w = words {
        count = freq(w);
        put(freq, w, (if isnone(count) { 0 } else { unwrap(count) }) + 1)
    };
    detrans(freq)
};

freq = countWords(words);

# Access individual frequencies
(
  freq("the") | unwrap,   # 3
  freq("fox") | unwrap,   # 2
)`,
    },
    generics: {
        label: "Generic Functions",
        code: `# Generic functions with trait bounds — concatenate in reverse

trait Concatenatable {
  concat[(a: Self, b: Self): Self],
}

# Generic: works with any Concatenatable type
func tacnoc(a: T, b: T): T where T is Concatenatable {
  concat(b, a)
}

# Implement for strings
func concat(a: Str, b: Str) { a + b };
tacnoc("hello", "there")                     # "therehello"

# Implement for integers (digit concatenation)
func concat(a: Int, b: Int) {
  func getNDigits(x: Int, n: Int): Int {
    if x <= 0 { n }
    else { getNDigits(x / 10, n + 1) }
  };
  a * 10 ^ getNDigits(b, 0) + b
};
tacnoc(123, 45)                              # 45123

# Implement for a struct
struct Pair { first: Int, second: Int }
func concat(a: Pair, b: Pair) {
  Pair(concat(a.first, b.first), concat(a.second, b.second))
};
func toStr(p: Pair) {
  "(" + toStr(p.first) + ", " + toStr(p.second) + ")"
};
toStr(tacnoc(Pair(1, 2), Pair(34, 56)))      # (341, 562)`,
    },
    mandelbrot: {
        label: "Mandelbrot set",
        code: `# ASCII Mandelbrot set visualization
struct Complex { re: Float, im: Float }

func add(a: Complex, b: Complex): Complex {
    Complex(a.re + b.re, a.im + b.im)
}

func mul(z: Complex, c: Complex): Complex {
    Complex(c.re + z.re * z.re - z.im * z.im,
            c.im + 2.0 * z.re * z.im)
}

func abs2(z: Complex): Float { z.re * z.re + z.im * z.im }

func mandelIter(z: Complex, c: Complex, i: Int): Bool {
    if (i <= 0) { abs2(z) < 4.0 }
    else { mandelIter(mul(z, c), c, i - 1) }
}

func isMandel(c: Complex): Bool {
    mandelIter(Complex(0.0, 0.0), c, 20)
}

func linspace(a: Float, b: Float, n: Int): Iter[Float] {
    step = (b - a) / toFloat(n - 1);
    map(\\i { a + step * toFloat(i) }, 0..(n - 1))
}

func concat(strs: Iter[Str]) {
    reduce(\\acc, x { acc + x }, "", strs)
}

func toStr(arr: Iter[Bool]) {
    strs = map(\\x { if x { "*" } else { " " } }, arr);
    concat(strs) + "\\n"
}

grid = concat(map(\\y {
    xs = collect(linspace(-1.75, 0.25, 39));
    toStr(map(\\x { isMandel(Complex(x, y)) }, xs))
}, collect(linspace(-1., 1., 39))));
grid
`,
    },
    counter: {
        label: "Closures & State",
        code: `# Closures capture mutable variables by reference,
# enabling stateful function objects.

func makeCounter(): Func[:Int] {
    mut count = 0;
    func() { count = count + 1; count }
};

a = makeCounter();
b = makeCounter();
indep_state = [a(), a(), b(), b()];   # [1, 2, 1, 2] — independent state

# Higher-order: a function that takes a predicate
# and returns a filtered counter
func makeFilteredCounter(pred: Func[Int: Bool]): Func[:Int] {
    mut count = 0;
    func() {
        count = count + 1;
        if pred(count) { count } else { 0 }
    }
};

evens = makeFilteredCounter(\\x { x % 2 == 0 });
mutating_state = [evens(), evens(), evens()];   # [0, 2, 0]

(indep_state, mutating_state)`,
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
    const startPreset = Object.keys(PRESETS)[0];

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

function getWorker(js) {
    const workerPayload = `${js}
try {
    const result = main();
    if (typeof postMessage !== 'undefined') {
        postMessage({ status: 'success', data: result });
    }
} catch (err) {
    if (typeof postMessage !== 'undefined') {
        postMessage({ status: 'error', data: err.message });
    }
}`;
    console.log("payload:", workerPayload);
    const blob = new Blob([workerPayload], { type: "application/javascript" });
    const workerURL = URL.createObjectURL(blob);
    return new Worker(workerURL);
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
        const compiled = compile(code, "inline");

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
        new Promise((resolve, reject) => {
            const worker = getWorker(compiled.js);
            worker.onmessage = (event) => {
                console.log("Got result from worker:", event.data);
                const { status, data } = event.data;
                if (status === "success") {
                    console.log("Result from worker:", data);
                    resolve(data);
                } else {
                    console.error("Error inside worker:", data);
                    reject(data);
                }
                worker.terminate();
            };
        }).then(
            // onfulfilled
            (result) => {
                outputEl.innerText = result;
                outputEl.className = "output-panel output-success";
            },
            // onrejected
            (error) => {
                outputEl.innerText = `Runtime error: ${error}`;
                outputEl.className = "output-panel output-error";
            }
        );
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

    select.value = Object.keys(PRESETS)[0];
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
