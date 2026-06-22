import type { Token } from "../tokens";
import type { JSWriter } from "../write-js";
import { type Type } from "./types";

export class ASTError {
    constructor(
        public line: number,
        public col: number,
        public message: string
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

    constructor(
        public line: number,
        public col: number
    ) {}

    error(message: string): ASTError {
        return new ASTError(this.line, this.col, message);
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

    abstract cascadeTypes(valueUsed: boolean): void;

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

    cascadeTypes(valueUsed: boolean): void {
        this.isValueUsed = valueUsed;
        // noop
    }

    clone(_bindings?: Map<string, Type>): Expression {
        return this; // Error expressions don't need deep cloning
    }
}

export class DropValue extends Expression {
    constructor(public child: Expression) {
        super(child.line, child.col);
        this.type = "Null";
    }

    cascadeTypes(valueUsed: boolean): void {
        this.isValueUsed = valueUsed;
        // Type is already resolved as null, so just pass to children
        this.child.cascadeTypes(false);
    }

    toJS(writer: JSWriter): void {
        this.child.toJS(writer);
    }

    clone(bindings?: Map<string, Type>): Expression {
        return new DropValue(this.child.clone(bindings));
    }
}
