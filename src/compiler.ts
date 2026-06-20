import { scan } from "./scan";
import { parse } from "./parse";
import { writeJS, writeJSModule } from "./write-js";
import { TokenType } from "./tokens";
import { resetRegistries, registerModuleVar } from "./ast";
import { Block } from "./ast/nodes";
import { Assignment } from "./ast/nodes";
import { DropValue } from "./ast/expression";

interface CompileResult {
    js: string;
    result: null;
    errors: { line: number; col: number; message: string }[];
    runtimeError: null;
}

/**
 * Collect the list of module paths referenced by `use "..."` directives
 * in a source file, by scanning tokens (no full parse needed).
 */
function collectUseDirectives(source: string): string[] {
    const tokens = scan(source);
    const paths: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].type === TokenType.Use) {
            // Next token should be a string literal
            if (i + 1 < tokens.length && tokens[i + 1].type === TokenType.String) {
                let path = tokens[i + 1].text;
                // Strip surrounding quotes from string literal
                if (path.length >= 2 && path.startsWith('"') && path.endsWith('"')) {
                    path = path.slice(1, -1);
                }
                paths.push(path);
                i++; // skip the string token
            }
        }
    }
    return paths;
}

/**
 * Compile a single module file — populates registries but produces raw JS
 * without IIFE wrapping (so its declarations are in scope for the entry file).
 */
function compileModule(
    filename: string,
    files: Record<string, string>,
    visiting: Set<string>,
    visited: Set<string>,
    errors: { line: number; col: number; message: string }[]
): string | null {
    if (visited.has(filename)) return ""; // already compiled
    if (visiting.has(filename)) {
        errors.push({
            line: 0,
            col: 0,
            message: `Circular dependency detected: module '${filename}' is already being compiled.`,
        });
        return null;
    }

    const source = files[filename];
    if (source === undefined) {
        errors.push({
            line: 0,
            col: 0,
            message: `Module '${filename}' not found. Make sure it is included in the provided files.`,
        });
        return null;
    }

    visiting.add(filename);

    // Recursively compile dependencies first
    const usePaths = collectUseDirectives(source);
    const moduleJSs: string[] = [];
    for (const depPath of usePaths) {
        const depJS = compileModule(depPath, files, visiting, visited, errors);
        if (depJS === null) return null; // error propagated
        if (depJS !== "") moduleJSs.push(depJS);
    }

    // Compile this module (allow Null type for definition-only modules)
    const tokens = scan(source);
    const { ast, errors: parseErrors } = parse(tokens, true);
    if (parseErrors.length > 0) {
        for (const e of parseErrors) {
            errors.push({ line: e.line, col: e.col, message: e.message });
        }
        return null;
    }
    let js: string;
    try {
        js = writeJSModule(ast, true);
    } catch (e) {
        errors.push({
            line: 0,
            col: 0,
            message: e instanceof Error ? e.message : String(e),
        });
        return null;
    }

    // Register module-level variable names so importing files can resolve their types
    if (ast instanceof Block) {
        for (const expr of ast.expressions) {
            let e = expr;
            while (e instanceof DropValue) e = e.child;
            if (e instanceof Assignment && e.name && e.value.type) {
                registerModuleVar(e.name, e.value.type);
            }
        }
    }

    visiting.delete(filename);
    visited.add(filename);

    // Concat dependency JS before this module's JS
    const allJS = [...moduleJSs, js].filter(Boolean).join("\n");
    return allJS;
}

/**
 * Compile Gema source code to JavaScript.
 *
 * Single-file mode (backwards compatible):
 *   compile(source: string, mode, minify?)
 *
 * Multi-file mode:
 *   compile(files: Record<string, string>, mode, entry?, minify?)
 *
 * Returns the compiled JS and any compile-time errors.
 */
export function compile(
    filesOrSource: Record<string, string> | string,
    mode: "immediate" | "inline" | "export" = "immediate",
    entry?: string
): CompileResult {
    // Normalize arguments
    let files: Record<string, string>;

    if (typeof filesOrSource === "string") {
        // Single-file mode: compile(source, mode, minify)
        files = { "main.gema": filesOrSource };
        entry = "main.gema";
    } else {
        // Multi-file mode: compile(files, mode, entry?)
        files = filesOrSource;
        entry = entry ?? "main.gema";
    }

    resetRegistries();

    const errors: { line: number; col: number; message: string }[] = [];

    try {
        const entrySource = files[entry];
        if (entrySource === undefined) {
            return {
                js: "",
                result: null,
                errors: [{ line: 0, col: 0, message: `Entry file '${entry}' not found.` }],
                runtimeError: null,
            };
        }

        // Phase 1: Resolve and compile all dependency modules
        const visiting = new Set<string>();
        const visited = new Set<string>();
        const usePaths = collectUseDirectives(entrySource);
        const moduleJSs: string[] = [];
        for (const depPath of usePaths) {
            const depJS = compileModule(depPath, files, visiting, visited, errors);
            if (depJS === null) break; // error occurred
            if (depJS !== "") moduleJSs.push(depJS);
        }

        if (errors.length > 0) {
            return { js: "", result: null, errors, runtimeError: null };
        }

        // Phase 2: Compile the entry file
        const tokens = scan(entrySource);
        const { ast, errors: parseErrors } = parse(tokens);
        if (parseErrors.length > 0) {
            for (const e of parseErrors) {
                errors.push({ line: e.line, col: e.col, message: e.message });
            }
            return { js: "", result: null, errors, runtimeError: null };
        }

        const entryJS = writeJS(ast, mode);

        // Phase 3: Concatenate — builtins come from the entry's writeJS output,
        // module JS is injected before the PROGRAM section
        const moduleBlock = moduleJSs.length > 0 ? moduleJSs.join("\n") + "\n" : "";
        const programMarker = "// PROGRAM //";
        const programIdx = entryJS.indexOf(programMarker);
        if (programIdx !== -1) {
            // Insert module JS after the PROGRAM marker
            const before = entryJS.slice(0, programIdx + programMarker.length);
            const after = entryJS.slice(programIdx + programMarker.length);
            const js = before + "\n" + moduleBlock + after;
            return { js, result: null, errors: [], runtimeError: null };
        }

        return { js: entryJS, result: null, errors: [], runtimeError: null };
    } catch (e) {
        return {
            js: "",
            result: null,
            errors: [{ line: 0, col: 0, message: e instanceof Error ? e.message : String(e) }],
            runtimeError: null,
        };
    }
}
