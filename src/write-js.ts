import * as AST from "./ast";
import { BUILTINS } from "./builtins";

class Scope {
    parent: Scope | null;
    variableNames: Set<string> = new Set();
    functionNames: Set<string> = new Set();

    lines: string[] = [];

    constructor(parent: Scope | null = null, public baseIndentLevel = 0) {
        this.parent = parent;
    }

    addFunctionName(name: string) {
        if (this.functionNames.has(name)) {
            throw new Error(`Duplicate function definition`);
        }
        this.functionNames.add(name);
    }

    getDeclarations(): string[] {
        return Array.from(this.variableNames).map((name) => "    ".repeat(this.baseIndentLevel) + `let ${name};`);
    }
}

export class JSWriter {
    ast: AST.Expression;
    outputLines: string[] = [];
    currentLine: string = "";
    indentLevel: number = 0;
    scope: Scope = new Scope();
    builtins: Set<string> = new Set();

    constructor(ast: AST.Expression) {
        this.ast = ast;
    }

    newLine() {
        this.scope.lines.push(this.currentLine);
        this.currentLine = "    ".repeat(this.indentLevel);
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

    declareVariable(name: string) {
        this.scope.variableNames.add(name);
    }

    useBuiltin(name: string) {
        this.builtins.add(name);
    }

    beginScope() {
        this.scope = new Scope(this.scope, this.indentLevel);
    }

    endScope() {
        if (this.scope.parent === null) {
            throw new Error("Tried to exit top-level scope");
        }
        const varDeclarations = this.scope.getDeclarations();
        this.outputLines.push(...varDeclarations, ...this.scope.lines);
        this.scope = this.scope.parent;
    }

    beginFunction(name: string) {
        this.scope.addFunctionName(name);
        this.beginScope();
    }

    endFunction() {
        this.endScope();
    }

    compile(): string {
        this.ast.toJS(this);
        this.newLine();

        const builtinFuncs = this.builtins.size === 0 ? "" : (
            "// BUILTIN FUNCTIONS //\n" +
            Array.from(this.builtins).map(
                (name) => BUILTINS[name]
            ).join("\n") +
            "\n\n"
        );

        const globals = this.scope.getDeclarations();
        const globalVarDeclarations = globals.length === 0 ? "" : (
            "// GLOBAL VARIABLES //\n" +
            globals.join("\n") +
            "\n\n"
        );

        return (
            builtinFuncs +
            globalVarDeclarations +
            "// PROGRAM //\n" +
            this.outputLines.join("\n")
        );
    }
}

export function writeJS(ast: AST.Expression): string {
    const compiler = new JSWriter(ast);
    return compiler.compile();
}