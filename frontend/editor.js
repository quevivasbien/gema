import { EditorView, basicSetup } from "codemirror";
import { oneDark } from "@codemirror/theme-one-dark";
import { keymap, Decoration } from "@codemirror/view";
import { compile } from "../src/compiler.ts";

import { Prec, StateEffect, StateField, Compartment } from "@codemirror/state";
import { indentUnit } from "@codemirror/language";
import { indentWithTab, toggleComment } from "@codemirror/commands";
import { javascriptLanguage } from "@codemirror/lang-javascript";

import { PRESETS } from "./editor-presets.js";
import { gema } from "./gema-language.js";
import { getWorker, getJSModuleWorker } from "./get-worker.js";

// ── Multi-file state ────────────────────────────────────────────

/** Array of open files. Each has a name and current content. */
let openFiles = [];
/** Index of the currently active tab. */
let activeTabIndex = 0;
/** Whether we're in the middle of switching tabs (suppress doc change events). */
let isSwitchingTab = false;
/** Compartment for the editor language so we can swap between gema and JS highlighting. */
const languageComp = new Compartment();

function currentFile() {
    return openFiles[activeTabIndex];
}

function getFilesRecord() {
    const record = {};
    for (const f of openFiles) {
        record[f.name] = f.content;
    }
    return record;
}

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

// ── Tab bar rendering ───────────────────────────────────────────

function renderTabs(view) {
    const tabBar = document.getElementById("tab-bar");
    if (!tabBar) return;

    // Save current content before re-rendering
    if (!isSwitchingTab && openFiles.length > 0) {
        currentFile().content = view.state.doc.toString();
    }

    tabBar.innerHTML = "";

    for (let i = 0; i < openFiles.length; i++) {
        const file = openFiles[i];
        const tab = document.createElement("button");
        tab.className = "tab" + (i === activeTabIndex ? " active" : "");
        tab.dataset.index = i;

        const nameSpan = document.createElement("input");
        nameSpan.className = "tab-name";
        nameSpan.value = file.name;
        nameSpan.title = file.name;
        nameSpan.addEventListener("input", () => {
            file.name = nameSpan.value;
            nameSpan.title = nameSpan.value;
        });
        nameSpan.addEventListener("mousedown", (e) => e.stopPropagation());

        tab.appendChild(nameSpan);

        if (openFiles.length > 1) {
            const closeBtn = document.createElement("span");
            closeBtn.className = "tab-close";
            closeBtn.textContent = "×";
            closeBtn.addEventListener("mousedown", (e) => e.stopPropagation());
            closeBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                closeTab(i, view);
            });
            tab.appendChild(closeBtn);
        }

        tab.addEventListener("click", () => switchTab(i, view));
        tabBar.appendChild(tab);
    }

    const addBtn = document.createElement("button");
    addBtn.className = "tab-add";
    addBtn.textContent = "+";
    addBtn.title = "Add new file";
    addBtn.addEventListener("click", () => addTab(view));
    tabBar.appendChild(addBtn);

    // Spacer to push download button to the right
    const spacer = document.createElement("div");
    spacer.style.flex = "1";
    tabBar.appendChild(spacer);

    // Download button
    const downloadBtn = document.createElement("button");
    downloadBtn.className = "tab-add";
    downloadBtn.textContent = "📥";
    downloadBtn.title = "Download all files";
    downloadBtn.addEventListener("click", () => {
        // Save the current tab's content before downloading
        currentFile().content = view.state.doc.toString();

        // Trigger a download for each file with a small delay between them
        // to avoid browser rate-limiting on simultaneous downloads
        openFiles.forEach((file, i) => {
            setTimeout(() => {
                const blob = new Blob([file.content], { type: "text/plain" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = file.name;
                a.click();
                URL.revokeObjectURL(url);
            }, i * 100);
        });
    });
    tabBar.appendChild(downloadBtn);
}

function switchTab(index, view) {
    if (index === activeTabIndex || index < 0 || index >= openFiles.length) return;

    // Save current content
    currentFile().content = view.state.doc.toString();

    isSwitchingTab = true;
    activeTabIndex = index;

    // Load new file content
    view.dispatch({
        changes: {
            from: 0,
            to: view.state.doc.length,
            insert: currentFile().content,
        },
    });

    isSwitchingTab = false;
    renderTabs(view);
    updateLanguage(view);

    // Re-apply error highlights for the newly active file
    highlightCurrentFileErrors(view);
}

function addTab(view) {
    // Save current content
    currentFile().content = view.state.doc.toString();

    const baseName = "module";
    let counter = 1;
    while (openFiles.some((f) => f.name === `${baseName}${counter}.gema`)) counter++;
    const name = `${baseName}${counter}.gema`;

    openFiles.push({ name, content: "" });
    activeTabIndex = openFiles.length - 1;

    view.dispatch({
        changes: {
            from: 0,
            to: view.state.doc.length,
            insert: "",
        },
    });

    renderTabs(view);
}

function closeTab(index, view) {
    if (openFiles.length <= 1) return; // don't close last tab

    // Save current content
    currentFile().content = view.state.doc.toString();

    openFiles.splice(index, 1);

    if (activeTabIndex >= openFiles.length) activeTabIndex = openFiles.length - 1;
    if (index < activeTabIndex) activeTabIndex--;
    if (index === activeTabIndex && index >= openFiles.length)
        activeTabIndex = openFiles.length - 1;

    view.dispatch({
        changes: {
            from: 0,
            to: view.state.doc.length,
            insert: currentFile().content,
        },
    });

    renderTabs(view);
}

function loadPresetFiles(files, view) {
    const entries = Object.entries(files);
    if (entries.length === 0) {
        entries.push(["main.gema", ""]);
    }

    openFiles = entries.map(([name, content]) => ({ name, content }));
    activeTabIndex = 0;

    isSwitchingTab = true;
    view.dispatch({
        changes: {
            from: 0,
            to: view.state.doc.length,
            insert: currentFile().content,
        },
    });
    isSwitchingTab = false;

    renderTabs(view);
    updateLanguage(view);
}

// ── Editor setup ────────────────────────────────────────────────

function createEditor(parent) {
    const startPreset = Object.keys(PRESETS)[0];
    const preset = PRESETS[startPreset];
    const files = preset.files || { "main.gema": preset.code || "" };

    const view = new EditorView({
        doc: Object.values(files)[0] || "",
        extensions: [
            basicSetup,
            languageComp.of(gema()),
            oneDark,
            indentUnit.of("    "),
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

    // Initialize multi-file state from preset
    const entries = Object.entries(files);
    openFiles = entries.map(([name, content]) => ({ name, content }));
    activeTabIndex = 0;
    renderTabs(view);
    updateLanguage(view);

    return view;
}

/** Swap the editor's syntax highlighting to match the active file's extension. */
function updateLanguage(view) {
    const file = currentFile();
    const ext = file ? file.name.split(".").pop() : "gema";
    if (ext === "js" || ext === "mjs") {
        view.dispatch({
            effects: languageComp.reconfigure(javascriptLanguage),
        });
    } else {
        view.dispatch({
            effects: languageComp.reconfigure(gema()),
        });
    }
}

/** Display error lines by highlighting them in the editor. */
let lastErrors = []; // last compilation errors, used to re-highlight on tab switch

function displayErrors(view, errors, files) {
    lastErrors = errors;
    const outputEl = document.getElementById("output");
    const errorText = errors
        .map((err) => {
            // Look up the source for the file this error belongs to
            const fileContent = err.filename && files[err.filename] ? files[err.filename] : "";
            const lines = fileContent.split("\n");
            const lineNum = err.line + 1;
            const context = lines[err.line] || "";
            const fileTag = err.filename ? ` in ${err.filename}` : "";
            return `Error${fileTag} at line ${lineNum}, column ${err.col + 1}: ${err.message}\n  ${lineNum} | ${context}\n  ${" ".repeat(String(lineNum).length + err.col + 3)}^`;
        })
        .join("\n\n");
    outputEl.innerText = errorText;
    outputEl.className = "output-panel output-error";

    highlightCurrentFileErrors(view);
}

/** Highlight error lines in the editor that belong to the currently active file. */
function highlightCurrentFileErrors(view) {
    view.dispatch({ effects: clearErrors.of(null) });

    const activeFile = currentFile();
    if (!activeFile) return;

    const fileErrors = lastErrors.filter(
        (err) => err.filename === activeFile.name || (!err.filename && openFiles.length === 1)
    );
    if (fileErrors.length === 0) return;

    const errorLines = fileErrors.map((e) => e.line);
    view.dispatch({ effects: addErrorLine.of(errorLines) });

    const firstErrorLine = Math.min(...errorLines);
    if (firstErrorLine >= 0 && firstErrorLine < view.state.doc.lines) {
        const line = view.state.doc.line(firstErrorLine + 1);
        view.dispatch({
            effects: EditorView.scrollIntoView(line.from, { y: "center" }),
        });
    }
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

    // Save current file content before compiling
    currentFile().content = view.state.doc.toString();

    // Collect all files
    const files = getFilesRecord();

    // Show running state
    outputEl.innerText = "Running...";
    outputEl.className = "output-panel";
    jsOutputEl.innerText = "";
    jsContent.classList.add("collapsed");
    runBtn.disabled = true;
    runBtn.textContent = "Running...";

    try {
        // Separate JS module files from gema files before compiling.
        // The compiler only processes .gema files; JS modules are handled at runtime
        // by the worker via ES module imports.
        const gemaFiles = {};
        const jsModules = {};
        for (const [name, content] of Object.entries(files)) {
            const ext = name.split(".").pop();
            if (ext === "js" || ext === "mjs") {
                jsModules[name] = content;
            } else {
                gemaFiles[name] = content;
            }
        }
        const hasJSImports = Object.keys(jsModules).length > 0;

        const compiled = compile(gemaFiles, hasJSImports ? "export" : "inline", "main.gema");

        if (compiled.errors && compiled.errors.length > 0) {
            displayErrors(view, compiled.errors, files);
            runBtn.disabled = false;
            runBtn.textContent = "Run (Ctrl+Enter)";
            return;
        }

        // Show compiled JS immediately
        jsOutputEl.innerText = compiled.js;
        jsContent.classList.remove("collapsed");

        // Step 2: Execute in a sandboxed Worker
        new Promise((resolve, reject) => {
            const worker = hasJSImports
                ? getJSModuleWorker(compiled.js, jsModules)
                : getWorker(compiled.js);
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
        const preset = PRESETS[select.value];
        if (!preset) return;
        const files = preset.files || { "main.gema": preset.code || "" };

        // Save current content and switch to preset files
        currentFile().content = view.state.doc.toString();
        loadPresetFiles(files, view);

        // Clear errors and output
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
