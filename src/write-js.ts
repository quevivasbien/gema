import * as AST from "./ast";
import { BUILTINS } from "./builtins";

const INDENT = "    ";

class Scope {
    parent: Scope | null;
    variableNames: Set<string> = new Set();
    functionNames: Set<string> = new Set();

    lines: string[] = [];

    constructor(parent: Scope | null = null, public baseIndentLevel = 0) {
        this.parent = parent;
    }

    addFunctionName(name: string) {
        this.functionNames.add(name);
    }

    getDeclarations(): string[] {
        return Array.from(this.variableNames).map((name) => INDENT.repeat(this.baseIndentLevel) + `let ${name};`);
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
        const scopeLines  = this.scope.lines;
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

    beginFunction(name: string | null) {
        if (name !== null) {
            this.scope.addFunctionName(name);
        }
        this.beginScope();
    }

    endFunction() {
        this.endScope();
    }

    compile(): string {
        this.ast.toJS(this);
        this.newLine();

        const builtinFuncs = this.builtins.size === 0 ? "" : (
            "// BUILTINS //\n" +
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
            this.outputLines.join("\n") +
            this.scope.lines.join("\n")
        );
    }
}

export function writeJS(ast: AST.Expression): string {
    const compiler = new JSWriter(ast);
    return compiler.compile();
}