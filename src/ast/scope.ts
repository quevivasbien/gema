import { paramTypesMatchArgTypes } from "./type-utils";
import { type EnumVariant, type FuncType, type TemplateTypes, type Type } from "./types";

export type VarAttributes = {
    class: "var";
    name: string;
    type: Type;
    /** True if a variable is declared with the `mut` keyword */
    isMutable: boolean;
    /**
     * Whether it is still legal to access this variable
     * Always true when variables are first initialized, marked false after a consuming operation
     * (in an earlier version of the language, this happened when converting a mutable container to a non-mutable container, but it is now not functional anywhere and is just left here in case we want to re-implement some sort of system around this later)
     * TODO: This field is deprecated and should be removed
     */
    isConsumed: boolean;
};

export type FuncAttributes = {
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

export type StructAttributes = {
    class: "struct";
    name: string;
    fields: { name: string; type: Type; mutable: boolean }[];
    isGeneric?: true;
    typeParams?: string[];
    def?: unknown;
};

export type EnumAttributes = {
    class: "enum";
    name: string;
    variants: EnumVariant[];
    isGeneric?: true;
    typeParams?: string[];
    def?: unknown;
};

export type TraitAttributes = {
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

    /** Insert a variable before an existing one in the same scope (for monomorphized functions). */
    defineVariableAfter(existingName: string, varAttrs: DefinitionAttributes) {
        const existingIndex = this.variables.findIndex(
            (v) => v.name === existingName || (v.class === "func" && v.fullName === existingName)
        );
        if (existingIndex === -1) {
            throw new Error(
                `Cannot insert after '${existingName}': it was not found in this scope.`
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

    genericParamTypesMatchArgTypes(paramTypes: Type[], argTypes: Type[], allowIterForArr: boolean = false) {
        // How this needs to work:
        // 1. Look up all trait definitions for generic params (maybe these should be stored as part of the source FuncAttributes so we don't need to search again every time the generic is referenced? Maybe we should have a separate GenericFuncAttributes?) This search starts from the scope where the generic function is defined. If a trait definition is not found, this is an ERROR (should have been caught when generic was defined)
        // 2. For each trait + associated argType, search for the functions needed to satisfy the trait. This search starts from the scope where the function is _called_ (this means we need to know both the original call scope AND the scope that the generic function definition lives in). If not satisfied, return no match.
        // 3. If a match, monomorphize the generic function using the argtypes and matched trait functions -- alternative is we can just return saying "this is a match -- here is the generic definition and the needed trait functions" and let the monomorphization happen downstream
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
            if (v.isGeneric && this.genericParamTypesMatchArgTypes(v.type.paramTypes, argTypes, allowIterForArr)) {
                // TODO: Monomorphize the matched generic function, and return the match
            }
            if (!v.isGeneric && paramTypesMatchArgTypes(v.type.paramTypes, argTypes, allowIterForArr)) {
                return v;
            }
        }
        if (this.parent === null) {
            return null;
        }
        return this.parent.lookupFunction(name, argTypes, allowIterForArr);
    }

    /**
     * Look for a struct definition with the given name and compatible types
     * Matches will be ignored (and we'll keep looking for a match)
     * if the type signature we find is not compatible.
     */
    lookupStruct(name: string, argTypes: Type[]): StructAttributes | null {
        for (const v of this.variables) {
            if (v.name !== name) {
                continue;
            }
            if (v.class !== "struct") {
                continue;
            }
            // TODO: Should we allow implicit Arr -> Iter conversion when constructing structs?
            if (
                paramTypesMatchArgTypes(
                    v.fields.map((f) => f.type),
                    argTypes,
                    false
                )
            ) {
                return v;
            }
        }
        if (this.parent === null) {
            return null;
        }
        return this.parent.lookupStruct(name, argTypes);
    }

    /**
     * Look for a trait definition with the given name and compatible types.
     * Ignores anything that is not a trait definition.
     */
    lookupTrait(name: string): TraitAttributes | null {
        for (const v of this.variables) {
            if (v.name !== name) {
                continue;
            }
            if (v.class !== "trait") {
                continue;
            }
            return v;
        }
        if (this.parent === null) {
            return null;
        }
        return this.parent.lookupTrait(name);
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
     * Check that the required functions to satisfy a trait exist for the given candidate type
     */
    checkCandidateTypeSatisfiesTrait(candidateType: Type, traitAttrs: TraitAttributes): boolean {
        // TODO!
        return false;
    }

    // TODO: This and markVarConsumed are deprecated -- we are no longer using this in the language
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
