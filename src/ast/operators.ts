import type { JSWriter } from "../write-js";
import { TokenType, type Token } from "../tokens";
import { ArrayType, CustomType, IterType, type Type } from "../types";
import { Expression } from "./expression";
import { findCaller } from "./caller";
import { deepEquals } from "../deep-equals";

// Operator overloading — maps TokenType to function names for user-defined types
const OPERATOR_TO_FUNCTION: Partial<Record<string, string>> = {
    [TokenType.Plus]: "add",
    [TokenType.Minus]: "subtract",
    [TokenType.Star]: "multiply",
    [TokenType.Slash]: "divide",
    [TokenType.Percent]: "modulo",
    [TokenType.EqualEqual]: "equal",
    [TokenType.BangEqual]: "notEqual",
    [TokenType.Less]: "less",
    [TokenType.LessEqual]: "lessEqual",
    [TokenType.Greater]: "greater",
    [TokenType.GreaterEqual]: "greaterEqual",
};

const OPERATOR_TRANSLATIONS: Record<string, string> = {
    [TokenType.Plus]: "+",
    [TokenType.Minus]: "-",
    [TokenType.Star]: "*",
    [TokenType.Slash]: "/",
    [TokenType.Greater]: ">",
    [TokenType.GreaterEqual]: ">=",
    [TokenType.Less]: "<",
    [TokenType.LessEqual]: "<=",
    [TokenType.EqualEqual]: "==",
    [TokenType.BangEqual]: "!=",
    [TokenType.And]: "&&",
    [TokenType.Or]: "||",
};

export class Unary extends Expression {
    operator: TokenType;

    constructor(
        operatorToken: Token,
        public child: Expression
    ) {
        super(operatorToken.line, operatorToken.col);
        this.operator = operatorToken.type;
    }

    cascadeTypes(ancestors: Expression[]): void {
        this.child.cascadeTypes([...ancestors, this]);

        switch (this.child.type) {
            case "Int":
                if (this.operator === TokenType.Minus) {
                    this.type = "Int";
                    return;
                }
                break;
            case "Float":
                if (this.operator === TokenType.Minus) {
                    this.type = "Float";
                    return;
                }
                break;
            case "Bool":
                if (this.operator === TokenType.Bang) {
                    this.type = "Bool";
                    return;
                }
                break;
        }
        throw this.error(
            `cannot use token ${this.operator} on expression of type ${this.child.type}.`
        );
    }

    clone(bindings?: Map<string, Type>): Expression {
        const cloned = new Unary(
            {
                line: this.line,
                col: this.col,
                text: this.operator,
                type: this.operator as TokenType,
            },
            this.child.clone(bindings)
        );
        return cloned;
    }

    toJS(writer: JSWriter): void {
        writer.write(`(${this.operator}(`);
        this.child.toJS(writer);
        writer.write("))");
    }
}

export class Binary extends Expression {
    operator: TokenType;
    overloadedAs?: { name: string };

    constructor(
        operatorToken: Token,
        public left: Expression,
        public right: Expression
    ) {
        super(operatorToken.line, operatorToken.col);
        this.operator = operatorToken.type;
    }

    cascadeTypes(ancestors: Expression[]): void {
        this.left.cascadeTypes([...ancestors, this]);
        this.right.cascadeTypes([...ancestors, this]);

        const [ltype, rtype] = [this.left.type, this.right.type];

        if (ltype === null) {
            throw this.error("Left-hand side of expression has null type");
        }
        if (rtype === null) {
            throw this.error("Right-hand side of expression has null type");
        }

        const NUMERIC_OPS = [
            TokenType.Plus,
            TokenType.Minus,
            TokenType.Star,
            TokenType.Slash,
            TokenType.Percent,
            TokenType.Caret,
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
            case "Int":
                if (rtype === "Int" || rtype === "Float") {
                    if (NUMERIC_OPS.includes(this.operator)) {
                        this.type = rtype;
                        return;
                    }
                    if (COMPARISON_OPS.includes(this.operator)) {
                        this.type = "Bool";
                        return;
                    }
                }
                break;

            case "Float":
                if (rtype === "Int" || rtype === "Float") {
                    if (NUMERIC_OPS.includes(this.operator)) {
                        this.type = "Float";
                        return;
                    }
                    if (COMPARISON_OPS.includes(this.operator)) {
                        this.type = "Bool";
                        return;
                    }
                }
                break;

            case "Str":
                if (rtype === "Str" && this.operator === TokenType.Plus) {
                    this.type = "Str";
                    return;
                } else if (rtype === "Str" && COMPARISON_OPS.includes(this.operator)) {
                    this.type = "Bool";
                    return;
                }
                break;

            case "Bool":
                if (rtype === "Bool" && BOOLEAN_OPS.includes(this.operator)) {
                    this.type = "Bool";
                    return;
                }
                break;
        }
        if (ltype instanceof ArrayType && rtype instanceof ArrayType) {
            if (deepEquals(ltype.innerType, rtype.innerType) && this.operator === TokenType.Plus) {
                this.type = ltype;
                return;
            }
            if (
                deepEquals(ltype.innerType, rtype.innerType) &&
                this.operator === TokenType.EqualEqual
            ) {
                this.type = "Bool";
                return;
            }
        }

        // Try operator overloading for user-defined types
        if (
            (ltype instanceof CustomType || rtype instanceof CustomType) &&
            !(ltype instanceof ArrayType) &&
            !(rtype instanceof ArrayType) &&
            !(ltype instanceof IterType) &&
            !(rtype instanceof IterType)
        ) {
            const opName = OPERATOR_TO_FUNCTION[this.operator];
            if (opName) {
                const { error, result } = findCaller(this, ancestors, opName, [ltype, rtype]);
                if (error === null) {
                    this.type = result.rootType;
                    this.overloadedAs = { name: result.referToByName };
                    return;
                }
            }
        }
        throw this.error(
            `cannot use operator ${this.operator} with left operand of type ${ltype} and right operand of type ${rtype}.`
        );
    }

    clone(bindings?: Map<string, Type>): Expression {
        const cloned = new Binary(
            {
                line: this.line,
                col: this.col,
                text: this.operator,
                type: this.operator as TokenType,
            },
            this.left.clone(bindings),
            this.right.clone(bindings)
        );
        return cloned;
    }

    toJS(writer: JSWriter): void {
        if (this.overloadedAs) {
            writer.write(writer.safeName(this.overloadedAs.name));
            writer.write("(");
            this.left.toJS(writer);
            writer.write(", ");
            this.right.toJS(writer);
            writer.write(")");
            return;
        }
        if (this.left.type instanceof ArrayType) {
            if (this.operator === TokenType.Plus) {
                this.left.toJS(writer);
                writer.write(".concat(");
                this.right.toJS(writer);
                writer.write(")");
                return;
            } else if (this.operator === TokenType.EqualEqual) {
                writer.useBuiltin("__ARRAY_EQUAL__");
                writer.write("__ARRAY_EQUAL__(");
                this.left.toJS(writer);
                writer.write(", ");
                this.right.toJS(writer);
                writer.write(")");
                return;
            }
        }
        if (Object.keys(OPERATOR_TRANSLATIONS).includes(this.operator)) {
            writer.write("(");
            this.left.toJS(writer);
            writer.write(` ${OPERATOR_TRANSLATIONS[this.operator]} `);
            this.right.toJS(writer);
            writer.write(")");
            return;
        } else if (this.operator === TokenType.Percent) {
            writer.useBuiltin("__MOD__");
            writer.write("__MOD__(");
            this.left.toJS(writer);
            writer.write(", ");
            this.right.toJS(writer);
            writer.write(")");
            return;
        } else if (this.operator === TokenType.Caret) {
            this.left.toJS(writer);
            writer.write(" ** ");
            this.right.toJS(writer);
            return;
        }
        throw this.error(`tried to use token ${this.operator} as binary operator`);
    }
}
