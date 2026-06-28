import { TokenType, type Token } from "../tokens";
import type { JSWriter } from "../write-js";
import { Scope } from "./scope";
import { type Type, type TemplateTypes } from "./types";

export class ASTError {
    constructor(
        public line: number,
        public col: number,
        public message: string,
        public sourceFile?: string
    ) {}
}

export abstract class Expression {
    type: Type | null = null;
    /** Set during pre-pass: whether this expression's value is consumed by its context */
    isValueUsed: boolean = true;
    /** Link to this node's parent in the AST tree. Set by setParentPointers(). */
    parent: Expression | null = null;
    /** The source file this expression was parsed from, or undefined for the entry file. */
    sourceFile?: string;
    /** Set before cascadeTypes to indicate which file is the entry point for multi-file compilation.
     *  Used to determine scope registration behavior for module-level definitions. */
    static entryFile: string | null = null;

    constructor(
        public line: number,
        public col: number
    ) {}

    error(message: string): ASTError {
        return new ASTError(this.line, this.col, message, this.sourceFile);
    }

    /** Walk up the parent chain to find the nearest enclosing node of the given type. */
    findEnclosing<T extends Expression>(type: new (...args: never[]) => T): T | null {
        let node: Expression | null = this.parent;
        while (node) {
            if (node instanceof type) return node;
            node = node.parent;
        }
        return null;
    }

    /**
     * Return template types if this expression carries them (e.g. Variable `Arr[Int]`),
     * or null otherwise. Subclasses with template types (Variable) override this.
     */
    getTemplateTypes(): TemplateTypes | null {
        return null;
    }

    /**
     * Gets _all_ expression nodes contained by this expression
     * Used so that third-parties can recursively walk down the AST
     */
    getAllChildren(): Expression[] {
        return [];
    }

    /**
     * Gets the scope for this expression
     * by default will walk upwards until we find a node that defines a Scope
     */
    getScope(): Scope | null {
        let parent = this.parent;
        while (parent !== null) {
            const parentScope = parent.getScope();
            if (parentScope !== null) {
                return parentScope;
            }
            parent = parent.parent;
        }
        return null;
    }

    /**
     * Whether an expression is a special control flow expression (break, continue, return)
     * that needs exception handling to break out of nested IIFEs
     */
    needsExceptionForControlFlow(): boolean {
        return false;
    }

    /**
     * Whether this expression acts as a function boundary for IIFE-aware control flow
     * (break/continue/return). Function definitions stop the upward walk when checking
     * whether a control flow node needs exception handling.
     */
    isFunctionBoundary(): boolean {
        return false;
    }

    /**
     * Whether this expression acts as a loop boundary for IIFE-aware control flow.
     * ForLoop stops the upward walk when checking break/continue.
     */
    isLoopBoundary(): boolean {
        return false;
    }

    /**
     * If this expression is a for-loop with a named iteration variable, return the variable name.
     * Used by Variable.cascadeTypes to resolve loop variable types without instanceof checks.
     */
    getLoopVariableName(): string | null {
        return null;
    }

    /**
     * Return the inner (element) type of this node's iterator expression, if any.
     * Used by Variable.cascadeTypes to resolve the type of loop variables.
     */
    getLoopVariableInnerType(): Type | null {
        return null;
    }

    /**
     * Walks recursively through the AST, resolving types
     * This is also where parent pointers get set for all AST nodes,
     * and where we propogate information about whether the values returned from downstream
     * expressions will end up getting consumed higher in the AST.
     */
    cascadeTypes(parent: Expression | null, valueUsed: boolean) {
        this.parent = parent;
        this.isValueUsed = valueUsed;
    }

    toJS(_writer: JSWriter): void {
        throw new Error(`\`toJS\` not implemented for ${this.constructor.name}.`);
    }

    // Deep-clone this expression tree, optionally substituting type parameters
    abstract clone(bindings?: Map<string, Type>): Expression;
}

export class ErrorExpression extends Expression {
    constructor(
        token: Token,
        public message: string
    ) {
        super(token.line, token.col);
    }

    clone(_bindings?: Map<string, Type>): Expression {
        return this; // Error expressions don't need deep cloning
    }
}

export class DropValue extends Expression {
    constructor(public child: Expression) {
        super(child.line, child.col);
    }

    getAllChildren(): Expression[] {
        return [this.child];
    }

    cascadeTypes(parent: Expression | null, valueUsed: boolean): void {
        super.cascadeTypes(parent, valueUsed);
        // DropValue type is always "Null"
        this.type = "Null";
        this.child.cascadeTypes(this, false);
    }

    toJS(writer: JSWriter): void {
        this.child.toJS(writer);
    }

    clone(bindings?: Map<string, Type>): Expression {
        return new DropValue(this.child.clone(bindings));
    }
}

/**
 * Helper to determine if the last expression in a sequence of values has a non-null type */
export function lastExprShouldReturn(lastExpr: Expression): boolean {
    // Recurse through nested blocks to check if the ultimate last expression
    // is a value-producing expression or a control flow node.
    if (lastExpr instanceof Block) {
        return lastExprShouldReturn(lastExpr.expressions[lastExpr.expressions.length - 1]);
    }
    return lastExpr.type !== "Null";
}

/**
 * A container expression that contains a sequence of expressions.
 * Is value is the value of the final expression in the sequence.
 * Cannot be empty.
 */
export class Block extends Expression {
    expressions: Expression[];
    scope: Scope = new Scope();
    /** JS module imports collected from UseJSModule nodes during cascadeTypes.
     *  Maps module path → array of imported symbol names.
     *  Only meaningful on the top-level Block. */
    jsImports: Map<string, string[]>;

    constructor(rootToken: Token, expressions: Expression[], jsImports: Map<string, string[]> = new Map()) {
        super(rootToken.line, rootToken.col);
        if (expressions.length === 0) {
            throw new Error("block expression must not be empty.");
        }
        this.expressions = expressions;
        this.jsImports = jsImports;
    }

    /** Register a JS module import on this block. */
    addJSImport(path: string, names: string[]): void {
        if (this.jsImports.has(path)) {
            const existing = this.jsImports.get(path)!;
            this.jsImports.set(path, [...existing, ...names]);
        } else {
            this.jsImports.set(path, [...names]);
        }
    }

    getAllChildren(): Expression[] {
        return this.expressions;
    }

    getScope(): Scope | null {
        return this.scope;
    }

    cascadeTypes(parent: Expression | null, valueUsed: boolean): void {
        super.cascadeTypes(parent, valueUsed);
        // Chain this block's scope to its enclosing scope so variable lookups
        // from inside this block can find variables defined in enclosing scopes
        // (params, outer assignments, etc.)
        const parentScope = this.parent?.getScope();
        if (parentScope && this.scope.parent === null) {
            this.scope.parent = parentScope;
        }
        for (let i = 0; i < this.expressions.length; i++) {
            const childValueUsed = i === this.expressions.length - 1 ? valueUsed : false;
            this.expressions[i].cascadeTypes(this, childValueUsed);
        }
        this.type = this.expressions[this.expressions.length - 1].type;
    }

    clone(bindings?: Map<string, Type>): Expression {
        return new Block(
            { line: this.line, col: this.col, text: "", type: TokenType.LBrace },
            this.expressions.map((e) => e.clone(bindings)),
            new Map(this.jsImports),
        );
    }

    toJS(writer: JSWriter): void {
        const lastExpr = this.expressions[this.expressions.length - 1];
        const shouldReturn = this.isValueUsed && lastExprShouldReturn(lastExpr);
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
}
