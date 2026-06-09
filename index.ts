import { parse } from "./src/parse";
import { scan } from "./src/scan";
import { writeJS } from "./src/write-js";
import { resetRegistries } from "./src/ast";

export { parse, scan, writeJS };

export interface RawError {
    line: number;
    col: number;
    message: string;
}

export function compile(
    text: string
): { errors: null; js: string } | { errors: string[]; js: null } {
    const tokens = scan(text);
    const { ast, errors } = parse(tokens);
    if (errors.length > 0) {
        const textLines = text.split("\n");
        const errorMessages = errors.map((e) => {
            const messageParts = [];
            messageParts.push(`On line ${e.line + 1}, column ${e.col + 1}: ${e.message}`);
            if (e.line > 1) {
                messageParts.push(e.line - 1 + " |  " + textLines[e.line - 2]);
            }
            if (e.line > 0) {
                messageParts.push(e.line + " |  " + textLines[e.line - 1]);
            }
            messageParts.push(e.line + 1 + " |  " + textLines[e.line]);
            messageParts.push(
                "    " + " ".repeat(e.col.toString().length) + " ".repeat(e.col) + "^"
            );
            return "Encountered errors in parsing:\n" + messageParts.join("\n");
        });
        return { errors: errorMessages, js: null };
    }
    return { errors: null, js: writeJS(ast) };
}

/** Like compile() but returns raw structured error data for the frontend. */
export function compileWithRawErrors(text: string): {
    js: string;
    result: string | null;
    errors: { line: number; col: number; message: string }[];
    runtimeError: string | null;
} {
    resetRegistries();
    const tokens = scan(text);
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
    const js = writeJS(ast);
    try {
        const result = eval(js);
        return { js, result: String(result), errors: [], runtimeError: null };
    } catch (e: any) {
        return {
            js,
            result: null,
            errors: [],
            runtimeError: e instanceof Error ? e.message : String(e),
        };
    }
}
