/* global self */

/**
 * Web Worker for sandboxed execution of compiled Gema JavaScript.
 *
 * This worker receives compiled JS code, evals it, and posts the result back.
 * eval() is safe here because Workers have no DOM access.
 */

self.onmessage = function (e) {
    const js = e.data.js;
    if (typeof js !== "string") {
        self.postMessage({ runtimeError: "No JS code provided to worker." });
        return;
    }

    try {
        const result = eval(js);
        // BigInt values can't be posted directly — convert to string
        self.postMessage({ result: String(result) });
    } catch (err) {
        self.postMessage({
            runtimeError: err instanceof Error ? err.message : String(err),
        });
    }
};
