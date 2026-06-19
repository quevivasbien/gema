import type { JSWriter } from "../write-js";
import type { Token } from "../tokens";
import { type Type } from "../types";

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

    constructor(
        public line: number,
        public col: number
    ) {}

    error(message: string): ASTError {
        return new ASTError(this.line, this.col, message);
    }

    abstract cascadeTypes(ancestors: Expression[]): void;

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

    cascadeTypes(_ancestors: Expression[]): void {
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

    cascadeTypes(ancestors: Expression[]): void {
        // Type is already resolved as null, so just pass to children
        this.child.cascadeTypes([...ancestors, this]);
    }

    toJS(writer: JSWriter): void {
        this.child.toJS(writer);
    }

    clone(bindings?: Map<string, Type>): Expression {
        return new DropValue(this.child.clone(bindings));
    }
}
