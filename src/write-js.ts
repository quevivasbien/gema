import type * as AST from "./ast/index";
import { DropValue } from "./ast/expression";
import { Call, DirectCall } from "./ast/calls";
import {
    Block,
    If,
    ForLoop,
    Return,
    Continue,
    Break,
    AnonymousFunction,
    Function,
    Assignment,
} from "./ast/nodes";
import { BUILTINS } from "./builtins";

/**
 * Pre-pass that marks control flow nodes (Return/Continue/Break) with `needsException`.
 * A control flow node needs exception handling (throw sentinel) when it is inside
 * an IIFE — meaning there's an IIFE-wrapping Block or If-else between it and its
 * handler (the enclosing function for Return, the enclosing loop for Continue/Break).
 */
function markControlFlowExceptions(expr: AST.Expression, inIIFE: boolean): void {
    if (expr instanceof Return) {
        expr.needsException = inIIFE;
        // Still need to recurse into the return value for nested control flow
        markControlFlowExceptions(expr.value, inIIFE);
        return;
    }
    if (expr instanceof Continue || expr instanceof Break) {
        expr.needsException = inIIFE;
        return;
    }
    if (expr instanceof Block) {
        // Only creates IIFE context if the block's value is actually consumed
        const childInIIFE = inIIFE || (expr.isValueUsed && Block.lastExprShouldReturn(expr));
        for (const e of expr.expressions) {
            markControlFlowExceptions(e, childInIIFE);
        }
        return;
    }
    if (expr instanceof If) {
        // Only creates IIFE context if the if-else's value is actually consumed
        const childInIIFE = inIIFE || (expr.isValueUsed && expr.hasElse);
        for (const { branch } of expr.conditionalBranches) {
            markControlFlowExceptions(branch, childInIIFE);
        }
        markControlFlowExceptions(expr.elseBranch, childInIIFE);
        return;
    }
    if (expr instanceof ForLoop) {
        // Reset inIIFE for the loop body — break/continue inside nested
        // loops are handled by that loop, not ancestors.
        // Iterate body expressions directly WITHOUT applying lastExprShouldReturn,
        // because for-loop bodies don't use IIFE wrapping.
        for (const e of expr.body.expressions) {
            markControlFlowExceptions(e, false);
        }
        return;
    }
    if (expr instanceof AnonymousFunction || expr instanceof Function) {
        // Reset inIIFE for nested function bodies — return inside nested
        // functions is handled by that function, not ancestors.
        // Iterate body expressions directly WITHOUT applying lastExprShouldReturn,
        // because function bodies don't use IIFE wrapping.
        for (const e of (expr as AnonymousFunction | Function).body.expressions) {
            markControlFlowExceptions(e, false);
        }
        return;
    }
    // Handle other common child properties (DropValue.child, Unary.operand, Assignment.value, etc.)
    const singleChildKeys = ["child", "operand", "left", "right", "value"];
    for (const key of singleChildKeys) {
        const child = (expr as unknown as Record<string, unknown>)[key];
        if (child && typeof child === "object" && child.constructor?.name) {
            markControlFlowExceptions(child as AST.Expression, inIIFE);
        }
    }
    // Handle array children (expressions, args, items)
    const arrayChildKeys = ["expressions", "args", "items"];
    for (const key of arrayChildKeys) {
        const arr = (expr as unknown as Record<string, unknown>)[key];
        if (Array.isArray(arr)) {
            for (const child of arr) {
                if (child && typeof child === "object") {
                    markControlFlowExceptions(child as AST.Expression, inIIFE);
                }
            }
        }
    }
}

/**
 * Pre-pass that marks each expression with whether its value is consumed.
 * When a variable/block/if-else's value is never used, we can skip IIFE wrapping.
 */
function markValueUsed(expr: AST.Expression, valueUsed: boolean): void {
    expr.isValueUsed = valueUsed;

    // Block: last expression inherits block's value usage; non-last are discarded
    if (expr instanceof Block) {
        const exprs = expr.expressions;
        for (let i = 0; i < exprs.length - 1; i++) {
            markValueUsed(exprs[i], false);
        }
        if (exprs.length > 0) {
            markValueUsed(exprs[exprs.length - 1], valueUsed);
        }
        return;
    }
    // If: branches inherit the if-else's value usage
    if (expr instanceof If) {
        for (const { branch } of expr.conditionalBranches) {
            markValueUsed(branch, valueUsed);
        }
        markValueUsed(expr.elseBranch, valueUsed);
        return;
    }
    // ForLoop: body expressions are statements (values discarded)
    if (expr instanceof ForLoop) {
        for (const e of expr.body.expressions) {
            markValueUsed(e, false);
        }
        return;
    }
    // Assignment: the assigned value is always consumed (stored in the variable)
    if (expr instanceof Assignment) {
        markValueUsed(expr.value, true);
        return;
    }
    // DropValue: semicolon discards the child's value entirely
    if (expr instanceof DropValue) {
        markValueUsed(expr.child, false);
        return;
    }
    // Function / AnonymousFunction: non-last body expressions are discarded;
    // the last expression is the return value
    if (expr instanceof Function || expr instanceof AnonymousFunction) {
        const body = (expr as Function | AnonymousFunction).body;
        const exprs = body.expressions;
        for (let i = 0; i < exprs.length - 1; i++) {
            markValueUsed(exprs[i], false);
        }
        if (exprs.length > 0) {
            markValueUsed(exprs[exprs.length - 1], true); // function return value is always used
        }
        return;
    }
    // Call / DirectCall: arguments are always consumed by the function
    if (expr instanceof Call || expr instanceof DirectCall) {
        for (const arg of expr.args) {
            markValueUsed(arg, true);
        }
        return;
    }
    // Recurse into children for other expression types
    const singleChildKeys = ["value", "operand", "left", "right"];
    for (const key of singleChildKeys) {
        const child = (expr as unknown as Record<string, unknown>)[key];
        if (child && typeof child === "object" && child.constructor?.name) {
            markValueUsed(child as AST.Expression, valueUsed);
        }
    }
    const arrayChildKeys = ["args", "items", "expressions"];
    for (const key of arrayChildKeys) {
        const arr = (expr as unknown as Record<string, unknown>)[key];
        if (Array.isArray(arr)) {
            for (const child of arr) {
                if (child && typeof child === "object") {
                    markValueUsed(child as AST.Expression, valueUsed);
                }
            }
        }
    } // Keyword arguments — their values are always consumed
    const kwArgs = (expr as unknown as Record<string, unknown>).keywordArgs as
        | Array<{ name: string; value: AST.Expression }>
        | undefined;
    if (kwArgs) {
        for (const kw of kwArgs) {
            markValueUsed(kw.value, true);
        }
    }
}

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
        return safeJSName(name);
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

        let mainProgram = this.scope.lines.join("\n");
        // if we don't want to execute the program immediately (just define a main function, drop the final '()')
        if (mode !== "immediate") {
            mainProgram =
                `${mode == "export" ? "export " : ""}const main = ` +
                mainProgram.replace(/^\(/, "").replace(/\)\(\)$/g, ";");
        }

        return builtinFuncs + "// PROGRAM //\n" + mainProgram;
    }
}

export function writeJS(
    ast: AST.Expression,
    mode: "immediate" | "inline" | "export" = "immediate",
    minify: boolean = true
): string {
    // Pre-pass: mark which expression values are actually consumed (runs first,
    // since markControlFlowExceptions needs isValueUsed to determine IIFE context)
    markValueUsed(ast, true);
    // Pre-pass: mark which control flow nodes need exception handling
    markControlFlowExceptions(ast, false);
    const compiler = new JSWriter(ast);
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
