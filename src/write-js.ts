import * as AST from "./ast";

export class JSWriter {
    ast: AST.Expression;
    outputLines: string[] = [];
    currentLine: string = "";
    indentLevel: number = 0;

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

    compile() {
        this.ast.toJS(this);
        this.newLine();
    }
}

export function writeJS(ast: AST.Expression): string {
    const compiler = new JSWriter(ast);
    compiler.compile();
    return compiler.outputLines.join("\n");
}