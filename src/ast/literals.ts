import type { JSWriter } from "../write-js";
import type { Token } from "../tokens";
import { type Type } from "../types";
import { Expression } from "./expression";

export class Literal extends Expression {
    value: string;

    constructor(token: Token, type: Type) {
        super(token.line, token.col);
        this.value = token.text;
        this.type = type;
    }

    cascadeTypes(_ancestors: Expression[]): void {
        // Type is already resolved; no need to do anything
    }

    clone(_bindings?: Map<string, Type>): Expression {
        return this; // Literals are immutable, safe to share
    }

    toJS(compiler: JSWriter): void {
        switch (this.type) {
            case "Int":
                compiler.write(`${this.value}n`);
                break;
            case "Float":
                compiler.write(this.value);
                break;
            case "Str":
                compiler.write(this.value);
                break;
            case "Bool":
                compiler.write(this.value);
                break;
            default:
                throw this.error(`cannot use token ${this.value} as literal type`);
        }
    }
}
