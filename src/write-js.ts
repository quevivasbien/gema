import * as AST from "./ast";

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

    compile(): string {
        this.ast.toJS(this);
        this.newLine();

        return (
            this.scope.getDeclarations().join("\n") +
            "\n" +
            this.outputLines.join("\n")
        );
    }
}

export function writeJS(ast: AST.Expression): string {
    const compiler = new JSWriter(ast);
    return compiler.compile();
}