import { paramTypesMatchArgTypes } from "./type-utils";
import { type EnumVariant, type FuncType, type TemplateTypes, type Type } from "./types";

type VarAttributes = {
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
};

type FuncAttributes = {
    class: "func";
    name: string;
    type: FuncType;
    isGeneric: boolean;
    fullName: string;
    /** Reference to the FunctionDef AST node, needed for generic monomorphization. */
    def?: unknown;
    /** Parameter names, used for keyword argument resolution in scope-based function lookup. */
    paramNames?: string[];
};

type StructAttributes = {
    class: "struct";
    name: string;
    fields: { name: string; type: Type; mutable: boolean }[];
    isGeneric?: true;
    typeParams?: string[];
    def?: unknown;
};

type EnumAttributes = {
    class: "enum";
    name: string;
    variants: EnumVariant[];
    isGeneric?: true;
    typeParams?: string[];
    def?: unknown;
};

type TraitAttributes = {
    class: "trait";
    name: string;
    requiredFunctions: { name: string; paramNames: string[]; types: TemplateTypes }[];
};

export type DefinitionAttributes =
    | VarAttributes
    | FuncAttributes
    | StructAttributes
    | EnumAttributes
    | TraitAttributes;

interface DefinitionLookupResult {
    /** Whether the variable belongs directly to this scope or to higher scope */
    inCurrentScope: boolean;
    attrs: DefinitionAttributes;
}

export class Scope {
    variables: DefinitionAttributes[];
    parent: Scope | null;

    constructor(variables: DefinitionAttributes[] = [], parent: Scope | null = null) {
        this.variables = variables;
        this.parent = parent;
    }

    private getKey(varAttrs: DefinitionAttributes): string {
        // Functions use fullName (includes param types) as dedup key so overloads coexist
        if (varAttrs.class === "func") return varAttrs.fullName;
        return varAttrs.name;
    }

    defineVariable(varAttrs: DefinitionAttributes, allowDuplicate: boolean = false) {
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
    defineVariableBefore(existingName: string, varAttrs: DefinitionAttributes) {
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

    lookup(name: string): DefinitionLookupResult | null {
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
     * Look for a variable definition with the given name.
     * if there are multiple matches with the same name,
     * this will give the first match.
     * If the first match is not a variable definition,
     * the result will be null.
     */
    lookupVariable(name: string): VarAttributes | null {
        const result = this.lookup(name);
        if (result === null) {
            return null;
        }
        if (result.attrs.class !== "var") {
            // This is something else (a function, struct, enum, or trait definition)
            return null;
        }
        return result.attrs;
    }

    /**
     * Look for a function definition with the given name
     * and a compatible type signature.
     * Matches will be ignored (and we'll keep looking for a match)
     * if the type signature we find is not compatible.
     */
    lookupFunction(
        name: string,
        argTypes: Type[],
        allowIterForArr: boolean = false
    ): FuncAttributes | null {
        for (const v of this.variables) {
            if (v.name !== name) {
                continue;
            }
            if (v.class !== "func") {
                continue;
            }
            if (paramTypesMatchArgTypes(v.type.paramTypes, argTypes, allowIterForArr)) {
                return v;
            }
        }
        if (this.parent === null) {
            return null;
        }
        return this.parent.lookupFunction(name, argTypes);
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
