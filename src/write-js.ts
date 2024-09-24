import * as AST from "./ast";
import { BUILTINS } from "./builtins";

class Scope {
    parent: Scope | null;
    variableNames: Set<string> = new Set();

    constructor(parent: Scope | null = null) {
        this.parent = parent;
    }

    getDeclarations(): string[] {
        return Array.from(this.variableNames).map((name) => `var ${name};`);
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
        this.outputLines.push(this.currentLine);
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