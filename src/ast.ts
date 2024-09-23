import type { TokenType } from "./tokens";

export enum Type {
    Integer,    
    Float,
    String,
    Boolean,
    Null,
}

export abstract class Expression {
    parent: Expression | null = null;
    type: Type | null = null;

    setType(): void {
        throw new Error("`setType` not implemented on this expression type.");
    }

    getType(): Type {
        if (this.type !== null) {
            return this.type;
        }
        this.setType();
        if (this.type === null) {
            throw new Error("Failed to set type for expression");
        }
        return this.type;
    }

    compile() {
        throw new Error("`compile` not implemented on this expression type.")
    }
}

export class ErrorExpression extends Expression {
    constructor(public message: string) {
        super();
    }
}

export class DropValue extends Expression {
    constructor(public child: Expression) {
        super();
        this.type = Type.Null;
    }
}

export class Block extends Expression {
    constructor(public expressions: Expression[]) {
        if (expressions.length === 0) {
            throw new Error("found empty block expression.");
        }
        super();
    }
}

export class Literal extends Expression {
    constructor(type: Type, public value: String) {
        super();
        this.type = type;
    }
}

export class Unary extends Expression {
    constructor(public child: Expression, public operator: TokenType) {
        super();
    }
}

export class Binary extends Expression {
    constructor(public left: Expression, public right: Expression, public operator: TokenType) {
        super();
    }
}
