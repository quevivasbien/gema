import { scan } from "./scan";
import { parse } from "./parse";
import { writeJS } from "./write-js";
import { resetRegistries } from "./ast";

/**
 * Compile Gema source code to JavaScript.
 * Returns the compiled JS and any compile-time errors.
 * Does NOT execute the code — that's handled by the Web Worker.
 */
export function compile(
    source: string,
    mode: "immediate" | "inline" | "export",
    minify: boolean = true
) {
    resetRegistries();
    try {
        const tokens = scan(source);
        const { ast, errors } = parse(tokens);
        if (errors.length > 0) {
            return {
                js: "",
                result: null,
                errors: errors.map((e) => ({
                    line: e.line,
                    col: e.col,
                    message: e.message,
                })),
                runtimeError: null,
            };
        }
        const js = writeJS(ast, mode, minify);
        return { js, result: null, errors: [], runtimeError: null };
    } catch (e) {
        return {
            js: "",
            result: null,
            errors: [{ line: 0, col: 0, message: e instanceof Error ? e.message : String(e) }],
            runtimeError: null,
        };
    }
}
