const SAFE_STRINGIFY = `
function safeStringify(value) {
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    const type = typeof value;
    if (type === "string") return value;
    if (type === "number" || type === "boolean" || type === "bigint" || type === "symbol")
        return value.toString();
    if (type === "function") {
        const name = value.name ? \` \${value.name}\` : " (anonymous)";
        return \`[Function\${name}]\`;
    }
    if (Array.isArray(value)) {
        const elements = value.map(item => safeStringify(item));
        return \`[\${elements.join(", ")}]\`;
    }
    try {
        const keys = Object.keys(value);
        if (keys.length === 0) return "{}";
        const properties = keys.map(key => {
            return \`"\${key}": \${safeStringify(value[key])}\`;
        });
        return \`{ \${properties.join(", ")} }\`;
    } catch (e) {
        return \`[Object \${value.constructor ? value.constructor.name : "Unknown"}]\`;
    }
}
`;

/**
 * Create a classic worker from compiled JS (no imports).
 * The compiled JS must define a `main` function that returns the result value.
 */
export function getWorker(js) {
    const workerPayload = `${js}
${SAFE_STRINGIFY}
try {
    const result = safeStringify(main());
    if (typeof postMessage !== 'undefined') {
        postMessage({ status: 'success', data: result });
    }
} catch (err) {
    if (typeof postMessage !== 'undefined') {
        postMessage({ status: 'error', data: err.message });
    }
}`;
    const blob = new Blob([workerPayload], { type: "application/javascript" });
    const workerURL = URL.createObjectURL(blob);
    return new Worker(workerURL);
}

/**
 * Create a module worker for compiled code that imports from JS modules.
 * `compiledJS` should be compiled in "export" mode (contains export const main = ...).
 * `jsModules` is a Record<string, string> mapping filenames to source content.
 *
 * Creates blob URLs for each JS module, rewrites import paths in the compiled
 * output, then creates a module worker that imports and runs the compiled code.
 */
export function getJSModuleWorker(compiledJS, jsModules = {}) {
    // 1. Create blob URLs for each JS dependency module file
    const moduleBlobURLs = {};
    for (const [filename, content] of Object.entries(jsModules)) {
        const blob = new Blob([content], { type: "application/javascript" });
        moduleBlobURLs[filename] = URL.createObjectURL(blob);
    }

    // 2. Rewrite import paths in compiled JS to point to blob URLs
    let processedJS = compiledJS;
    for (const [filename, blobURL] of Object.entries(moduleBlobURLs)) {
        const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(`from\\s+["'](?:\\./)?${escaped}["']`, "g");
        processedJS = processedJS.replace(regex, `from "${blobURL}"`);
    }

    // 3. Inject the execution harness wrapper inside the entry point code string
    const completeWorkerCode = `
${SAFE_STRINGIFY}
try {
    const moduleURL = "${URL.createObjectURL(new Blob([processedJS], { type: "application/javascript" }))}";
    const exports = await import(moduleURL);
    const targetFn = exports.main || exports.default || (() => {});
    const result = safeStringify(targetFn());
    if (typeof postMessage !== 'undefined') {
        postMessage({ status: 'success', data: result });
    }
} catch (err) {
    if (typeof postMessage !== 'undefined') {
        postMessage({ status: 'error', data: err.message });
    }
}
`;

    // 4. Spin up the single-file self-contained ES module worker context
    const workerBlob = new Blob([completeWorkerCode], { type: "application/javascript" });
    const workerURL = URL.createObjectURL(workerBlob);

    return new Worker(workerURL, { type: "module" });
}
