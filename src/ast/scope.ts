import { type EnumVariant, type FuncType, type TemplateTypes, type Type } from "./types";

export type VariableAttributes =
    | {
          class: "var";
          name: string;
          type: Type;
          /** True if a variable is declared with the `mut` keyword */
          isMutable: boolean;
          /**
           * Whether it is still legal to access this variable
           * Always true when variables are first initialized, marked false after a consuming operation
           * (in an earlier version of the language, this happened when converting a mutable container to a non-mutable container, but it is now not functional anywhere and is just left here in case we want to re-implement some sort of system around this later)
           */
          isConsumed: boolean;
      }
    | {
          class: "func";
          name: string;
          type: FuncType;
          isGeneric: boolean;
          fullName: string;
          /** Reference to the FunctionDef AST node, needed for generic monomorphization. */
          def?: unknown;
          /** Parameter names, used for keyword argument resolution in scope-based function lookup. */
          paramNames?: string[];
      }
    | {
          class: "struct";
          name: string;
          fields: { name: string; type: Type; mutable: boolean }[];
          isGeneric?: true;
          typeParams?: string[];
          def?: unknown;
      }
    | {
          class: "enum";
          name: string;
          variants: EnumVariant[];
          isGeneric?: true;
          typeParams?: string[];
          def?: unknown;
      }
    | {
          class: "trait";
          name: string;
          requiredFunctions: { name: string; paramNames: string[]; types: TemplateTypes }[];
      };

interface VariableLookupResult {
    /** Whether the variable belongs directly to this scope or to higher scope */
    inCurrentScope: boolean;
    attrs: VariableAttributes;
}

export class Scope {
    variables: VariableAttributes[];
    parent: Scope | null;

    constructor(variables: VariableAttributes[] = [], parent: Scope | null = null) {
        this.variables = variables;
        this.parent = parent;
    }

    private getKey(varAttrs: VariableAttributes): string {
        // Functions use fullName (includes param types) as dedup key so overloads coexist
        if (varAttrs.class === "func") return varAttrs.fullName;
        return varAttrs.name;
    }

    defineVariable(varAttrs: VariableAttributes, allowDuplicate: boolean = false) {
        const key = this.getKey(varAttrs);
        if (this.variables.some((v) => this.getKey(v) === key)) {
            if (!allowDuplicate) {
                throw new Error(
                    `Tried to define a variable '${key}' that is already defined in the same scope.`
                );
            }
            return;
        }
        this.variables.push(varAttrs);
    }

    /** Insert a variable before an existing one in the same scope (for monomorphized functions). */
    defineVariableBefore(existingName: string, varAttrs: VariableAttributes) {
        const existingIndex = this.variables.findIndex(
            (v) => v.name === existingName || (v.class === "func" && v.fullName === existingName)
        );
        if (existingIndex === -1) {
            throw new Error(
                `Cannot insert before '${existingName}': it was not found in this scope.`
            );
        }
        this.variables.splice(existingIndex, 0, varAttrs);
    }

    lookup(name: string): VariableLookupResult | null {
        for (const v of this.variables) {
            if (v.name === name) {
                return { inCurrentScope: true, attrs: v };
            }
        }
        if (this.parent === null) {
            return null;
        }
        const parentLookup = this.parent.lookup(name);
        return parentLookup === null ? null : { inCurrentScope: false, attrs: parentLookup.attrs };
    }

    /**
     * Update the FuncType of an existing function entry identified by fullName.
     * Used after body cascade to store the inferred return type.
     */
    updateFuncType(fullName: string, newType: FuncType): void {
        for (const v of this.variables) {
            if (v.class === "func" && v.fullName === fullName) {
                (v as { type: FuncType }).type = newType;
                return;
            }
        }
        // Also check parent scopes
        if (this.parent) {
            this.parent.updateFuncType(fullName, newType);
        }
    }

    /**
     * Find a definition for a variable name and return whether or not the variable has been
     * consumed.
     * Throws an error if the variable is not defined or is not a consumable type.
     */
    isVarConsumed(name: string) {
        const lookupResult = this.lookup(name);
        if (lookupResult === null) {
            throw new Error(
                `Tried to resolve whether variable ${name} is consumed, but this variable is not even defined.`
            );
        }
        if (lookupResult.attrs.class !== "var") {
            throw new Error(
                `Tried to resolve whether variable ${name} is consumed, but this variable is not of a consumable class.`
            );
        }
        return lookupResult.attrs.isConsumed;
    }

    /**
     * Find a definition for a variable, and mark it as consumed.
     * Throws an error if the variable is not defined or is not a consumable type.
     */
    markVarConsumed(name: string) {
        const lookupResult = this.lookup(name);
        if (lookupResult === null) {
            throw new Error(
                `Tried to resolve whether variable ${name} is consumed, but this variable is not even defined.`
            );
        }
        if (lookupResult.attrs.class !== "var") {
            throw new Error(
                `Tried to resolve whether variable ${name} is consumed, but this variable is not of a consumable class.`
            );
        }
        lookupResult.attrs.isConsumed = true;
    }
}
