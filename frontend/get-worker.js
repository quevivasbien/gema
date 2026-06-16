export function getWorker(js) {
    const workerPayload = `${js}
function safeStringify(value, seen = new Set()) {
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
    if (seen.has(value)) return "[Circular Reference]";
    seen.add(value);
    if (Array.isArray(value)) {
        const elements = value.map(item => safeStringify(item, seen));
        return \`[\${elements.join(", ")}]\`;
    }
    try {
        const keys = Object.keys(value);
        if (keys.length === 0) return "{}";
        const properties = keys.map(key => {
            return \`"\${key}": \${safeStringify(value[key], seen)}\`;
        });
        return \`{ \${properties.join(", ")} }\`;
    } catch (e) {
        return \`[Object \${value.constructor ? value.constructor.name : "Unknown"}]\`;
    }
}
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
