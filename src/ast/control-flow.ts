import { TokenType, type Token } from "../tokens";
import type { JSWriter } from "../write-js";
import { Block, Expression, lastExprShouldReturn } from "./expression";
import { Scope } from "./scope";
import { deepEquals } from "./type-utils";
import { ArrayType, IterType, MutArrType, type Type } from "./types";

export class If extends Expression {
    // TODO: Parser shuold reflect that any Expression type is permissible for the branches
    conditionalBranches: { condition: Expression; branch: Expression }[];
    elseBranch: Expression; // TODO: Shouldn't this be optional?
    hasElse: boolean;

    constructor(
        rootToken: Token,
        conditionalBranches: { condition: Expression; branch: Expression }[],
        elseBranch: Expression,
        hasElse: boolean = true
    ) {
        super(rootToken.line, rootToken.col);

        this.conditionalBranches = conditionalBranches;
        this.elseBranch = elseBranch;
        this.hasElse = hasElse;
    }

    getAllChildren(): Expression[] {
        return [
            ...this.conditionalBranches.map((b) => b.condition),
            ...this.conditionalBranches.map((b) => b.branch),
            this.elseBranch,
        ];
    }

    cascadeTypes(parent: Expression | null, valueUsed: boolean): void {
        super.cascadeTypes(parent, valueUsed);
        this.elseBranch.cascadeTypes(this, valueUsed);

        this.conditionalBranches.forEach(({ condition, branch }) => {
            condition.cascadeTypes(this, true);
            if (condition.type !== "Bool") {
                throw this.error(`condition must be boolean, but found ${condition.type}`);
            }
            branch.cascadeTypes(this, valueUsed);
            if (this.hasElse) {
                if (!deepEquals(this.elseBranch.type, branch.type)) {
                    throw this.error(
                        `all branches of if expression must have the same type, but found branches of types ${branch.type} and ${this.elseBranch.type}`
                    );
                }
            }
        });

        // Determine the type from branches (control flow branches still carry their
        // inner value's type via Return/Continue's transparent type propagation)
        this.type = this.hasElse ? this.elseBranch.type : "Null";
    }

    clone(bindings?: Map<string, Type>): Expression {
        const cloned = new If(
            { line: this.line, col: this.col, text: "if", type: TokenType.If },
            this.conditionalBranches.map(({ condition, branch }) => ({
                condition: condition.clone(bindings),
                branch: branch.clone(bindings),
            })),
            this.elseBranch.clone(bindings),
            this.hasElse
        );
        return cloned;
    }

    private branchToJS(writer: JSWriter, branch: Expression) {
        writer.beginScope();
        if (branch instanceof Block) {
            // Branch is a block containing a sequence of expressions
            // Here we override the typical Block compilation to provide a bit terser syntax
            branch.expressions.forEach((expr, i) => {
                if (i === branch.expressions.length - 1 && lastExprShouldReturn(expr)) {
                    writer.write("return ");
                }
                expr.toJS(writer);
                writer.write(";");
                writer.newLine();
            });
        } else {
            // Branch contains a single expression
            if (branch.type !== "Null") {
                writer.write("return ");
            }
            branch.toJS(writer);
            writer.write(";");
            writer.newLine();
        }
        writer.endScope();
    }

    toJS(writer: JSWriter): void {
        const shouldWrapInIIFE = this.hasElse && this.isValueUsed;
        if (shouldWrapInIIFE) {
            writer.write("(() => {");
            writer.iifeDepth++;
            writer.indentIn();
            writer.newLine();
        }
        this.conditionalBranches.forEach(({ condition, branch }) => {
            writer.write("if (");
            condition.toJS(writer);
            writer.write(") ");
            this.branchToJS(writer, branch);
            writer.write(" else ");
        });
        this.branchToJS(writer, this.elseBranch);
        if (shouldWrapInIIFE) {
            writer.indentOut();
            writer.newLine();
            writer.iifeDepth--;
            writer.write("})()");
        }
    }
}

export class ForLoop extends Expression {
    scope: Scope = new Scope();

    getScope(): Scope | null {
        return this.scope;
    }

    isLoopBoundary(): boolean {
        return true;
    }

    getLoopVariableName(): string | null {
        return this.varName;
    }

    getLoopVariableInnerType(): Type | null {
        if (this.iter === null || this.iter.type === null) return null;
        if (this.iter.type instanceof ArrayType) return this.iter.type.innerType;
        if (this.iter.type instanceof IterType) return this.iter.type.innerType;
        if (this.iter.type instanceof MutArrType) return this.iter.type.innerType;
        if (this.iter.type === "Str") return "Str";
        return null;
    }

    // TODO: Parser should reflect that any Expression type is permissible for the body
    varName: string | null;
    iter: Expression | null;
    body: Expression;

    constructor(
        startToken: Token,
        varName: string | null,
        iter: Expression | null,
        body: Expression
    ) {
        super(startToken.line, startToken.col);
        this.varName = varName;
        this.iter = iter;
        this.body = body;
        this.type = "Null";
    }

    cascadeTypes(parent: Expression | null, valueUsed: boolean): void {
        super.cascadeTypes(parent, valueUsed);
        if (this.iter !== null) {
            this.iter.cascadeTypes(this, true);
            if (this.iter.type === null) {
                throw this.error("unable to resolve type of iterator");
            }
            // We don't need to save the iter type, but we do need to check that it's valid to iterate over
            if (
                !(
                    this.iter.type instanceof ArrayType ||
                    this.iter.type instanceof IterType ||
                    this.iter.type instanceof MutArrType
                )
            ) {
                throw this.error(`cannot iterate over object of type ${this.iter.type}`);
            }

            // Chain this for loop's scope to the enclosing scope so lookups
            // from inside the loop body can find outer variables (e.g. accumulators).
            if (this.parent && this.scope.parent === null) {
                this.scope.parent = this.parent.getScope();
            }

            // Register the loop variable in this for loop's scope.
            if (this.varName !== null) {
                const innerType = this.getLoopVariableInnerType() ?? "Int";
                this.scope.defineVariable({
                    class: "var",
                    name: this.varName,
                    type: innerType,
                    isMutable: true, // loop variables are implicitly mutable (reassigned each iteration)
                });
            }
        }
        // Chain the body scope (if it has one) to this for loop's scope
        const bodyScope = this.body.getScope();
        if (bodyScope !== null) {
            bodyScope.parent = this.scope;
        }
        // For loop will always have "Null" type, but we still need to cascade the types
        // for the body to make sure it's valid.
        this.body.cascadeTypes(this, false);
    }

    clone(bindings?: Map<string, Type>): Expression {
        return new ForLoop(
            { line: this.line, col: this.col, text: "for", type: TokenType.For },
            this.varName,
            this.iter !== null ? this.iter.clone(bindings) : null,
            this.body.clone(bindings)
        );
    }

    /** Walk the body subtree to check if any Break/Continue needs exception handling. */
    private static bodyNeedsException(expr: Expression): boolean {
        if (expr.needsExceptionForControlFlow()) return true;
        if (expr.isLoopBoundary()) return false; // break/continue in nested loops are handled by that loop
        return expr.getAllChildren().some((e) => ForLoop.bodyNeedsException(e));
    }

    private innerLoopToJS(writer: JSWriter) {
        const childExprs = this.body instanceof Block ? this.body.expressions : null;
        const needsTry =
            childExprs === null
                ? ForLoop.bodyNeedsException(this.body)
                : childExprs.some((e) => ForLoop.bodyNeedsException(e));
        if (needsTry) {
            writer.useBuiltin("$Continue$");
            writer.useBuiltin("$Break$");
            writer.write("try {");
            writer.indentIn();
            writer.newLine();
        }
        if (childExprs === null) {
            // Single-expression body
            this.body.toJS(writer);
            writer.write(";");
            writer.newLine();
        } else {
            childExprs.forEach((expr) => {
                expr.toJS(writer);
                writer.write(";");
                writer.newLine();
            });
        }
        if (needsTry) {
            writer.indentOut();
            writer.newLine();
            writer.write("} catch (e$$) {");
            writer.indentIn();
            writer.newLine();
            writer.write("if (e$$ instanceof $Continue$) { continue; }");
            writer.newLine();
            writer.write("if (e$$ instanceof $Break$) { break; }");
            writer.newLine();
            writer.write("throw e$$;");
            writer.indentOut();
            writer.newLine();
            writer.write("}");
        }
    }

    toJS(writer: JSWriter): void {
        if (this.iter === null) {
            // Infinite loop: for { ... } → while (true) { ... }
            writer.write("while (true) {");
            writer.indentIn();
            writer.newLine();
            this.innerLoopToJS(writer);
            writer.indentOut();
            writer.newLine();
            writer.write("}");
            writer.newLine();
            return;
        }
        if (this.varName === null) {
            throw new Error(
                "Should not have iterator in for loop with undefined iterator variable name!"
            );
        }

        const iterVar = writer.uniqueName("$iter$");
        const safeIterVar = writer.safeName(iterVar);
        const safeVarName = writer.safeName(this.varName);

        // TODO: Potential optimization here: if this.iter is a RangeIter Expression,
        // it should be straighforward to write the loop using for(let ... ) { ... } syntax
        if (this.iter.type instanceof ArrayType || this.iter.type instanceof MutArrType) {
            writer.useBuiltin("$ArrayIterator$");
            writer.write(`const ${safeIterVar} = new $ArrayIterator$(`);
            this.iter.toJS(writer);
            writer.write(");");
            writer.newLine();
        } else {
            writer.write(`const ${safeIterVar} = `);
            this.iter.toJS(writer);
            writer.write(";");
            writer.newLine();
        }

        writer.write("while (true) {");
        writer.indentIn();
        writer.newLine();
        writer.write(`const ${safeVarName} = ${safeIterVar}.next();`);
        writer.newLine();
        writer.write(`if (${safeVarName} === undefined) break;`);
        writer.newLine();

        this.innerLoopToJS(writer);

        writer.indentOut();
        writer.newLine();
        writer.write("}");
        writer.newLine();
        writer.write(`${safeIterVar}.reset()`);
    }
}

/** True if inside an IIFE -- used for checking break and continue statements */
function inForLoopNeedsExceptionForControlFlow(startNode: Expression) {
    let node: Expression | null = startNode.parent;
    while (node) {
        if (node.isLoopBoundary()) return false;
        if (node.isFunctionBoundary()) return false;
        if (node instanceof Block && node.isValueUsed) {
            // A Block creates an IIFE context only when it's NOT the direct body of a function or loop
            const isFunctionBody = node.parent !== null && node.parent.isFunctionBoundary();
            const isLoopBody = node.parent !== null && node.parent.isLoopBoundary();
            if (
                !isFunctionBody &&
                !isLoopBody &&
                lastExprShouldReturn(node.expressions[node.expressions.length - 1])
            ) {
                return true;
            }
        }
        if (node instanceof If && node.isValueUsed && node.hasElse) return true;
        node = node.parent;
    }
    return false;
}

export class Break extends Expression {
    constructor(startToken: Token) {
        super(startToken.line, startToken.col);
        this.type = "Null";
    }

    cascadeTypes(parent: Expression | null, valueUsed: boolean): void {
        super.cascadeTypes(parent, valueUsed);
        // Verify `break` is inside a for loop
        if (!this.findEnclosing(ForLoop)) {
            throw this.error("`break` is only allowed inside a for loop");
        }
    }

    clone(_bindings?: Map<string, Type>): Expression {
        return new Break({ line: this.line, col: this.col, text: "break", type: TokenType.Break });
    }

    needsExceptionForControlFlow(): boolean {
        return inForLoopNeedsExceptionForControlFlow(this);
    }

    toJS(writer: JSWriter): void {
        if (this.needsExceptionForControlFlow()) {
            writer.useBuiltin("$Break$");
            writer.write("throw new $Break$()");
        } else {
            writer.write("break");
        }
    }
}

export class Continue extends Expression {
    constructor(startToken: Token) {
        super(startToken.line, startToken.col);
        this.type = "Null";
    }

    cascadeTypes(parent: Expression | null, valueUsed: boolean): void {
        super.cascadeTypes(parent, valueUsed);
        // Verify `continue` is inside a for loop
        if (!this.findEnclosing(ForLoop)) {
            throw this.error("`continue` is only allowed inside a for loop");
        }
    }

    clone(_bindings?: Map<string, Type>): Expression {
        return new Continue({
            line: this.line,
            col: this.col,
            text: "continue",
            type: TokenType.Continue,
        });
    }

    needsExceptionForControlFlow(): boolean {
        return inForLoopNeedsExceptionForControlFlow(this);
    }

    toJS(writer: JSWriter): void {
        if (this.needsExceptionForControlFlow()) {
            writer.useBuiltin("$Continue$");
            writer.write("throw new $Continue$()");
        } else {
            writer.write("continue");
        }
    }
}

export class Return extends Expression {
    value: Expression;

    constructor(startToken: Token, value: Expression) {
        super(startToken.line, startToken.col);
        this.value = value;
    }

    cascadeTypes(parent: Expression | null, valueUsed: boolean): void {
        super.cascadeTypes(parent, valueUsed);
        this.value.cascadeTypes(this, true);
        this.type = "Null"; // Return statements have type null, even if their values do not
        // Verify `return` is inside a function,
        // and let that function knows it needs to check that the return type matches
        // Walk up to find enclosing function boundary
        let fn: Expression | null = this.parent;
        while (fn) {
            if (fn.isFunctionBoundary()) break;
            fn = fn.parent;
        }
        if (fn !== null && "returnStatementValues" in (fn as unknown as Record<string, unknown>)) {
            (fn as unknown as { returnStatementValues: Expression[] }).returnStatementValues.push(
                this.value
            );
        }
    }

    clone(bindings?: Map<string, Type>): Expression {
        return new Return(
            { line: this.line, col: this.col, text: "return", type: TokenType.Return },
            this.value.clone(bindings)
        );
    }

    /** True if this return is inside an IIFE (computed lazily via parent pointers) */
    needsExceptionForControlFlow(): boolean {
        let node: Expression | null = this.parent;
        while (node) {
            if (node.isFunctionBoundary()) return false;
            if (node instanceof Block && node.isValueUsed) {
                // A Block creates an IIFE context only when it's NOT the direct body of a function
                const isFunctionBody = node.parent !== null && node.parent.isFunctionBoundary();
                if (
                    !isFunctionBody &&
                    lastExprShouldReturn(node.expressions[node.expressions.length - 1])
                )
                    return true;
            }
            if (node instanceof If && node.isValueUsed && node.hasElse) return true;
            node = node.parent;
        }
        return false;
    }

    toJS(writer: JSWriter): void {
        if (this.needsExceptionForControlFlow()) {
            writer.useBuiltin("$Return$");
            writer.write("throw new $Return$(");
            this.value.toJS(writer);
            writer.write(")");
        } else {
            writer.write("return ");
            this.value.toJS(writer);
        }
    }
}
