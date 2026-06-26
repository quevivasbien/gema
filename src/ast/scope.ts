import { type FuncType, type Type } from "./types";

export type VariableAttributes =
    | {
          class: "var";
          name: string;
          type: Type;
          isMutable: boolean;
      }
    | {
          class: "func";
          name: string;
          type: FuncType;
          isGeneric: boolean;
      };

interface VariableLookupResult {
    inCurrentScope: boolean; // Whether the variable belongs directly to this scope or to higher scope
    attrs: VariableAttributes;
}

export class Scope {
    variables: VariableAttributes[];
    parent: Scope | null;

    constructor(variables: VariableAttributes[] = [], parent: Scope | null = null) {
        this.variables = variables;
        this.parent = parent;
    }

    defineVariable(varAttrs: VariableAttributes) {
        if (this.variables.some((v) => v.name === varAttrs.name)) {
            throw new Error(
                "Tried to define a variable that is already defined in the same scope."
            );
        }
        this.variables.push(varAttrs);
    }

    lookup(name: string): VariableLookupResult | null {
        for (const v of this.variables) {
            if (v["name"] === name) {
                return { inCurrentScope: true, attrs: v };
            }
        }
        if (this.parent === null) {
            return null;
        }
        const parentLookup = this.parent.lookup(name);
        return parentLookup === null ? null : { inCurrentScope: false, attrs: parentLookup.attrs };
    }
}
