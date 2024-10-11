import { parse } from "./src/parse";
import { scan } from "./src/scan";
import { writeJS } from "./src/write-js";

export { parse, scan, writeJS };

export function compile(text: string): string {
    const tokens = scan(text);
    const { ast, errors } = parse(tokens);
    if (errors.length > 0) {
        const textLines = text.split("\n");
        console.log("Encountered error(s) in parsing:");
        errors.forEach((e) => {
            console.log(`On line ${e.line + 1}, column ${e.col + 1}: ${e.message}`);
            if (e.line > 1) {
                console.log((e.line - 1) + " |  " + textLines[e.line - 2]);
            }
            if (e.line > 0) {
                console.log(e.line + " |  " + textLines[e.line - 1]);
            }
            console.log((e.line + 1) + " |  " + textLines[e.line]);
            console.log("    " + " ".repeat(e.col.toString().length) + " ".repeat(e.col) + "^");
        });
        return "";
    }
    return writeJS(ast);
}
