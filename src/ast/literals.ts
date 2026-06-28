import type { Token } from "../tokens";
import type { JSWriter } from "../write-js";
import { Expression } from "./expression";
import { type Type } from "./types";

const MAX_SAFE_INTEGER = 9007199254740991;
const MIN_SAFE_INTEGER = -9007199254740991;

export class Literal extends Expression {
    value: string;

    constructor(token: Token, type: Type) {
        super(token.line, token.col);
        this.value = token.text;
        this.type = type;
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

    clone(_bindings?: Map<string, Type>): Expression {
        return this; // Literals are immutable, safe to share
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
            case "Str":
                compiler.write(this.value);
                break;
            case "Bool":
                compiler.write(this.value);
                break;
            case "Null":
                compiler.write("undefined");
                break;
            default:
                throw this.error(`cannot use token ${this.value} as literal type`);
        }
    }
}
