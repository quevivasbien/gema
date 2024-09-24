import type { JSWriter } from "./write-js";
import { TokenType } from "./tokens";

export enum Type {
    Integer = "Int",    
    Float = "Float",
    String = "Str",
    Boolean = "Bool",
    Null = "Null",
}

export abstract class Expression {
    type: Type | null = null;
    
    abstract cascadeLineage(ancestors: Expression[], olderSiblings?: Expression[]): void;

    toJS(writer: JSWriter): void {
        throw new Error(`\`toJS\` not implemented for ${this.constructor.name}.`)
    }
}

export class ErrorExpression extends Expression {

    constructor(public message: string) {
        super();
    }

    cascadeLineage(ancestors: Expression[], olderSiblings?: Expression[]): void {
        // noop
    }
}

export class DropValue extends Expression {
    constructor(public child: Expression) {
        super();
        this.type = Type.Null;
    }

    cascadeLineage(ancestors: Expression[], olderSiblings?: Expression[]): void {
        // Type is already resolved as null, so just pass to children
        this.child.cascadeLineage([...ancestors, this]);
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

    cascadeLineage(ancestors: Expression[], olderSiblings?: Expression[]): void {
        const siblings: Expression[] = [];
        for (const expression of this.expressions) {
            expression.cascadeLineage([...ancestors, this], siblings);
            siblings.push(expression);
        }
        // Resolve type based on last child
        this.type = this.expressions[this.expressions.length - 1].type;
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

    cascadeLineage(ancestors: Expression[], olderSiblings?: Expression[]): void {
        // Type is already resolved; no need to do anything
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

    cascadeLineage(ancestors: Expression[], olderSiblings?: Expression[]): void {
        this.child.cascadeLineage([...ancestors, this]);

        switch (this.child.type) {
            case Type.Integer:
                if (this.operator === TokenType.Minus) {
                    this.type = Type.Integer;
                    return;
                }
                break;
            case Type.Float:
                if (this.operator === TokenType.Minus) {
                    this.type = Type.Float;
                    return;
                }
                break;
            case Type.Boolean:
                if (this.operator === TokenType.Bang) {
                    this.type = Type.Boolean;
                    return;
                }
                break;
        }
        throw new Error(`cannot use token ${this.operator} on expression of type ${this.child.type}.`);
    }

    toJS(writer: JSWriter): void {
        writer.write(`(${this.operator}`);
        this.child.toJS(writer);
        writer.write(")");
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

    cascadeLineage(ancestors: Expression[], olderSiblings?: Expression[]): void {
        this.left.cascadeLineage([...ancestors, this]);
        this.right.cascadeLineage([...ancestors, this], [this.left]);

        const [ltype, rtype] = [this.left.type, this.right.type];

        const NUMERIC_OPS = [
            TokenType.Plus,
            TokenType.Minus,
            TokenType.Star,
            TokenType.Slash,
        ];
        const COMPARISON_OPS = [
            TokenType.Greater,
            TokenType.GreaterEqual,
            TokenType.Less,
            TokenType.LessEqual,
            TokenType.EqualEqual,
            TokenType.BangEqual,
        ];
        const BOOLEAN_OPS = [
            TokenType.And,
            TokenType.Or,
            TokenType.EqualEqual,
            TokenType.BangEqual,
        ];

        switch (ltype) {
            case Type.Integer:
                if (
                    rtype === Type.Integer ||
                    rtype === Type.Float
                ) {
                    if (NUMERIC_OPS.includes(this.operator)) {
                        this.type = rtype;
                        return;
                    }
                    if (COMPARISON_OPS.includes(this.operator)) {
                        this.type = Type.Boolean;
                        return;
                    }
                }
                break;

            case Type.Float:
                if (
                    rtype === Type.Integer ||
                    rtype === Type.Float
                ) {
                    if (NUMERIC_OPS.includes(this.operator)) {
                        this.type = Type.Float;
                        return;
                    }
                    if (COMPARISON_OPS.includes(this.operator)) {
                        this.type = Type.Boolean;
                        return;
                    }
                }
                break;

            case Type.String:
                if (
                    rtype === Type.String &&
                    this.operator === TokenType.Plus
                ) {
                    this.type = Type.String;
                    return;
                } else if (
                    rtype === Type.String &&
                    COMPARISON_OPS.includes(this.operator)
                ) {
                    this.type = Type.Boolean;
                    return;
                }
                break;

            case Type.Boolean:
                if (
                    rtype === Type.Boolean &&
                    BOOLEAN_OPS.includes(this.operator)
                ) {
                    this.type = Type.Boolean;
                    return;
                }
                break;
        }
        throw new Error(`cannot use operator ${this.operator} with left operand of type ${ltype} and right operand of type ${rtype}.`);
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

    cascadeLineage(ancestors: Expression[], olderSiblings?: Expression[]): void {
        // TODO: Resolve type
    }

    toJS(writer: JSWriter): void {
        writer.write(this.name);
    }
}

export class Assignment extends Expression {
    isDropped = false;

    constructor(public name: string, public value: Expression) {
        super();
    }

    cascadeLineage(ancestors: Expression[], olderSiblings?: Expression[]): void {
        const parent = ancestors[ancestors.length - 1];
        if (parent instanceof DropValue) {
            this.isDropped = true;
        }
        // Don't include self in children's lineage, to avoid problems with recursive definitions
        this.value.cascadeLineage([...ancestors]);

        this.type = this.isDropped ? Type.Null : this.value.type;
    }

    toJS(writer: JSWriter): void {
        writer.declareVariable(this.name);
        if (this.isDropped) {
            writer.write(`${this.name} = `);
            this.value.toJS(writer);
        } else {
            writer.write(`(() => { ${this.name} = `);
            this.value.toJS(writer);
            writer.write(`; return ${this.name}; })()`);
        }
    }
}