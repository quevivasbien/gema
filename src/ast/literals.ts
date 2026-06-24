import type { Token } from "../tokens";
import type { JSWriter } from "../write-js";
import type { RustWriter } from "../write-rust";
import { Expression } from "./expression";
import { type Type } from "./types";

export class Literal extends Expression {
    value: string;

    constructor(token: Token, type: Type) {
        super(token.line, token.col);
        this.value = token.text;
        this.type = type;
    }

    cascadeTypes(valueUsed: boolean): void {
        this.isValueUsed = valueUsed;
        // Type is already resolved; no need to do anything
    }

    clone(_bindings?: Map<string, Type>): Expression {
        return this; // Literals are immutable, safe to share
    }

    toJS(compiler: JSWriter): void {
        switch (this.type) {
            case "Int":
                // The regex replace here is to remove leading zeros so we don't attempt to represent them as octal
                compiler.write(`${this.value.replace(/^0+(?=.)/, "")}`);
                break;
            case "Float":
                // The regex replace here is to remove extra leading zeros so we don't attempt to represent them as octal
                compiler.write(this.value.replace(/^0+?(?=0\.|[^0])/, ""));
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

    toRust(compiler: RustWriter): void {
        switch (this.type) {
            case "Int":
                // Remove leading zeros (Rust doesn't allow octal)
                compiler.write(this.value.replace(/^0+(?=.)/, ""));
                break;
            case "Float":
                // Remove leading zeros
                compiler.write(this.value.replace(/^0+?(?=0\.|[^0])/, ""));
                break;
            case "Str":
                // Emit as Rc::new("...".to_string())
                compiler.write(`Rc::new(${this.value}.to_string())`);
                break;
            case "Bool":
                compiler.write(this.value);
                break;
            default:
                throw this.error(`cannot use token ${this.value} as literal type`);
        }
    }
}
