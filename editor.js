import { EditorView, basicSetup } from "codemirror";
import { oneDark } from "@codemirror/theme-one-dark";
import { keymap, Decoration } from "@codemirror/view";
import { compile } from "../src/compiler.ts";

import { Prec, StateEffect, StateField } from "@codemirror/state";
import { indentWithTab, toggleComment } from "@codemirror/commands";

import { PRESETS } from "./editor-presets.js";
import { gema } from "./gema-language.js";
import { getWorker } from "./get-worker.js";

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
                        key: "Mod-/",
                        run: toggleComment,
                    },
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
                ".cm-content": {
                    fontFamily: "'Google Sans Code', monospace",
                    fontSize: "12px",
                    fontWeight: 500,
                    padding: "12px 0",
                },
                ".cm-line": { padding: "0 12px" },
                ".cm-scroller": { overflow: "auto" },
            }),
        ],
        parent,
    });

    return view;
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
                const { status, data } = event.data;
                if (status === "success") {
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

    // Toggle panes: each takes half the space by default; collapsing one
    // makes the other fill the full area. You cannot collapse the last
    // visible pane — the other must be expanded first.
    const outputSection = document.getElementById("output-section");
    const jsSection = document.getElementById("js-section");
    const outputHeader = document.getElementById("output-header");
    const outputContent = document.getElementById("output-content");
    const jsHeader = document.getElementById("js-panel-header");
    const jsContent = document.getElementById("js-panel-content");

    function toggleOutput() {
        if (outputContent.classList.contains("collapsed")) {
            // Output is hidden — expand to 50/50
            outputContent.classList.remove("collapsed");
            outputSection.classList.remove("collapsed");
        } else if (jsContent.classList.contains("collapsed")) {
            // Output is visible, JS is hidden — swap: hide output, show JS
            outputContent.classList.add("collapsed");
            outputSection.classList.add("collapsed");
            jsContent.classList.remove("collapsed");
            jsSection.classList.remove("collapsed");
        } else {
            // Both visible — collapse output, JS fills the space
            outputContent.classList.add("collapsed");
            outputSection.classList.add("collapsed");
        }
    }

    function toggleJs() {
        if (jsContent.classList.contains("collapsed")) {
            // JS is hidden — expand to 50/50
            jsContent.classList.remove("collapsed");
            jsSection.classList.remove("collapsed");
        } else if (outputContent.classList.contains("collapsed")) {
            // JS is visible, output is hidden — swap: hide JS, show output
            jsContent.classList.add("collapsed");
            jsSection.classList.add("collapsed");
            outputContent.classList.remove("collapsed");
            outputSection.classList.remove("collapsed");
        } else {
            // Both visible — collapse JS, output fills the space
            jsContent.classList.add("collapsed");
            jsSection.classList.add("collapsed");
        }
    }

    if (outputHeader) {
        outputHeader.addEventListener("click", toggleOutput);
    }

    if (jsHeader && jsContent) {
        jsHeader.addEventListener("click", toggleJs);
    }

    // Expose for debugging
    window.__gemaEditor = view;
});
