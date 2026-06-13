import type * as AST from "./ast/index";
import { BUILTINS } from "./builtins";

const INDENT = "    ";

// JavaScript reserved words that cannot be used as variable/function/parameter names
const JS_RESERVED_WORDS = new Set([
    "const",
    "let",
    "var",
    "function",
    "class",
    "new",
    "this",
    "super",
    "if",
    "else",
    "for",
    "while",
    "do",
    "switch",
    "case",
    "default",
    "break",
    "continue",
    "return",
    "throw",
    "try",
    "catch",
    "finally",
    "typeof",
    "void",
    "delete",
    "import",
    "export",
    "yield",
    "async",
    "await",
    "in",
    "of",
    "instanceof",
    "true",
    "false",
    "null",
    "undefined",
    "NaN",
    "Infinity",
    "arguments",
    "eval",
]);

/** Map a name to a safe JS identifier if it conflicts with a reserved word. */
export function safeJSName(name: string): string {
    // Handle mangled names like "foo$Int$Int" — only check the base name part
    const dollarIdx = name.indexOf("$");
    const baseName = dollarIdx === -1 ? name : name.slice(0, dollarIdx);
    if (JS_RESERVED_WORDS.has(baseName)) {
        const suffix = dollarIdx === -1 ? "" : name.slice(dollarIdx);
        return `$${baseName}${suffix}`;
    }
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
            (name) => INDENT.repeat(this.baseIndentLevel) + `let ${safeJSName(name)};`
        );
    }
}

export class JSWriter {
    ast: AST.Expression;
    outputLines: string[] = [];
    currentLine: string = "";
    indentLevel: number = 0;
    scope: Scope = new Scope();
    builtins: Set<string> = new Set();
    nextUniqueId: number = 0;

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
        return safeJSName(name);
    }

    declareVariable(name: string) {
        this.scope.variableNames.add(name);
    }

    useBuiltin(name: string) {
        this.builtins.add(name);
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

    compile(): string {
        this.ast.toJS(this);
        this.newLine();

        const builtinFuncs =
            this.builtins.size === 0
                ? ""
                : "// BUILTINS //\n" +
                  Array.from(this.builtins)
                      .map((name) => BUILTINS[name])
                      .join("\n") +
                  "\n\n";

        const globals = this.scope.getDeclarations();
        const globalVarDeclarations =
            globals.length === 0 ? "" : "// GLOBAL VARIABLES //\n" + globals.join("\n") + "\n\n";

        return (
            builtinFuncs +
            globalVarDeclarations +
            "// PROGRAM //\n" +
            this.outputLines.join("\n") +
            this.scope.lines.join("\n")
        );
    }
}

export function writeJS(ast: AST.Expression, minify: boolean = true): string {
    const compiler = new JSWriter(ast);
    let compiled = compiler.compile();
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
            .join("\n");
    }
    return compiled;
}
