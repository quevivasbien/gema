import type { Token } from "../tokens";
import { CustomType, type Type, type TemplateTypes } from "../types";
import { Expression } from "./expression";
import { registerTrait } from "./registries";
import { paramTypesMatchArgTypes } from "./type-utils";

export class Trait extends Expression {
    name: string;
    requiredFunctions: { name: string; paramNames: string[]; types: TemplateTypes }[];

    constructor(
        rootToken: Token,
        name: string,
        requiredFunctions: { name: string; paramNames: string[]; types: TemplateTypes }[]
    ) {
        super(rootToken.line, rootToken.col);
        this.name = name;
        this.requiredFunctions = requiredFunctions;

        for (const { name, types } of requiredFunctions) {
            if (types.returnType === null) {
                throw new Error(`function ${name} for trait ${this.name} must have a return type`);
            }
        }

        for (const { name, types } of requiredFunctions) {
            const hasSelf = types.types.some(
                (t) => t === "Self" || (t instanceof CustomType && t.name === "Self")
            );
            if (!hasSelf) {
                throw new Error(
                    `function ${name} for trait ${this.name} must include Self in at least one parameter type`
                );
            }
        }

        this.type = "Null";
        registerTrait(name, requiredFunctions);
    }

    getMatchingFunction(
        selfType: Type,
        argTypes: Type[]
    ): { name: string; paramNames: string[]; returnType: Type } | null {
        for (const { name, paramNames, types } of this.requiredFunctions) {
            if (types.returnType === null) {
                continue;
            }
            const paramTypesReplaced = types.types.map((t) => {
                if (t instanceof CustomType && t.name === "Self") {
                    return selfType;
                } else {
                    return t;
                }
            });
            if (paramTypesMatchArgTypes(paramTypesReplaced, argTypes)) {
                return { name, paramNames, returnType: types.returnType };
            }
        }
        return null;
    }

    cascadeTypes(_ancestors: Expression[]): void {
        // Nothing to do here
    }

    clone(_bindings?: Map<string, Type>): Expression {
        return this; // Traits are immutable, safe to share
    }

    toJS(_writer: never): void {
        // Traits are solely for type checking and aren't converted to JS.
    }
}
