import type * as AST from "./ast/index";
import { BUILTINS } from "./builtins";

const INDENT = "    ";

// Rust reserved words that cannot be used as variable/function/parameter names
const RUST_RESERVED_WORDS = new Set([
    "fn", // todo: actually add the full list here
]);

/** Map a name to a safe Rust identifier if it conflicts with a reserved word. */
export function safeRustName(name: string): string {
    // TODO: Actually implement this!
    return name;
}

class Scope {
    parent: Scope | null;
    variableNames: Set<string> = new Set();

    lines: string[] = [];

    constructor(
        parent: Scope | null = null,
        public baseIndentLevel = 0
    ) {
        this.parent = parent;
    }

    getDeclarations(): string[] {
        return Array.from(this.variableNames).map(
            // TODO: This method won't work in rust since we need to initialize variables with a value.
            (name) => INDENT.repeat(this.baseIndentLevel) + `let ${safeRustName(name)};`
        );
    }
}

export class RustWriter {
    ast: AST.Expression;
    currentLine: string = "";
    indentLevel: number = 0;
    scope: Scope = new Scope();
    builtins: Set<string> = new Set();
    nextUniqueId: number = 0;
    /** Depth of IIFE nesting — incremented when entering an IIFE-wrapping Block or If */
    iifeDepth: number = 0;

    constructor(ast: AST.Expression) {
        this.ast = ast;
    }

    uniqueName(prefix: string): string {
        return `${prefix}${this.nextUniqueId++}`;
    }

    newLine() {
        this.scope.lines.push(this.currentLine);
        this.currentLine = INDENT.repeat(this.indentLevel);
    }

    write(text: string) {
        this.currentLine += text;
    }

    indentIn() {
        this.indentLevel += 1;
    }

    indentOut() {
        this.indentLevel -= 1;
    }

    safeName(name: string): string {
        return safeRustName(name);
    }

    declareVariable(name: string) {
        this.scope.variableNames.add(name);
    }

    useBuiltin(name: string) {
        this.builtins.add(name);
    }

    /** Check whether the current codegen position is inside an IIFE */
    isInsideIIFE(): boolean {
        return this.iifeDepth > 0;
    }

    beginScope() {
        this.write("{");
        this.indentIn();
        this.newLine();
        this.scope = new Scope(this.scope, this.indentLevel);
    }

    endScope() {
        if (this.scope.parent === null) {
            throw new Error("Tried to exit top-level scope");
        }
        const varDeclarations = this.scope.getDeclarations();
        const scopeLines = this.scope.lines;
        this.scope = this.scope.parent;
        this.scope.lines.push(...varDeclarations, ...scopeLines);
        this.indentOut();
        if (/^\s*$/.test(this.currentLine)) {
            this.currentLine = INDENT.repeat(this.indentLevel);
        } else {
            this.newLine();
        }
        this.write("}");
    }

    beginFunction() {
        this.beginScope();
    }

    endFunction() {
        this.endScope();
    }

    compile(mode: "immediate" | "inline" | "export"): string {
        this.ast.toRust(this);
        this.newLine();

        const builtinFuncs =
            this.builtins.size === 0
                ? ""
                : "// BUILTINS //\n" +
                  Array.from(this.builtins)
                      .map((name) => BUILTINS[name])
                      .join("\n") +
                  "\n\n";

        let mainProgram =
            "fn main() { let result = " + this.scope.lines.join("\n") + `; println!("{}", result)}`;
        // TODO: Handle different modes

        return builtinFuncs + "// PROGRAM //\n" + mainProgram;
    }
}

export function writeRust(
    ast: AST.Expression,
    mode: "immediate" | "inline" | "export" = "immediate",
    minify: boolean = true
): string {
    const compiler = new RustWriter(ast);
    let compiled = compiler.compile(mode);
    if (minify) {
        compiled = compiled
            .split("\n")
            .filter((line) => {
                const trimmed = line.trim();
                // Remove lines that are only semicolons (with optional whitespace)
                if (/^;+$/.test(trimmed)) return false;
                // Remove completely empty lines
                if (trimmed === "") return false;
                return true;
            })
            // Remove duplicated semicolons
            .map((line) => line.replaceAll(/;+/g, ";"))
            .join("\n");
    }
    return compiled;
}
