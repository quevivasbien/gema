import type { JSWriter } from "./write-js";
import { TokenType } from "./tokens";

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
        throw new Error(`\`setType\` not implemented for ${this.constructor.name}.`);
    }

    getType(): Type {
        if (this.type !== null) {
            return this.type;
        }
        this.setType();
        if (this.type === null) {
            throw new Error(`Failed to set type for ${this.constructor.name} expression`);
        }
        return this.type;
    }

    toJS(writer: JSWriter): void {
        throw new Error(`\`toJS\` not implemented for ${this.constructor.name}.`)
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

    toJS(writer: JSWriter): void {
        this.child.toJS(writer);
    }
}

export class Block extends Expression {
    constructor(public expressions: Expression[]) {
        if (expressions.length === 0) {
            throw new Error("found empty block expression.");
        }
        super();
    }

    toJS(writer: JSWriter): void {
        writer.write("(() => {");
        writer.indentIn();
        writer.newLine();
        for (const expression of this.expressions.slice(0, -1)) {
            expression.toJS(writer);
            writer.write(";");
            writer.newLine();
        }
        const lastExpr = this.expressions[this.expressions.length - 1];
        if (lastExpr instanceof DropValue) {
            lastExpr.toJS(writer);
            writer.write(";");
            writer.newLine();
            writer.write("return null;");
        } else {
            writer.write("return ");
            lastExpr.toJS(writer);
            writer.write(";");
        }
        writer.indentOut();
        writer.newLine();
        writer.write("})()");
    }
}

export class Literal extends Expression {
    constructor(type: Type, public value: string) {
        super();
        this.type = type;
    }


    toJS(compiler: JSWriter): void {
        // TODO: Check types
        switch (this.type) {
            case Type.Integer:
                compiler.write(`BigInt(${this.value})`);
                break;
            case Type.Float:
                compiler.write(`${this.value}`);
                break;
            case Type.String:
                compiler.write(`"${this.value}"`);
                break;
            case Type.Boolean:
                compiler.write(this.value);
        }
    }
}

export class Unary extends Expression {
    constructor(public child: Expression, public operator: TokenType) {
        super();
    }

    toJS(writer: JSWriter): void {
        // TODO: Check types
        if (this.operator === TokenType.Minus) {
            writer.write("(-");
            this.child.toJS(writer);
            writer.write(")");
            return;
        }
        throw new Error(`tried to use token ${this.operator} as unary operator`);
    }
}

const OPERATOR_TRANSLATIONS: Record<string, string> = {
    [TokenType.Plus]: "+",
    [TokenType.Minus]: "-",
    [TokenType.Star]: "*",
    [TokenType.Slash]: "/",
    [TokenType.Greater]: ">",
    [TokenType.GreaterEqual]: ">=",
    [TokenType.Less]: "<",
    [TokenType.LessEqual]: "<=",
    [TokenType.EqualEqual]: "===",
    [TokenType.BangEqual]: "!==",
    [TokenType.And]: "&&",
    [TokenType.Or]: "||",
};

export class Binary extends Expression {
    constructor(public left: Expression, public right: Expression, public operator: TokenType) {
        super();
    }

    toJS(writer: JSWriter): void {
        // TODO: Check types
        if ([
            TokenType.Plus,
            TokenType.Minus,
            TokenType.Star,
            TokenType.Slash,
            TokenType.Greater,
            TokenType.GreaterEqual,
            TokenType.Less,
            TokenType.LessEqual,
            TokenType.EqualEqual,
            TokenType.BangEqual,
            TokenType.And,
            TokenType.Or,
        ].includes(this.operator)) {
            writer.write("(");
            this.left.toJS(writer);
            writer.write(` ${OPERATOR_TRANSLATIONS[this.operator]} `);
            this.right.toJS(writer);
            writer.write(")");
            return;
        }
        throw new Error(`tried to use token ${this.operator} as binary operator`);
    }
}

export class Variable extends Expression {
    constructor(public name: string) {
        super();
    }
}

export class Assignment extends Expression {
    constructor(public name: string, public value: Expression) {
        super();
    }
}