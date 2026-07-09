import type { Token } from "../tokens";
import type { JSWriter } from "../write-js";
import { Expression } from "./expression";
import { typeEquals } from "./type-utils";
import { ArrayType, type Type } from "./types";

const MAX_SAFE_INTEGER = 9007199254740991;
const MIN_SAFE_INTEGER = -9007199254740991;

export class Literal extends Expression {
    value: string;

    constructor(token: Token, type: Type) {
        super(token.line, token.col);
        this.value = token.text;
        this.type = type;

        if (
            this.type !== "Int" &&
            this.type !== "Num" &&
            this.type !== "Bool" &&
            this.type !== "Str"
        ) {
            throw this.error(`invalid literal type: ${this.type}`);
        }
    }

    cascadeTypes(parent: Expression | null, valueUsed: boolean): void {
        super.cascadeTypes(parent, valueUsed);
        // For Num literals without decimal point or scientific notation,
        // check that the value is within safe integer range (53 bits of precision)
        if (
            this.type === "Num" &&
            !this.value.includes(".") &&
            !this.value.includes("e") &&
            !this.value.includes("E")
        ) {
            const num = BigInt(this.value);
            if (num > MAX_SAFE_INTEGER || num < MIN_SAFE_INTEGER) {
                throw this.error(
                    `Num literal ${this.value} is outside the safe integer range (±${MAX_SAFE_INTEGER}). ` +
                        `Add a decimal point (e.g., "${this.value}.0") or use scientific notation ` +
                        `(e.g., "${this.value}e0") if this is intended as a floating-point value, ` +
                        `or use the Int type (e.g., "${this.value}i") for arbitrary-size integers.`
                );
            }
        }
    }

    toJS(compiler: JSWriter): void {
        switch (this.type) {
            case "Int":
                // The regex replace here is to remove leading zeros so we don't attempt to represent them as octal
                compiler.write(`${this.value.replace(/^0+(?=.)/, "")}n`);
                break;
            case "Num":
                // The regex replace here is to remove extra leading zeros so we don't attempt to represent them as octal
                compiler.write(this.value.replace(/^0+?(?=0\.|[^0.])/, ""));
                break;
            case "Bool":
                compiler.write(this.value);
                break;
            case "Str":
                compiler.write(this.value);
                break;
            default:
                throw this.error(`cannot use token ${this.value} as literal type`);
        }
    }
}

export class ArrLit extends Expression {
    expressions: Expression[];
    innerType?: Type;

    constructor(startToken: Token, expressions: Expression[], innerType?: Type) {
        super(startToken.line, startToken.col);
        this.expressions = expressions;
        if (innerType !== undefined) {
            this.innerType = innerType;
        }
    }

    cascadeTypes(parent: Expression | null, valueUsed: boolean): void {
        super.cascadeTypes(parent, valueUsed);
        this.expressions.forEach((expr, i) => {
            expr.cascadeTypes(this, true);
            if (expr.type === null) {
                throw this.error(`unable to resolve type of array element ${i + 1}`);
            }
            if (this.innerType === undefined) {
                this.innerType = expr.type;
            } else if (!typeEquals(this.innerType, expr.type)) {
                throw this.error(
                    `incompatible types in array: expected ${this.innerType}, got ${expr.type}`
                );
            }
        });
        if (this.innerType === undefined) {
            throw this.error(`empty array must be annotated with a type`);
        }
        this.type = new ArrayType(this.innerType);
    }

    toJS(writer: JSWriter): void {
        writer.write("[");
        this.expressions.forEach((expr, i) => {
            if (i > 0) {
                writer.write(", ");
            }
            expr.toJS(writer);
        });
        writer.write("]");
    }
}
