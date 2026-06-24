import { TokenType, type Token } from "../tokens";
import type { JSWriter } from "../write-js";
import {
    checkTraitSatisfied,
    extractBindingsFromParams,
    functionNameWithParamTypes,
} from "./caller-utils";
import { ASTError, DropValue, Expression } from "./expression";
import { EnumDef, Match } from "./enums";
import {
    findFunction,
    getEnum,
    getMonomorphized,
    getStruct,
    getTrait,
    isCrossModuleRefAllowed,
    isVarConsumed,
    registerFunction,
    registerMonomorphized,
    restoreConsumedVars,
    saveConsumedVars,
} from "./registries";
import { setParentPointers } from "./set-parent-pointers";
import { deepEquals } from "./type-utils";
import {
    ArrayType,
    collectCustomTypeNames,
    CustomType,
    EnumType,
    FuncType,
    isBuiltinTypeName,
    IterType,
    MutArrType,
    substituteTypeParams,
    TemplateTypes,
    TupleType,
    type Type,
} from "./types";
import type { RustWriter } from "../write-rust";

export class Block extends Expression {
    constructor(
        rootToken: Token,
        public expressions: Expression[]
    ) {
        if (expressions.length === 0) {
            throw new Error("block expression must not be empty.");
        }
        super(rootToken.line, rootToken.col);
    }

    cascadeTypes(valueUsed: boolean): void {
        this.isValueUsed = valueUsed;
        for (let i = 0; i < this.expressions.length; i++) {
            const childValueUsed = i === this.expressions.length - 1 ? valueUsed : false;
            this.expressions[i].cascadeTypes(childValueUsed);
        }
        this.type = this.expressions[this.expressions.length - 1].type;
    }

    clone(bindings?: Map<string, Type>): Expression {
        return new Block(
            { line: this.line, col: this.col, text: "", type: TokenType.LBrace },
            this.expressions.map((e) => e.clone(bindings))
        );
    }

    toJS(writer: JSWriter): void {
        const lastExpr = this.expressions[this.expressions.length - 1];
        const shouldReturn = this.isValueUsed && Block.lastExprShouldReturn(lastExpr);
        if (shouldReturn) {
            writer.write("(() => ");
            writer.iifeDepth++;
        }
        writer.beginScope();
        for (const expression of this.expressions.slice(0, -1)) {
            expression.toJS(writer);
            writer.write(";");
            writer.newLine();
        }
        if (shouldReturn) {
            writer.write("return ");
        }
        lastExpr.toJS(writer);
        writer.write(";");
        writer.endScope();
        if (shouldReturn) {
            writer.iifeDepth--;
            writer.write(")()");
        }
    }

    toRust(writer: RustWriter): void {
        const lastExpr = this.expressions[this.expressions.length - 1];
        writer.beginScope();
        for (const expression of this.expressions.slice(0, -1)) {
            expression.toJS(writer);
            writer.write(";");
            writer.newLine();
        }
        lastExpr.toJS(writer);
        writer.endScope();
    }

    static lastExprShouldReturn(lastExpr: Expression): boolean {
        // Recurse through nested blocks to check if the ultimate last expression
        // is a value-producing expression or a control flow node.
        if (lastExpr instanceof Block) {
            return Block.lastExprShouldReturn(
                lastExpr.expressions[lastExpr.expressions.length - 1]
            );
        }
        return lastExpr.type !== "Null";
    }
}

export class If extends Expression {
    conditionalBranches: { condition: Expression; branch: Block }[];
    elseBranch: Block;
    hasElse: boolean;

    constructor(
        rootToken: Token,
        conditionalBranches: { condition: Expression; branch: Expression }[],
        elseBranch: Expression,
        hasElse: boolean = true
    ) {
        super(rootToken.line, rootToken.col);

        conditionalBranches.forEach(({ branch }) => {
            if (!(branch instanceof Block)) {
                throw new Error("branch of if statement must be a block (enclosed by '{' and '}')");
            }
        });
        if (!(elseBranch instanceof Block)) {
            throw new Error("else branch of if statement must be a block");
        }

        this.conditionalBranches = conditionalBranches as {
            condition: Expression;
            branch: Block;
        }[];
        this.elseBranch = elseBranch;
        this.hasElse = hasElse;
    }

    /** Check if a block's last expression is a control flow node (Break/Continue/Return) */
    static branchEndsInControlFlow(branch: Block): boolean {
        const last = branch.expressions[branch.expressions.length - 1];
        return last instanceof Break || last instanceof Continue || last instanceof Return;
    }

    cascadeTypes(valueUsed: boolean): void {
        this.isValueUsed = valueUsed;
        this.elseBranch.cascadeTypes(valueUsed);

        this.conditionalBranches.forEach(({ condition, branch }) => {
            condition.cascadeTypes(true);
            if (condition.type !== "Bool") {
                throw this.error(`condition must be boolean, but found ${condition.type}`);
            }
            branch.cascadeTypes(valueUsed);
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

    toJS(writer: JSWriter): void {
        if (this.hasElse && this.isValueUsed) {
            // Value-producing if-else: wrap in IIFE so the value can be captured
            writer.write("(() => {");
            writer.iifeDepth++;
            writer.indentIn();
            writer.newLine();
            this.conditionalBranches.forEach(({ condition, branch }) => {
                writer.write("if (");
                condition.toJS(writer);
                writer.write(") ");
                writer.beginScope();
                branch.expressions.forEach((expr, i) => {
                    if (i === branch.expressions.length - 1 && Block.lastExprShouldReturn(expr)) {
                        writer.write("return ");
                    }
                    expr.toJS(writer);
                    writer.write(";");
                    writer.newLine();
                });
                writer.endScope();
                writer.write(" else ");
            });
            writer.beginScope();
            this.elseBranch.expressions.forEach((expr, i) => {
                if (
                    i === this.elseBranch!.expressions.length - 1 &&
                    Block.lastExprShouldReturn(expr)
                ) {
                    writer.write("return ");
                }
                expr.toJS(writer);
                writer.write(";");
                writer.newLine();
            });
            writer.endScope();
            writer.indentOut();
            writer.newLine();
            writer.iifeDepth--;
            writer.write("})()");
        } else if (this.hasElse) {
            // Statement if-else (value not used): plain if/else/else chain, no IIFE
            this.conditionalBranches.forEach(({ condition, branch }, i) => {
                writer.write(i === 0 ? "if (" : " else if (");
                condition.toJS(writer);
                writer.write(") ");
                writer.beginScope();
                branch.expressions.forEach((expr) => {
                    expr.toJS(writer);
                    writer.newLine();
                });
                writer.endScope();
            });
            writer.write(" else ");
            writer.beginScope();
            this.elseBranch.expressions.forEach((expr) => {
                expr.toJS(writer);
                writer.newLine();
            });
            writer.endScope();
        } else {
            // Else-less if chain: all branches are else-if (no final else)
            this.conditionalBranches.forEach(({ condition, branch }, i) => {
                writer.write(i === 0 ? "if (" : " else if (");
                condition.toJS(writer);
                writer.write(") ");
                writer.beginScope();
                branch.expressions.forEach((expr) => {
                    expr.toJS(writer);
                    writer.newLine();
                });
                writer.endScope();
            });
        }
    }
}

export class ForLoop extends Expression {
    varName: string | null;
    iter: Expression | null;
    body: Block;

    constructor(startToken: Token, varName: string | null, iter: Expression | null, body: Block) {
        super(startToken.line, startToken.col);
        this.varName = varName;
        this.iter = iter;
        this.body = body;
        this.type = "Null";
    }

    cascadeTypes(valueUsed: boolean): void {
        this.isValueUsed = valueUsed;
        if (this.iter !== null) {
            this.iter.cascadeTypes(true);
            if (this.iter.type === null) {
                throw this.error("unable to resolve type of iterator");
            }
            let _innerType: Type;
            if (this.iter.type instanceof ArrayType) {
                _innerType = this.iter.type.innerType;
            } else if (this.iter.type instanceof IterType) {
                _innerType = this.iter.type.innerType;
            } else if (this.iter.type instanceof MutArrType) {
                _innerType = this.iter.type.innerType;
            } else {
                throw this.error(`cannot iterate over object of type ${this.iter.type}`);
            }
        }
        this.body.cascadeTypes(false);
    }

    clone(bindings?: Map<string, Type>): Expression {
        return new ForLoop(
            { line: this.line, col: this.col, text: "for", type: TokenType.For },
            this.varName,
            this.iter !== null ? this.iter.clone(bindings) : null,
            this.body.clone(bindings) as Block
        );
    }

    /** Walk the body subtree to check if any Break/Continue needs exception handling. */
    private bodyNeedsException(expr: Expression): boolean {
        if (expr instanceof Break || expr instanceof Continue) return expr.needsException;
        if (expr instanceof DropValue) return this.bodyNeedsException(expr.child);
        if (expr instanceof Block) return expr.expressions.some((e) => this.bodyNeedsException(e));
        if (expr instanceof If) {
            return (
                expr.conditionalBranches.some((b) => this.bodyNeedsException(b.branch)) ||
                this.bodyNeedsException(expr.elseBranch)
            );
        }
        if (expr instanceof ForLoop) return false; // break/continue in nested loops are handled by that loop
        // Recurse into common wrapper nodes
        for (const key of ["child", "value"] as const) {
            const child = (expr as unknown as Record<string, Expression | undefined>)[key];
            if (child && typeof child === "object" && child.constructor?.name) {
                if (this.bodyNeedsException(child)) return true;
            }
        }
        return false;
    }

    toJS(writer: JSWriter): void {
        if (this.iter === null) {
            // Infinite loop: for { ... } → while (true) { ... }
            writer.write("while (true) {");
            writer.indentIn();
            writer.newLine();
            const needsTry = this.body.expressions.some((e) => this.bodyNeedsException(e));
            if (needsTry) {
                writer.useBuiltin("$Continue$");
                writer.useBuiltin("$Break$");
                writer.write("try {");
                writer.indentIn();
                writer.newLine();
            }
            this.body.expressions.forEach((expr) => {
                expr.toJS(writer);
                writer.write(";");
                writer.newLine();
            });
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
            writer.indentOut();
            writer.newLine();
            writer.write("}");
            writer.newLine();
            return;
        }

        const iterVar = writer.uniqueName("$iter$");
        const safeIterVar = writer.safeName(iterVar);
        const safeVarName = writer.safeName(this.varName!);

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

        const needsTry = this.body.expressions.some((e) => this.bodyNeedsException(e));
        if (needsTry) {
            writer.useBuiltin("$Continue$");
            writer.useBuiltin("$Break$");
            writer.write("try {");
            writer.indentIn();
            writer.newLine();
        }

        this.body.expressions.forEach((expr) => {
            expr.toJS(writer);
            writer.write(";");
            writer.newLine();
        });

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
        writer.indentOut();
        writer.newLine();
        writer.write("}");
        writer.newLine();
        writer.write(`${safeIterVar}.reset()`);
    }
}

export class Break extends Expression {
    constructor(startToken: Token) {
        super(startToken.line, startToken.col);
        this.type = "Null";
    }

    cascadeTypes(valueUsed: boolean): void {
        this.isValueUsed = valueUsed;
        // Verify `break` is inside a for loop
        if (!this.findEnclosing(ForLoop)) {
            throw this.error("`break` is only allowed inside a for loop");
        }
    }

    clone(_bindings?: Map<string, Type>): Expression {
        return new Break({ line: this.line, col: this.col, text: "break", type: TokenType.Break });
    }

    /** True if this break is inside an IIFE (computed lazily via parent pointers) */
    get needsException(): boolean {
        let node: Expression | null = this.parent;
        while (node) {
            if (node instanceof ForLoop) return false;
            if (node instanceof FunctionDef || node instanceof AnonymousFunction) return false;
            if (node instanceof Block && node.isValueUsed) {
                // A Block creates an IIFE context only when it's NOT the direct body of a function or loop
                const isFunctionBody =
                    node.parent instanceof FunctionDef || node.parent instanceof AnonymousFunction;
                const isLoopBody = node.parent instanceof ForLoop;
                if (
                    !isFunctionBody &&
                    !isLoopBody &&
                    Block.lastExprShouldReturn(node.expressions[node.expressions.length - 1])
                )
                    return true;
            }
            if (node instanceof If && node.isValueUsed && node.hasElse) return true;
            node = node.parent;
        }
        return false;
    }

    toJS(writer: JSWriter): void {
        if (this.needsException) {
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

    cascadeTypes(valueUsed: boolean): void {
        this.isValueUsed = valueUsed;
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

    /** True if this continue is inside an IIFE (computed lazily via parent pointers) */
    get needsException(): boolean {
        let node: Expression | null = this.parent;
        while (node) {
            if (node instanceof ForLoop) return false;
            if (node instanceof FunctionDef || node instanceof AnonymousFunction) return false;
            if (node instanceof Block && node.isValueUsed) {
                const isFunctionBody =
                    node.parent instanceof FunctionDef || node.parent instanceof AnonymousFunction;
                const isLoopBody = node.parent instanceof ForLoop;
                if (
                    !isFunctionBody &&
                    !isLoopBody &&
                    Block.lastExprShouldReturn(node.expressions[node.expressions.length - 1])
                )
                    return true;
            }
            if (node instanceof If && node.isValueUsed && node.hasElse) return true;
            node = node.parent;
        }
        return false;
    }

    toJS(writer: JSWriter): void {
        if (this.needsException) {
            writer.useBuiltin("$Continue$");
            writer.write("throw new $Continue$()");
        } else {
            writer.write("continue");
        }
    }
}

export class Return extends Expression {
    constructor(
        startToken: Token,
        public value: Expression
    ) {
        super(startToken.line, startToken.col);
    }

    cascadeTypes(valueUsed: boolean): void {
        this.isValueUsed = valueUsed;
        this.value.cascadeTypes(true);
        this.type = "Null"; // Return statements have type null, even if their values do not
        // Verify `return` is inside a function,
        // and let that function knows it needs to check that the return type matches
        const fn = this.findEnclosing(FunctionDef) ?? this.findEnclosing(AnonymousFunction);
        if (fn) {
            fn.returnStatements.push(this);
        }
    }

    clone(bindings?: Map<string, Type>): Expression {
        return new Return(
            { line: this.line, col: this.col, text: "return", type: TokenType.Return },
            this.value.clone(bindings)
        );
    }

    /** True if this return is inside an IIFE (computed lazily via parent pointers) */
    get needsException(): boolean {
        let node: Expression | null = this.parent;
        while (node) {
            if (node instanceof FunctionDef || node instanceof AnonymousFunction) return false;
            if (node instanceof Block && node.isValueUsed) {
                // A Block creates an IIFE context only when it's NOT the direct body of a function
                const isFunctionBody =
                    node.parent instanceof FunctionDef || node.parent instanceof AnonymousFunction;
                if (
                    !isFunctionBody &&
                    Block.lastExprShouldReturn(node.expressions[node.expressions.length - 1])
                )
                    return true;
            }
            if (node instanceof If && node.isValueUsed && node.hasElse) return true;
            node = node.parent;
        }
        return false;
    }

    toJS(writer: JSWriter): void {
        if (this.needsException) {
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

/**
 * Compile-time `use` directive: loads another module's definitions.
 * Generates no runtime code — handled entirely during compilation.
 */
export class UseModule extends Expression {
    constructor(
        rootToken: Token,
        public path: string,
        public symbols?: string[]
    ) {
        super(rootToken.line, rootToken.col);
        this.type = "Null";
    }

    cascadeTypes(_valueUsed: boolean): void {
        // No type-checking needed — module compilation is handled by the compiler.
    }

    toJS(_writer: JSWriter): void {
        // No runtime code generated for `use` directives.
    }

    clone(_bindings?: Map<string, Type>): Expression {
        return new UseModule(
            { line: this.line, col: this.col, text: "use", type: TokenType.Use },
            this.path,
            this.symbols ? [...this.symbols] : undefined
        );
    }
}

/**
 * Range literal created by the `..` syntax.
 * `a..b` → start=a, end=b (inclusive)
 * `..b`  → start=null, end=b (from 0 to b)
 * `a..`  → start=a, end=null (from a to infinity)
 * `..`   → start=null, end=null (from 0 to infinity)
 */
export class RangeIter extends Expression {
    start: Expression | null;
    end: Expression | null;
    step: Expression | null;

    constructor(
        startToken: Token,
        start: Expression | null,
        end: Expression | null,
        step: Expression | null
    ) {
        super(startToken.line, startToken.col);
        this.start = start;
        this.end = end;
        this.step = step;
    }

    cascadeTypes(valueUsed: boolean): void {
        this.isValueUsed = valueUsed;
        if (this.start !== null) {
            this.start.cascadeTypes(true);
            if (this.start.type !== "Int") {
                throw this.error("range start must be an integer");
            }
        }
        if (this.end !== null) {
            this.end.cascadeTypes(true);
            if (this.end.type !== "Int") {
                throw this.error("range end must be an integer");
            }
        }
        if (this.step !== null) {
            this.step.cascadeTypes(true);
            if (this.step.type !== "Int") {
                throw this.error("range step must be an integer");
            }
        }

        this.type = new IterType("Int");
    }

    clone(bindings?: Map<string, Type>): Expression {
        return new RangeIter(
            { line: this.line, col: this.col, text: "..", type: TokenType.DotDot },
            this.start ? this.start.clone(bindings) : null,
            this.end ? this.end.clone(bindings) : null,
            this.step ? this.step.clone(bindings) : null
        );
    }

    toJS(writer: JSWriter): void {
        writer.useBuiltin("$RangeIterator$");
        writer.write("new $RangeIterator$(");
        if (this.start !== null) {
            this.start.toJS(writer);
        } else {
            writer.write("0n");
        }
        writer.write(", ");
        if (this.end !== null) {
            this.end.toJS(writer);
        } else {
            writer.write("undefined");
        }
        if (this.step !== null) {
            writer.write(", ");
            this.step.toJS(writer);
        }
        writer.write(")");
    }
}

export class TupleLit extends Expression {
    constructor(
        startToken: Token,
        public elements: Expression[]
    ) {
        super(startToken.line, startToken.col);
        if (elements.length === 0) {
            throw new Error("tuple must not be empty");
        }
    }

    cascadeTypes(valueUsed: boolean): void {
        this.isValueUsed = valueUsed;
        const types: Type[] = [];
        for (let i = 0; i < this.elements.length; i++) {
            this.elements[i].cascadeTypes(true);
            if (this.elements[i].type === null) {
                throw this.error(`unable to resolve type of tuple element ${i + 1}`);
            }
            types.push(this.elements[i].type!);
        }
        this.type = new TupleType(types);
    }

    clone(bindings?: Map<string, Type>): Expression {
        return new TupleLit(
            { line: this.line, col: this.col, text: "(", type: TokenType.LParen },
            this.elements.map((e) => e.clone(bindings))
        );
    }

    toJS(writer: JSWriter): void {
        writer.write("[");
        this.elements.forEach((elem, i) => {
            if (i > 0) writer.write(", ");
            elem.toJS(writer);
        });
        writer.write("]");
    }
}

export class TupleUnpack extends Expression {
    bindings: { name: string; isMutable: boolean; isReassignment: boolean; fullName?: string }[];
    source: Expression;
    isDropped: boolean;

    constructor(
        startToken: Token,
        bindings: { name: string; isMutable: boolean }[],
        source: Expression,
        isDropped: boolean
    ) {
        super(startToken.line, startToken.col);
        this.bindings = bindings.map((b) => ({ ...b, isReassignment: false }));
        this.source = source;
        this.isDropped = isDropped;
    }

    cascadeTypes(valueUsed: boolean): void {
        this.isValueUsed = valueUsed;
        this.source.cascadeTypes(true);
        if (this.source.type === null) {
            throw this.error("unable to resolve type of source expression");
        }
        if (!(this.source.type instanceof TupleType)) {
            throw this.error(`cannot unpack non-tuple expression of type ${this.source.type}`);
        }
        if (this.source.type.types.length !== this.bindings.length) {
            throw this.error(
                `tuple has ${this.source.type.types.length} elements but unpacking into ${this.bindings.length} variables`
            );
        }
        this.type = this.isDropped ? "Null" : this.source.type;

        // Resolve each binding — either reassign an existing variable or declare a new one
        for (let i = 0; i < this.bindings.length; i++) {
            const binding = this.bindings[i];
            const elemType = this.source.type.types[i];

            // Check for existing variable with same name (reassignment semantics)
            const sameBlockDef = Assignment.findDefiningAssignment(binding.name, this);
            const outerDef = sameBlockDef
                ? null
                : Assignment.findOuterDefinition(binding.name, this);

            if (sameBlockDef !== null || outerDef !== null) {
                const existingDef = sameBlockDef ?? outerDef!;
                if (!existingDef.isMutable) {
                    throw this.error(`cannot reassign non-mutable variable '${binding.name}'`);
                }
                if (!deepEquals(existingDef.type, elemType)) {
                    throw this.error(
                        `cannot assign value of type ${elemType} to variable '${binding.name}' of type ${existingDef.type}`
                    );
                }
                binding.fullName = binding.name;
                binding.isReassignment = true;
            } else {
                // New declaration
                binding.fullName = binding.name;
                binding.isReassignment = false;
            }
        }
    }

    clone(bindings?: Map<string, Type>): Expression {
        return new TupleUnpack(
            { line: this.line, col: this.col, text: "(", type: TokenType.LParen },
            this.bindings.map((b) => ({ name: b.name, isMutable: b.isMutable })),
            this.source.clone(bindings),
            this.isDropped
        );
    }

    toJS(writer: JSWriter): void {
        // If dropped, emit [a, b] = source
        if (this.isDropped) {
            writer.write("[");
            for (let i = 0; i < this.bindings.length; i++) {
                const binding = this.bindings[i];
                if (!binding.isReassignment) {
                    writer.declareVariable(binding.name);
                }
                const safeName = writer.safeName(binding.name);
                writer.write(`${safeName}${i == this.bindings.length - 1 ? "] = " : ","}`);
            }
            this.source.toJS(writer);
        }
        // If not dropped, use a comma expression so TupleUnpack evaluates to the source tuple.
        // Emit: ($tup = source, a = $tup[0], b = $tup[1], $tup)
        else {
            const tmpName = writer.uniqueName("$tup$");
            writer.declareVariable(tmpName);
            writer.write(`(${tmpName} = `);
            this.source.toJS(writer);
            for (let i = 0; i < this.bindings.length; i++) {
                const binding = this.bindings[i];
                if (!binding.isReassignment) {
                    writer.declareVariable(binding.name);
                }
                const safeName = writer.safeName(binding.name);
                writer.write(`, ${safeName} = ${tmpName}[${i}]`);
            }
            writer.write(`, ${tmpName})`);
        }
    }
}

export class Variable extends Expression {
    name: string;
    templateTypes: TemplateTypes;

    fullName?: string;

    constructor(token: Token, templateTypes: TemplateTypes) {
        super(token.line, token.col);
        this.name = token.text;
        this.templateTypes = templateTypes;
    }

    toString(): string {
        if (!this.templateTypes.empty()) {
            return `${this.name}${this.templateTypes}`;
        }
        return this.name;
    }

    /** Walk up the parent chain through enclosing Blocks, scanning older sibling
     *  expressions in each one. Stops when the callback returns true (found). */
    private walkEnclosingBlocks(callback: (siblings: Expression[]) => boolean): boolean {
        let child: Expression | null = null;
        let parent = this.parent;
        while (parent) {
            if (parent instanceof Block) {
                const idx = parent.expressions.indexOf(child ?? this);
                const olderSiblings = parent.expressions.slice(0, idx);
                if (callback(olderSiblings)) return true;
            }
            child = parent;
            parent = parent.parent;
        }
        return false;
    }

    setTypeWithTemplateTypes(): void {
        this.fullName = functionNameWithParamTypes(this.name, this.templateTypes?.types ?? []);
        // Check global registry first (for non-generic or already-monomorphized functions)
        const registered = findFunction(this.fullName);
        if (registered) {
            this.type = registered.getFuncType();
            return;
        }
        // Walk up parent chain scanning older siblings in each enclosing Block
        const found = this.walkEnclosingBlocks((olderSiblings) => {
            for (let j = olderSiblings.length - 1; j >= 0; j--) {
                let olderSibling = olderSiblings[j];
                if (olderSibling instanceof DropValue) {
                    olderSibling = olderSibling.child;
                }
                // Exact match on fullName (non-generic or already monomorphized)
                if (
                    olderSibling instanceof FunctionDef &&
                    olderSibling.fullName === this.fullName
                ) {
                    this.type = olderSibling.getFuncType();
                    return true;
                }
                // Generic function match — attempt monomorphization
                if (
                    olderSibling instanceof FunctionDef &&
                    olderSibling.name === this.name &&
                    olderSibling.isGeneric
                ) {
                    const argTypes = this.templateTypes?.types ?? [];
                    const result = olderSibling.monomorphize(argTypes);
                    if (result !== null) {
                        this.fullName = result.fullName;
                        this.type = result.funcType;
                        return true;
                    }
                }
            }
            return false;
        });
        if (!found) {
            throw this.error(`cannot resolve type of variable '${this}'`);
        }
    }

    resolveAssignment(e: Expression): Type | null {
        if (e instanceof Assignment && e.name === this.name) {
            return e.value.type;
        }
        return null;
    }

    /** Recursively search an expression tree for an Assignment with the given name,
     *  e.g. to find `y` inside `Assignment(x, Assignment(y, 2))`. */
    private findNestedAssignment(expr: Expression, name: string): Type | null {
        if (expr instanceof Assignment) {
            if (expr.name === name) return expr.value.type;
            return this.findNestedAssignment(expr.value, name);
        }
        if (expr instanceof DropValue) {
            return this.findNestedAssignment(expr.child, name);
        }
        return null;
    }

    cascadeTypes(valueUsed: boolean): void {
        this.isValueUsed = valueUsed;
        if (!this.templateTypes.empty()) {
            this.setTypeWithTemplateTypes();
            return;
        }
        // Walk up parent chain checking enclosing contexts for variable definitions.
        // 'child' tracks the expression at each level that leads back to this variable,
        // so we can correctly identify sibling positions in Blocks.
        let child: Expression | null = null;
        let node: Expression | null = this.parent;
        while (node) {
            // Check Function/AnonymousFunction params
            if (node instanceof FunctionDef || node instanceof AnonymousFunction) {
                for (const param of node.params) {
                    if (param.name === this.name && param.type !== null) {
                        this.type = param.type;
                        this.fullName = this.name;
                        return;
                    }
                }
            }
            // Check ForLoop variable (skip infinite loops with no iterator)
            if (node instanceof ForLoop && node.iter !== null && node.varName === this.name) {
                let innerType: Type = "Int";
                if (node.iter.type instanceof ArrayType) {
                    innerType = node.iter.type.innerType;
                } else if (node.iter.type instanceof IterType) {
                    innerType = node.iter.type.innerType;
                } else if (node.iter.type instanceof MutArrType) {
                    innerType = node.iter.type.innerType;
                } else if (node.iter.type === "Str") {
                    innerType = "Str";
                }
                this.type = innerType;
                this.fullName = this.name;
                return;
            }
            // Check Match arm bindings (some(v) or variantName(v))
            // (only if this Variable is inside the arm body, not the scrutinee itself)
            if (node instanceof Match && this !== node.scrutinee) {
                for (const arm of node.arms) {
                    if (
                        (arm.kind === "some" || arm.kind === "variant") &&
                        arm.binding === this.name
                    ) {
                        this.type = arm.bindingType;
                        this.fullName = this.name;
                        return;
                    }
                }
            }
            // Scan older siblings in Blocks (only when child is a direct expression of the Block)
            if (node instanceof Block) {
                const idx = node.expressions.indexOf(child ?? this);
                if (idx > 0) {
                    const olderSiblings = node.expressions.slice(0, idx);
                    for (let j = olderSiblings.length - 1; j >= 0; j--) {
                        let sib = olderSiblings[j];
                        const type = this.resolveAssignment(sib);
                        if (type !== null) {
                            // Skip cross-module assignments unless allowed by import rules.
                            if (
                                !isCrossModuleRefAllowed(this.sourceFile, sib.sourceFile, this.name)
                            )
                                continue;
                            this.type = type;
                            this.fullName = this.name;
                            if (isVarConsumed(this.fullName)) {
                                throw this.error(
                                    `cannot use variable '${this.fullName}' after it was detrans'd`
                                );
                            }
                            return;
                        }
                        if (sib instanceof DropValue) {
                            sib = sib.child;
                            // Skip cross-module definitions unless allowed by import rules.
                            if (
                                !isCrossModuleRefAllowed(this.sourceFile, sib.sourceFile, this.name)
                            )
                                continue;
                            const innerType = this.resolveAssignment(sib);
                            if (innerType !== null) {
                                this.type = innerType;
                                this.fullName = this.name;
                                if (isVarConsumed(this.fullName)) {
                                    throw this.error(
                                        `cannot use variable '${this.fullName}' after it was detrans'd`
                                    );
                                }
                                return;
                            }
                        }
                        if (sib instanceof Assignment && sib.name !== this.name) {
                            // Skip cross-module definitions unless allowed by import rules.
                            if (
                                !isCrossModuleRefAllowed(this.sourceFile, sib.sourceFile, this.name)
                            )
                                continue;
                            const nested = this.findNestedAssignment(sib.value, this.name);
                            if (nested !== null) {
                                this.type = nested;
                                this.fullName = this.name;
                                if (isVarConsumed(this.fullName)) {
                                    throw this.error(
                                        `cannot use variable '${this.fullName}' after it was detrans'd`
                                    );
                                }
                                return;
                            }
                        }
                        if (sib instanceof TupleUnpack) {
                            // Skip cross-module definitions unless allowed by import rules.
                            if (
                                !isCrossModuleRefAllowed(this.sourceFile, sib.sourceFile, this.name)
                            )
                                continue;
                            const binding = sib.bindings.find((b) => b.name === this.name);
                            if (binding) {
                                const idx = sib.bindings.indexOf(binding);
                                if (sib.source.type instanceof TupleType) {
                                    this.type = sib.source.type.types[idx];
                                    this.fullName = this.name;
                                    if (isVarConsumed(this.fullName)) {
                                        throw this.error(
                                            `cannot use variable '${this.fullName}' after it was detrans'd`
                                        );
                                    }
                                    return;
                                }
                            }
                        }
                        if (sib instanceof DropValue) sib = sib.child;
                        if (
                            sib instanceof FunctionDef &&
                            sib.name === this.name &&
                            sib.params.length === 0 &&
                            sib.fullName !== null
                        ) {
                            // Skip functions from a different module unless allowed by import rules.
                            if (
                                !isCrossModuleRefAllowed(this.sourceFile, sib.sourceFile, this.name)
                            )
                                continue;
                            this.type = sib.getFuncType();
                            this.fullName = sib.fullName;
                            return;
                        }
                        if (sib instanceof EnumDef && sib.name === this.name) {
                            // Skip enums from a different module unless allowed by import rules.
                            if (
                                !isCrossModuleRefAllowed(this.sourceFile, sib.sourceFile, this.name)
                            )
                                continue;
                            const variants = sib.variants.map((v) => ({
                                name: v.name,
                                type: v.type,
                            }));
                            this.type = new EnumType(sib.name, variants);
                            this.fullName = sib.name;
                            return;
                        }
                    }
                }
            }
            child = node;
            node = node.parent;
        }
        throw this.error(`unable to resolve type of variable ${this}`);
    }

    clone(bindings?: Map<string, Type>): Expression {
        let newTemplateTypes = this.templateTypes;
        if (bindings && !this.templateTypes.empty()) {
            newTemplateTypes = new TemplateTypes(
                this.templateTypes.types.map((t) => substituteTypeParams(t, bindings)),
                this.templateTypes.returnType !== null
                    ? substituteTypeParams(this.templateTypes.returnType, bindings)
                    : null
            );
        }
        const cloned = new Variable(
            { line: this.line, col: this.col, text: this.name, type: TokenType.Identifier },
            newTemplateTypes
        );
        return cloned;
    }

    toJS(writer: JSWriter): void {
        if (this.fullName === undefined) {
            throw this.error(`type of variable ${this} not resolved`);
        }
        const name = writer.safeName(this.fullName);
        writer.write(name);
        // Clone iterator variables on every use so that sharing an iterator
        // across multiple expressions (nested loops, call arguments, pipes, etc.)
        // doesn't cause one consumer to share the same state as another
        if (this.type instanceof IterType) {
            writer.write(".clone()");
        }
    }
}

export class Assignment extends Expression {
    name: string;
    isMutable: boolean = false;
    isReassignment: boolean = false;

    constructor(
        variableToken: Token,
        public value: Expression,
        public isDropped: boolean,
        isMutable: boolean = false
    ) {
        super(variableToken.line, variableToken.col);
        this.name = variableToken.text;
        this.isMutable = isMutable;
    }

    /** Scan older siblings in the immediate enclosing Block for a variable definition. */
    static findDefiningAssignment(
        name: string,
        startNode: Expression
    ): { isMutable: boolean; type: Type } | null {
        const parent = startNode.parent;
        if (!(parent instanceof Block)) return null;
        const olderSiblings = parent.expressions.slice(0, parent.expressions.indexOf(startNode));
        for (let j = olderSiblings.length - 1; j >= 0; j--) {
            let olderSibling = olderSiblings[j];
            if (olderSibling instanceof DropValue) {
                olderSibling = olderSibling.child;
                if (olderSibling === startNode) continue;
            }
            if (olderSibling instanceof Assignment && olderSibling.name === name) {
                // Skip assignments from a different module — they are in
                // separate scopes and should not shadow or cause redefinition.
                if (
                    olderSibling.sourceFile !== undefined &&
                    olderSibling.sourceFile !== startNode.sourceFile
                ) {
                    continue;
                }
                if (olderSibling.isReassignment) continue;
                return { isMutable: olderSibling.isMutable, type: olderSibling.value.type! };
            }
            if (olderSibling instanceof TupleUnpack) {
                const binding = olderSibling.bindings.find((b) => b.name === name);
                if (binding && olderSibling.source.type instanceof TupleType) {
                    const idx = olderSibling.bindings.indexOf(binding);
                    return {
                        isMutable: binding.isMutable,
                        type: olderSibling.source.type.types[idx],
                    };
                }
            }
        }
        return null;
    }

    /** Walk up parent chain beyond the direct enclosing Block to find a variable definition. */
    static findOuterDefinition(
        name: string,
        startNode: Expression
    ): { isMutable: boolean; type: Type } | null {
        // Walk up from startNode's parent, tracking 'child' to limit sibling scans
        let child: Expression = startNode;
        let node: Expression | null = startNode.parent;
        let skippedFirstBlock = false;
        while (node) {
            if (!skippedFirstBlock) {
                if (node instanceof Block) skippedFirstBlock = true;
                child = node;
                node = node.parent;
                continue;
            }
            if (node instanceof Block) {
                // Only scan siblings before the child that led into this Block
                const idx = node.expressions.indexOf(child);
                for (let j = idx - 1; j >= 0; j--) {
                    let sib = node.expressions[j];
                    if (sib instanceof DropValue) sib = sib.child;
                    if (sib instanceof Assignment && sib.name === name && !sib.isReassignment) {
                        return { isMutable: sib.isMutable, type: sib.value.type! };
                    }
                    if (sib instanceof TupleUnpack) {
                        const binding = sib.bindings.find((b) => b.name === name);
                        if (binding && sib.source.type instanceof TupleType) {
                            const idx = sib.bindings.indexOf(binding);
                            return {
                                isMutable: binding.isMutable,
                                type: sib.source.type.types[idx],
                            };
                        }
                    }
                }
            } else if (node instanceof FunctionDef) {
                for (const arg of node.params) {
                    if (arg.name === name) return { isMutable: false, type: arg.type };
                }
            } else if (node instanceof AnonymousFunction) {
                for (const arg of node.params) {
                    if (arg.name === name) return { isMutable: false, type: arg.type };
                }
            }
            child = node;
            node = node.parent;
        }
        return null;
    }

    cascadeTypes(valueUsed: boolean): void {
        this.isValueUsed = valueUsed;
        this.value.cascadeTypes(true);
        this.type = this.isDropped ? "Null" : this.value.type;

        if (this.value.type === "Null") {
            throw this.error("cannot assign null value to variable");
        }

        const sameBlockDef = Assignment.findDefiningAssignment(this.name, this);

        if (sameBlockDef !== null) {
            this.isReassignment = true;

            if (this.isMutable) {
                throw this.error(
                    `cannot redeclare variable '${this.name}' with 'mut' — it was already defined in this scope`
                );
            }

            if (!sameBlockDef.isMutable) {
                throw this.error(`cannot reassign non-mutable variable '${this.name}'`);
            }

            const assignType = this.value.type!;
            if (!deepEquals(sameBlockDef.type, assignType)) {
                throw this.error(
                    `tried to reassign variable '${this.name}' with type ${assignType} but it was previously defined with type ${sameBlockDef.type}`
                );
            }
        } else if (this.isMutable) {
            const outerDef = Assignment.findOuterDefinition(this.name, this);
            if (outerDef !== null && !outerDef.isMutable) {
                throw this.error(
                    `cannot declare mutable variable '${this.name}' — it shadows a non-mutable variable in an outer scope`
                );
            }
            this.isReassignment = false;
        } else {
            const outerDef = Assignment.findOuterDefinition(this.name, this);
            if (outerDef !== null) {
                this.isReassignment = true;

                if (!outerDef.isMutable) {
                    throw this.error(`cannot reassign non-mutable variable '${this.name}'`);
                }

                const assignType = this.value.type!;
                if (!deepEquals(outerDef.type, assignType)) {
                    throw this.error(
                        `tried to reassign variable '${this.name}' with type ${assignType} but it was previously defined with type ${outerDef.type}`
                    );
                }
            } else {
                this.isReassignment = false;
            }
        }
    }

    clone(bindings?: Map<string, Type>): Expression {
        const cloned = new Assignment(
            { line: this.line, col: this.col, text: this.name, type: TokenType.Identifier },
            this.value.clone(bindings),
            this.isDropped,
            this.isMutable
        );
        return cloned;
    }

    toJS(writer: JSWriter): void {
        const safeName = writer.safeName(this.name);
        if (this.isReassignment) {
            writer.write(`${safeName} = `);
            this.value.toJS(writer);
        } else {
            if (this.isDropped) {
                writer.write(`${this.isMutable ? "let" : "const"} ${safeName} = `);
                this.value.toJS(writer);
            } else {
                writer.declareVariable(this.name);
                writer.write(`${safeName} = `);
                this.value.toJS(writer);
            }
        }
    }
}

export class AnonymousFunction extends Expression {
    params: { name: string; type: Type }[];
    body: Block;
    returnType: Type | null;
    /** Whether this function has unresolved (null) param types that need inference. */
    needsInference: boolean = false;
    /** Need to maintain a list of any return statements this function has,
     * so we can check that they return a value whose type matches
     * the return type of this function */
    returnStatements: Return[] = [];

    constructor(
        rootToken: Token,
        params: { name: string; type: Type }[],
        body: Expression,
        returnType: Type | null = null
    ) {
        if (!(body instanceof Block)) {
            throw new Error("function body must be a Blcok expression");
        }
        super(rootToken.line, rootToken.col);
        this.params = params;
        this.body = body;
        this.returnType = returnType;
        this.needsInference = params.some((p) => p.type === null);
    }

    /** Fill param types from an inferred signature, then cascade the body. */
    fillParams(types: Type[]): void {
        if (!this.needsInference) return;
        for (let i = 0; i < this.params.length; i++) {
            this.params[i].type = types[i] ?? this.params[i].type;
        }
        this.needsInference = false;
        // Body: last expression is the return value (always consumed).
        this.body.cascadeTypes(true);
        const bodyReturnType = this.body.type;
        if (bodyReturnType === null) {
            throw this.error(`unable to resolve return type of function.`);
        }
        if (this.returnType !== null && !deepEquals(bodyReturnType, this.returnType)) {
            throw this.error(
                `anonymous function body should return ${this.returnType}, but found ${bodyReturnType}`
            );
        }
        this.type = new FuncType(
            this.params.map((p) => p.type),
            this.returnType ?? bodyReturnType
        );
    }

    cascadeTypes(valueUsed: boolean): void {
        this.isValueUsed = valueUsed;
        // If params have null types, set a placeholder FuncType and skip body cascade.
        // fillParams() must be called by the enclosing context to provide real types.
        if (this.needsInference) {
            // Use a non-concrete placeholder type so looseMatch allows the match
            const placeholder = new CustomType("__infer__");
            this.type = new FuncType(
                this.params.map(() => placeholder),
                placeholder
            );
            return;
        }
        // Body: last expression is the return value (always consumed), not the
        // function definition's own valueUsed. Block.cascadeTypes handles the
        // per-expression valueUsed propagation internally.
        this.body.cascadeTypes(true);
        const bodyReturnType = this.body.type;
        if (bodyReturnType === null) {
            throw this.error(`unable to resolve return type of function.`);
        }
        if (this.returnType !== null && !deepEquals(bodyReturnType, this.returnType)) {
            throw this.error(
                `anonymous function body should return ${this.returnType}, but found ${bodyReturnType}`
            );
        }
        for (const s of this.returnStatements) {
            if (!deepEquals(s.value.type, this.returnType)) {
                throw new ASTError(
                    s.line,
                    s.col,
                    `anonymous function with return type ${this.returnType} has a return statement that returns a value of type ${s.value.type}`
                );
            }
        }
        this.type = new FuncType(
            this.params.map((p) => p.type),
            this.returnType ?? bodyReturnType
        );
    }

    clone(bindings?: Map<string, Type>): Expression {
        const cloned = new AnonymousFunction(
            { line: this.line, col: this.col, text: "func", type: TokenType.Func },
            this.params.map((p) => ({
                name: p.name,
                type: bindings && p.type !== null ? substituteTypeParams(p.type, bindings) : p.type,
            })),
            this.body.clone(bindings),
            this.returnType && bindings
                ? (substituteTypeParams(this.returnType, bindings) as Type)
                : null
        );
        return cloned;
    }

    /** Walk the body subtree to check if any Return needs exception handling. */
    private needsTryCatch(): boolean {
        const check = (expr: Expression): boolean => {
            if (expr instanceof Return) return expr.needsException;
            if (expr instanceof DropValue) return check(expr.child);
            if (expr instanceof Block) return expr.expressions.some((e) => check(e));
            if (expr instanceof If) {
                return (
                    expr.conditionalBranches.some((b) => check(b.branch)) || check(expr.elseBranch)
                );
            }
            if (expr instanceof ForLoop) return check(expr.body);
            for (const key of ["child", "value"] as const) {
                const child = (expr as unknown as Record<string, Expression | undefined>)[key];
                if (child && typeof child === "object" && child.constructor?.name) {
                    if (check(child)) return true;
                }
            }
            return false;
        };
        return this.body.expressions.some((e) => check(e));
    }

    toJS(writer: JSWriter): void {
        writer.write(`(`);
        writer.write(this.params.map((p) => writer.safeName(p.name)).join(", "));
        writer.write(") => ");
        writer.beginFunction();
        const needsTry = this.needsTryCatch();
        if (needsTry) {
            writer.useBuiltin("$Return$");
            writer.write("try {");
            writer.indentIn();
            writer.newLine();
        }
        this.body.expressions.slice(0, -1).forEach((expr) => {
            expr.toJS(writer);
            writer.newLine();
        });
        const lastExpr = this.body.expressions[this.body.expressions.length - 1];
        if (Block.lastExprShouldReturn(lastExpr)) {
            writer.write("return ");
        }
        lastExpr.toJS(writer);
        writer.write(";");
        if (needsTry) {
            writer.indentOut();
            writer.newLine();
            writer.write("} catch (e$$) {");
            writer.indentIn();
            writer.newLine();
            writer.write("if (e$$ instanceof $Return$) return e$$.value;");
            writer.newLine();
            writer.write("throw e$$;");
            writer.indentOut();
            writer.newLine();
            writer.write("}");
        }
        writer.endFunction();
    }
}

export class FunctionDef extends Expression {
    name: string | null;
    params: { name: string; type: Type }[];
    returnType: Type;
    body: Block;
    fullName: string;
    typeParams: string[] = [];
    monomorphizedVersions: FunctionDef[] = [];
    /** Need to maintain a list of any return statements this function has,
     * so we can check that they return a value whose type matches
     * the return type of this function */
    returnStatements: Return[] = [];

    constructor(
        rootToken: Token,
        name: string,
        params: { name: string; type: Type }[],
        returnType: Type,
        typeTraits: { type: Type; trait: Type }[],
        body: Expression,
        skipTypeValidation: boolean = false
    ) {
        if (!(body instanceof Block)) {
            throw new Error("function body must be a Block expression");
        }
        if (params.reduce((acc, p) => acc || p.name === name, false)) {
            throw new Error("function name cannot be the same as a parameter name");
        }
        super(rootToken.line, rootToken.col);
        this.name = name;
        this.params = params;
        this.returnType = returnType;
        this.body = body;
        this.fullName = functionNameWithParamTypes(
            name as string,
            params.map((p) => p.type)
        );

        // Collect type params from the where clause (types with trait bounds)
        const typeParamNames = new Set<string>();
        typeTraits.forEach(({ type, trait }) => {
            if (!(type instanceof CustomType)) {
                throw new Error(`type alias ${type} overrides a builtin type.`);
            }
            if (!(trait instanceof CustomType)) {
                throw new Error(`${trait} is not a valid trait name.`);
            }
            typeParamNames.add(type.name);
            this.params.forEach((param) => {
                if (param.type instanceof CustomType && param.type.name === type.name) {
                    param.type.addTrait(trait.name);
                }
            });
            if (this.returnType instanceof CustomType && this.returnType.name === type.name) {
                this.returnType.addTrait(trait.name);
            }
        });
        this.typeParams = [...typeParamNames];

        // When creating a monomorphized function programmatically, the types might
        // reference outer function type params — skip validation in that case.
        if (!skipTypeValidation) {
            // Validate: every type parameter must appear in at least one parameter type,
            // otherwise it can never be inferred from call arguments.
            const paramTypeNames = new Set<string>();
            this.params.forEach((p) => collectCustomTypeNames(p.type, paramTypeNames));
            for (const tp of this.typeParams) {
                if (!paramTypeNames.has(tp)) {
                    throw new Error(
                        `generic type parameter '${tp}' of function '${this.name}' must appear ` +
                            `in the type of at least one parameter so it can be inferred.`
                    );
                }
            }

            // Validate: every non-builtin, non-struct CustomType in the signature must be a type param
            const signatureTypes = new Set<string>();
            this.params.forEach((p) => collectCustomTypeNames(p.type, signatureTypes));
            collectCustomTypeNames(returnType, signatureTypes);
            for (const name of signatureTypes) {
                if (
                    !isBuiltinTypeName(name) &&
                    !getStruct(name) &&
                    !getTrait(name) &&
                    !getEnum(name) &&
                    !typeParamNames.has(name)
                ) {
                    throw new Error(
                        `unknown type '${name}' — if it's a generic type parameter, add it to a 'where' clause with a trait bound (e.g., 'where ${name} is SomeTrait')`
                    );
                }
            }
        }

        this.type = "Null";

        // Register in the global function registry (non-generic functions only)
        if (this.name && !this.isGeneric) {
            registerFunction(this);
        }
    }

    get isGeneric(): boolean {
        return this.typeParams.length > 0;
    }

    cascadeTypes(valueUsed: boolean): void {
        this.isValueUsed = valueUsed;
        // Body: last expression is the return value (always consumed).
        // Block.cascadeTypes handles per-expression valueUsed propagation.
        if (this.isGeneric) {
            this.body.cascadeTypes(true);
            return;
        }
        // Save/restore consumedVars so detrans inside function bodies doesn't
        // leak consumed status to outer scopes
        const savedConsumed = saveConsumedVars();
        this.body.cascadeTypes(true);
        restoreConsumedVars(savedConsumed);

        if (this.returnType === "Null" && this.body.type !== null && this.body.type !== "Null") {
            this.returnType = this.body.type;
        }

        if (!deepEquals(this.body.type, this.returnType)) {
            throw this.error(
                `function body should return ${this.returnType}, but found ${this.body.type}`
            );
        }

        for (const s of this.returnStatements) {
            if (!deepEquals(s.value.type, this.returnType)) {
                throw new ASTError(
                    s.line,
                    s.col,
                    `function ${this.name} with return type ${this.returnType} has a return statement that returns a value of type ${s.value.type}`
                );
            }
        }
    }

    getFuncType(): FuncType {
        return new FuncType(
            this.params.map((p) => p.type),
            this.returnType
        );
    }

    monomorphize(
        argTypes: Type[]
    ): { fullName: string; funcType: FuncType; returnType: Type } | null {
        if (!this.isGeneric) return null;
        if (this.params.length !== argTypes.length) return null;

        const bindings = new Map<string, Type>();
        if (!extractBindingsFromParams(this.params, argTypes, this.typeParams, bindings)) {
            return null;
        }

        for (const tp of this.typeParams) {
            if (!bindings.has(tp)) return null;
        }

        const concreteParamTypes = this.params.map((p) => substituteTypeParams(p.type, bindings));
        const concreteReturnType = substituteTypeParams(this.returnType, bindings);
        const monomorphizedFullName = functionNameWithParamTypes(this.name!, concreteParamTypes);

        const cached = getMonomorphized(monomorphizedFullName);
        if (cached) {
            return {
                fullName: monomorphizedFullName,
                funcType: cached.getFuncType(),
                returnType: concreteReturnType,
            };
        }

        for (const param of this.params) {
            if (param.type instanceof CustomType && param.type.traits.length > 0) {
                const concreteType = substituteTypeParams(param.type, bindings);
                const isConcrete =
                    !(concreteType instanceof CustomType) ||
                    isBuiltinTypeName(concreteType.name) ||
                    getStruct(concreteType.name) !== undefined;
                if (isConcrete) {
                    for (const traitName of param.type.traits) {
                        if (!checkTraitSatisfied(concreteType, traitName, this.name!)) {
                            return null;
                        }
                    }
                }
            }
        }

        const clonedBody = this.body.clone(bindings) as Block;

        const clonedParams = this.params.map((p) => ({
            name: p.name,
            type: substituteTypeParams(p.type, bindings),
        }));

        const monomorphized = new FunctionDef(
            { line: this.line, col: this.col, text: this.name!, type: TokenType.Func },
            this.name!,
            clonedParams,
            concreteReturnType as Type,
            [],
            clonedBody,
            true
        );

        // Fix parent pointers on the cloned subtree so findEnclosing() works
        // during cascadeTypes of the monomorphized body.
        // Link the monomorphized function into the parent chain by using
        // this function's parent so ancestor lookups reach the main AST.
        setParentPointers(monomorphized, this.parent);

        const allConcrete = clonedParams.every(
            (p) =>
                !(p.type instanceof CustomType) ||
                isBuiltinTypeName(p.type.name) ||
                getStruct(p.type.name) !== undefined
        );

        // Last body expression is return value (always consumed).
        monomorphized.body.cascadeTypes(true);
        monomorphized.sourceFile = this.sourceFile;

        if (
            this.returnType === "Null" &&
            monomorphized.body.type !== null &&
            monomorphized.body.type !== "Null"
        ) {
            monomorphized.returnType = monomorphized.body.type;
        }

        const finalReturnType =
            this.returnType === "Null" ? monomorphized.returnType : concreteReturnType;
        if (!deepEquals(monomorphized.body.type, finalReturnType)) {
            throw new ASTError(
                this.line,
                this.col,
                `monomorphized function body should return ${finalReturnType}, but found ${monomorphized.body.type}`
            );
        }

        if (allConcrete) {
            registerMonomorphized(monomorphizedFullName, monomorphized);
            this.monomorphizedVersions.push(monomorphized);
        }

        return {
            fullName: monomorphizedFullName,
            funcType: monomorphized.getFuncType(),
            returnType: monomorphized.returnType,
        };
    }

    clone(bindings?: Map<string, Type>): Expression {
        const clonedParams = this.params.map((p) => ({
            name: p.name,
            type: bindings ? substituteTypeParams(p.type, bindings) : p.type,
        }));
        const clonedReturnType = bindings
            ? substituteTypeParams(this.returnType, bindings)
            : this.returnType;
        const cloned = new FunctionDef(
            { line: this.line, col: this.col, text: this.name!, type: TokenType.Func },
            this.name!,
            clonedParams,
            clonedReturnType as Type,
            [],
            this.body.clone(bindings)
        );
        cloned.fullName = this.fullName;
        cloned.sourceFile = this.sourceFile;
        cloned.typeParams = [...this.typeParams];
        return cloned;
    }

    /** Walk the body subtree to check if any Return needs exception handling. */
    private needsTryCatch(): boolean {
        const check = (expr: Expression): boolean => {
            if (expr instanceof Return) return expr.needsException;
            if (expr instanceof DropValue) return check(expr.child);
            if (expr instanceof Block) return expr.expressions.some((e) => check(e));
            if (expr instanceof If) {
                return (
                    expr.conditionalBranches.some((b) => check(b.branch)) || check(expr.elseBranch)
                );
            }
            if (expr instanceof ForLoop) return check(expr.body);
            for (const key of ["child", "value"] as const) {
                const child = (expr as unknown as Record<string, Expression | undefined>)[key];
                if (child && typeof child === "object" && child.constructor?.name) {
                    if (check(child)) return true;
                }
            }
            return false;
        };
        return this.body.expressions.some((e) => check(e));
    }

    toJS(writer: JSWriter): void {
        if (this.isGeneric) {
            for (const v of this.monomorphizedVersions) {
                v.toJS(writer);
                writer.write(";");
                writer.newLine();
            }
            return;
        }
        writer.write(`function ${writer.safeName(this.fullName)}(`);
        writer.write(this.params.map((p) => writer.safeName(p.name)).join(", "));
        writer.write(") ");
        writer.beginFunction();
        const needsTry = this.needsTryCatch();
        if (needsTry) {
            writer.useBuiltin("$Return$");
            writer.write("try {");
            writer.indentIn();
            writer.newLine();
        }
        this.body.expressions.slice(0, -1).forEach((expr) => {
            expr.toJS(writer);
            writer.newLine();
        });
        const lastExpr = this.body.expressions[this.body.expressions.length - 1];
        if (Block.lastExprShouldReturn(lastExpr)) {
            writer.write("return ");
        }
        lastExpr.toJS(writer);
        writer.write(";");
        if (needsTry) {
            writer.indentOut();
            writer.newLine();
            writer.write("} catch (e$$) {");
            writer.indentIn();
            writer.newLine();
            writer.write("if (e$$ instanceof $Return$) return e$$.value;");
            writer.newLine();
            writer.write("throw e$$;");
            writer.indentOut();
            writer.newLine();
            writer.write("}");
        }
        writer.endFunction();
    }
}
