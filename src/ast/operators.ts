import { TokenType, type Token } from "../tokens";
import type { JSWriter } from "../write-js";
import { findCaller } from "./caller-resolution";
import { Expression } from "./expression";
import { typeEquals } from "./type-utils";
import { ArrayType, CustomType, GenericType, IterType } from "./types";

// Operator overloading — maps TokenType to function names for user-defined types
const OPERATOR_TO_FUNCTION: Partial<Record<string, string>> = {
    [TokenType.Plus]: "add",
    [TokenType.Minus]: "subtract",
    [TokenType.Star]: "multiply",
    [TokenType.Slash]: "divide",
    [TokenType.SlashSlash]: "intDiv",
    [TokenType.Percent]: "modulo",
    [TokenType.PercentPercent]: "eucModulo",
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
    [TokenType.Percent]: "%",
    [TokenType.Caret]: "**",
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

    getAllChildren(): Expression[] {
        return [this.child];
    }

    cascadeTypes(parent: Expression | null, valueUsed: boolean): void {
        super.cascadeTypes(parent, valueUsed);
        this.child.cascadeTypes(this, valueUsed);

        switch (this.child.type) {
            case "Int":
                if (this.operator === TokenType.Minus) {
                    this.type = "Int";
                    return;
                }
                break;
            case "Num":
                if (this.operator === TokenType.Minus) {
                    this.type = "Num";
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

    toJS(writer: JSWriter): void {
        writer.write(`(${this.operator}(`);
        this.child.toJS(writer);
        writer.write("))");
    }
}

export class Binary extends Expression {
    operator: TokenType;
    toJSOverload: ((writer: JSWriter) => void) | null = null;
    /** Set when operator overloading resolves: the function name (e.g. "multiply"). */
    resolvedOverloadName: string | null = null;

    constructor(
        operatorToken: Token,
        public left: Expression,
        public right: Expression
    ) {
        super(operatorToken.line, operatorToken.col);
        this.operator = operatorToken.type;
    }

    getAllChildren(): Expression[] {
        return [this.left, this.right];
    }

    cascadeTypes(parent: Expression | null, valueUsed: boolean): void {
        super.cascadeTypes(parent, valueUsed);
        this.left.cascadeTypes(this, valueUsed);
        this.right.cascadeTypes(this, valueUsed);

        const [ltype, rtype] = [this.left.type, this.right.type];

        if (ltype === null) {
            throw this.error("Left-hand side of expression has null type");
        }
        if (rtype === null) {
            throw this.error("Right-hand side of expression has null type");
        }

        // Enforce that left-hand type == right-hand type for all binary ops
        if (!typeEquals(ltype, rtype)) {
            throw this.error(
                `Cannot use operator ${this.operator} with left operand of type ${ltype} and right operand of type ${rtype}.`
            );
        }

        const NUMERIC_OPS = [
            TokenType.Plus,
            TokenType.Minus,
            TokenType.Star,
            TokenType.Slash,
            TokenType.SlashSlash,
            TokenType.Percent,
            TokenType.PercentPercent,
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
                if (rtype === "Int" || rtype === "Num") {
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

            case "Num":
                if (rtype === "Int" || rtype === "Num") {
                    if (NUMERIC_OPS.includes(this.operator)) {
                        this.type = "Num";
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
            if (typeEquals(ltype.innerType, rtype.innerType) && this.operator === TokenType.Plus) {
                this.type = ltype;
                return;
            }
            if (
                typeEquals(ltype.innerType, rtype.innerType) &&
                this.operator === TokenType.EqualEqual
            ) {
                this.type = "Bool";
                return;
            }
        }
        if (
            ltype instanceof IterType &&
            (rtype instanceof IterType || rtype instanceof ArrayType)
        ) {
            if (typeEquals(ltype.innerType, rtype.innerType) && this.operator === TokenType.Plus) {
                this.type = ltype;
                return;
            }
        }

        // Try operator overloading for user-defined types and generic types with traits
        // TODO: This maybe should work via a system of built-in traits instead
        if (
            (ltype instanceof CustomType ||
                rtype instanceof CustomType ||
                ltype instanceof GenericType ||
                rtype instanceof GenericType) &&
            !(ltype instanceof ArrayType) &&
            !(rtype instanceof ArrayType) &&
            !(ltype instanceof IterType) &&
            !(rtype instanceof IterType)
        ) {
            const opName = OPERATOR_TO_FUNCTION[this.operator];
            if (opName) {
                const { error, result } = findCaller(this, opName, [this.left, this.right]);
                if (error === null) {
                    this.type = result.returnType;
                    this.toJSOverload = result.toJS;
                    this.resolvedOverloadName = opName;
                    return;
                }
            }
        }
        throw this.error(
            `Cannot use operator ${this.operator} with left operand of type ${ltype} and right operand of type ${rtype}.`
        );
    }

    toJS(writer: JSWriter): void {
        if (this.toJSOverload) {
            this.toJSOverload(writer);
            return;
        }
        // Handle + for arrays (array concatenation)
        if (this.left.type instanceof ArrayType && this.right.type instanceof ArrayType) {
            if (this.operator === TokenType.Plus) {
                writer.write("[...");
                this.left.toJS(writer);
                writer.write(", ...");
                this.right.toJS(writer);
                writer.write("]");
                return;
            } else if (this.operator === TokenType.EqualEqual) {
                writer.useBuiltin("$arrayEq$");
                writer.write("$arrayEq$(");
                this.left.toJS(writer);
                writer.write(", ");
                this.right.toJS(writer);
                writer.write(")");
                return;
            }
        }
        // Handle + for iterators (iterator concatenation)
        if (this.left.type instanceof IterType || this.right.type instanceof IterType) {
            if (this.operator === TokenType.Plus) {
                writer.useBuiltin("$ConcatIterator$");
                writer.write("new $ConcatIterator$(");
                if (this.left.type instanceof ArrayType) {
                    writer.useBuiltin("$ArrayIterator$");
                    writer.write("new $ArrayIterator$(");
                    this.left.toJS(writer);
                    writer.write("), ");
                } else {
                    this.left.toJS(writer);
                    writer.write(", ");
                }
                if (this.right.type instanceof ArrayType) {
                    writer.useBuiltin("$ArrayIterator$");
                    writer.write("new $ArrayIterator$(");
                    this.right.toJS(writer);
                    writer.write("))");
                } else {
                    this.right.toJS(writer);
                    writer.write(")");
                }
                return;
            }
        }
        if (this.operator === TokenType.PercentPercent) {
            // Euclidean modulo (%%): uses $mod$ builtin
            writer.useBuiltin("$mod$");
            writer.write("$mod$(");
            this.left.toJS(writer);
            writer.write(", ");
            this.right.toJS(writer);
            writer.write(")");
            return;
        }
        if (this.operator === TokenType.SlashSlash) {
            // Integer division (//): for Num use Math.floor, for Int, this functions the same as "/"
            if (this.left.type === "Int" && this.right.type === "Int") {
                writer.write("(");
                this.left.toJS(writer);
                writer.write(" / ");
                this.right.toJS(writer);
                writer.write(")");
            } else {
                writer.write("Math.floor(");
                this.left.toJS(writer);
                writer.write(" / ");
                this.right.toJS(writer);
                writer.write(")");
            }
            return;
        }
        if (Object.keys(OPERATOR_TRANSLATIONS).includes(this.operator)) {
            writer.write("(");
            this.left.toJS(writer);
            writer.write(` ${OPERATOR_TRANSLATIONS[this.operator]} `);
            this.right.toJS(writer);
            writer.write(")");
            return;
        }
        throw this.error(`tried to use token ${this.operator} as binary operator`);
    }
}
