import type { Token } from "../tokens";
import { Expression } from "./expression";

import { paramTypesMatchArgTypes } from "./type-utils";
import { CustomType, FuncType, type Type } from "./types";

export class Trait extends Expression {
    name: string;
    requiredFunctions: { name: string; signature: FuncType }[];

    constructor(
        rootToken: Token,
        name: string,
        requiredFunctions: { name: string; signature: FuncType }[]
    ) {
        super(rootToken.line, rootToken.col);
        this.name = name;
        this.requiredFunctions = requiredFunctions;

        for (const { name, signature } of requiredFunctions) {
            if (signature.returnType === null) {
                throw new Error(`function ${name} for trait ${this.name} must have a return type`);
            }
        }

        for (const { name, signature } of requiredFunctions) {
            // Self can appear as a parameter type OR as the associated type (type-associated function)
            const hasSelf =
                signature.paramTypes.some((t) => t === "Self") ||
                signature.associatedType === "Self";
            if (!hasSelf) {
                throw new Error(
                    `function ${name} for trait ${this.name} must include Self in at least one parameter type or as an associated type`
                );
            }
        }

        // Trait definitions always have Null type
        this.type = "Null";
    }

    getMatchingFunction(
        selfType: Type,
        argTypes: Type[]
    ): { name: string; returnType: Type } | null {
        for (const { name, signature: types } of this.requiredFunctions) {
            if (types.returnType === null) {
                continue;
            }
            const paramTypesReplaced = types.paramTypes.map((t) => {
                if (t instanceof CustomType && t.name === "Self") {
                    return selfType;
                } else {
                    return t;
                }
            });
            if (paramTypesMatchArgTypes(paramTypesReplaced, argTypes)) {
                return { name, returnType: types.returnType };
            }
        }
        return null;
    }

    cascadeTypes(parent: Expression | null, valueUsed: boolean): void {
        super.cascadeTypes(parent, valueUsed);
        // Register in enclosing scope so trait dispatch can find this definition
        const blockScope = this.getScope();
        if (blockScope) {
            blockScope.defineVariable({
                class: "trait",
                name: this.name,
                requiredFunctions: this.requiredFunctions,
            });
        }
    }

    toJS(_writer: never): void {
        // Traits are solely for type checking and aren't converted to JS.
    }
}
