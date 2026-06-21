import { scan } from "./scan";
import { parse } from "./parse";
import { writeJSModule, writeJSWithBuiltins, JSWriter } from "./write-js";
import { BUILTINS } from "./builtins";
import { TokenType } from "./tokens";
import { resetRegistries, registerModuleVar, getAllMonomorphized } from "./ast";
import { Block } from "./ast/nodes";
import { Assignment } from "./ast/nodes";
import { DropValue } from "./ast/expression";

interface CompileResult {
    js: string;
    result: null;
    errors: { line: number; col: number; message: string; filename?: string }[];
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
 * Returns the JS code and the set of builtin function names used.
 */
function compileModule(
    filename: string,
    files: Record<string, string>,
    visiting: Set<string>,
    visited: Set<string>,
    errors: { line: number; col: number; message: string; filename?: string }[]
): { code: string; builtins: Set<string> } | null {
    if (visited.has(filename)) return { code: "", builtins: new Set() };
    if (visiting.has(filename)) {
        errors.push({
            line: 0,
            col: 0,
            message: `Circular dependency detected: module '${filename}' is already being compiled.`,
            filename,
        });
        return null;
    }

    const source = files[filename];
    if (source === undefined) {
        errors.push({
            line: 0,
            col: 0,
            message: `Module '${filename}' not found. Make sure it is included in the provided files.`,
            filename,
        });
        return null;
    }

    visiting.add(filename);

    // Recursively compile dependencies first
    const usePaths = collectUseDirectives(source);
    const depCode: string[] = [];
    const allBuiltins = new Set<string>();
    for (const depPath of usePaths) {
        const depResult = compileModule(depPath, files, visiting, visited, errors);
        if (depResult === null) return null; // error propagated
        if (depResult.code !== "") depCode.push(depResult.code);
        for (const b of depResult.builtins) allBuiltins.add(b);
    }

    // Compile this module (allow Null type for definition-only modules)
    const tokens = scan(source);
    const { ast, errors: parseErrors } = parse(tokens, true);
    if (parseErrors.length > 0) {
        for (const e of parseErrors) {
            errors.push({ line: e.line, col: e.col, message: e.message, filename });
        }
        return null;
    }
    let js: string;
    let moduleBuiltins: Set<string>;
    try {
        const result = writeJSModule(ast, true);
        js = result.code;
        moduleBuiltins = result.builtins;
    } catch (e) {
        errors.push({
            line: 0,
            col: 0,
            message: e instanceof Error ? e.message : String(e),
            filename,
        });
        return null;
    }

    // Collect this module's builtins
    for (const b of moduleBuiltins) allBuiltins.add(b);

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
    const allCode = [...depCode, js].filter(Boolean).join("\n");
    return { code: allCode, builtins: allBuiltins };
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

    const errors: { line: number; col: number; message: string; filename?: string }[] = [];

    try {
        const entrySource = files[entry];
        if (entrySource === undefined) {
            return {
                js: "",
                result: null,
                errors: [
                    {
                        line: 0,
                        col: 0,
                        message: `Entry file '${entry}' not found.`,
                        filename: entry,
                    },
                ],
                runtimeError: null,
            };
        }

        // Phase 1: Resolve and compile all dependency modules
        const visiting = new Set<string>();
        const visited = new Set<string>();
        const usePaths = collectUseDirectives(entrySource);
        const moduleResults: { code: string; builtins: Set<string> }[] = [];
        for (const depPath of usePaths) {
            const depResult = compileModule(depPath, files, visiting, visited, errors);
            if (depResult === null) break; // error occurred
            if (depResult.code !== "") moduleResults.push(depResult);
        }

        if (errors.length > 0) {
            return { js: "", result: null, errors, runtimeError: null };
        }

        // Phase 2: Compile the entry file
        const tokens = scan(entrySource);
        const { ast, errors: parseErrors } = parse(tokens);
        if (parseErrors.length > 0) {
            for (const e of parseErrors) {
                errors.push({ line: e.line, col: e.col, message: e.message, filename: entry });
            }
            return { js: "", result: null, errors, runtimeError: null };
        }

        const entryResult = writeJSWithBuiltins(ast, mode);
        const entryCode = entryResult.code;
        const entryBuiltins = entryResult.builtins;

        // Phase 3: Collect any monomorphized functions created during entry compilation
        // that originated from module generics. Emit them before the entry code.
        let monoCode = "";
        const allBuiltins = new Set(entryBuiltins);
        const allMonomorphized = getAllMonomorphized();
        if (allMonomorphized.size > 0) {
            const monoWriter = new JSWriter(ast);
            for (const [, fn] of allMonomorphized) {
                if (fn.isGeneric) continue;
                fn.toJS(monoWriter);
                monoWriter.write(";");
                monoWriter.newLine();
            }
            for (const line of monoWriter.scope.lines) {
                if (line.trim()) monoCode += line + "\n";
            }
            for (const b of monoWriter.builtins) allBuiltins.add(b);
        }

        // Merge builtins from all modules
        for (const mod of moduleResults) {
            for (const b of mod.builtins) allBuiltins.add(b);
        }

        const builtinSection =
            allBuiltins.size === 0
                ? ""
                : "// BUILTINS //\n" +
                  Array.from(allBuiltins)
                      .map((name) => BUILTINS[name])
                      .join("\n") +
                  "\n\n";

        // Phase 5: Concatenate — builtins + module code + monomorphized code + entry code
        const moduleCode = moduleResults
            .map((m) => m.code)
            .filter(Boolean)
            .join("\n");
        const programMarker = "// PROGRAM //";
        const programIdx = entryCode.indexOf(programMarker);
        if (programIdx !== -1) {
            const afterProgram = entryCode.slice(programIdx + programMarker.length);
            const js =
                builtinSection + "// PROGRAM //\n" + moduleCode + "\n" + monoCode + afterProgram;
            return { js, result: null, errors: [], runtimeError: null };
        }

        // Fallback for unusual output formats
        const js = builtinSection + "// PROGRAM //\n" + moduleCode + "\n" + entryCode;
        return { js, result: null, errors: [], runtimeError: null };
    } catch (e) {
        return {
            js: "",
            result: null,
            errors: [
                {
                    line: 0,
                    col: 0,
                    message: e instanceof Error ? e.message : String(e),
                    filename: entry,
                },
            ],
            runtimeError: null,
        };
    }
}
