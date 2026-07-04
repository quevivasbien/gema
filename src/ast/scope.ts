import { paramTypesMatchArgTypes, substituteTypeParams } from "./type-utils";
import { FuncType, GenericType, type TemplateTypes, type Type } from "./types";

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
    fullName: string;
};

export type TraitImplInfo = {
    generic: string;
    trait: string;
    boundType: Type;
    fnImpls: Record<string, string>;
};

export type GenericFuncAttributes = {
    class: "generic";
    name: string;
    type: FuncType;
    fullName: string;
    traitImplGetter: (
        callerScope: Scope,
        argTypes: Type[],
        associatedType: Type | null
    ) => TraitImplInfo[] | null;
};

export type ResolvedGenericFuncAttributes = {
    class: "generic";
    name: string;
    type: FuncType;
    fullName: string;
    traitImpls: TraitImplInfo[];
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
    variants: { name: string; type: Type | null }[];
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
    | GenericFuncAttributes
    | StructAttributes
    | EnumAttributes
    | TraitAttributes;

interface DefinitionLookupResult {
    /** Whether the variable belongs directly to this scope or to higher scope */
    inCurrentScope: boolean;
    attrs: DefinitionAttributes;
}

export class Scope {
    /** The variables that are defined in this scope */
    variables: DefinitionAttributes[];
    /** The encapsulating scope for this scope (if this is a nested scope) */
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

    lookup(name: string): DefinitionLookupResult | null {
        for (let i = this.variables.length - 1; i >= 0; i--) {
            const v = this.variables[i];
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
     * Look for a function definition (including generic definitions) with the given name
     * and a compatible type signature.
     * Matches with incompatible param types are skipped (we keep looking for a match).
     */
    lookupFunction(
        name: string,
        argTypes: Type[],
        associatedType: Type | null,
        allowIterForArr: boolean = false,
        rootScope: Scope | null = null
    ): FuncAttributes | ResolvedGenericFuncAttributes | null {
        for (let i = this.variables.length - 1; i >= 0; i--) {
            const v = this.variables[i];
            if (v.name !== name) {
                continue;
            }
            if (v.class === "func") {
                // For concrete functions, check that param types match
                if (paramTypesMatchArgTypes(v.type.paramTypes, argTypes, allowIterForArr)) {
                    return v;
                }
            } else if (v.class === "generic") {
                // For generic functions, call the traitImplGetter to verify that argTypes are compatible
                const traitImpls = v.traitImplGetter(rootScope ?? this, argTypes, associatedType);
                if (traitImpls !== null) {
                    // Create bindings to remap generic types to bound types in function signature
                    const bindings = new Map<string, Type>();
                    for (const { generic, boundType } of traitImpls) {
                        bindings.set(generic, boundType);
                    }
                    console.log("Using bindings:", bindings);
                    console.log(
                        "Mapped from",
                        v.type,
                        " to ",
                        substituteTypeParams(v.type, bindings)
                    );
                    return {
                        class: v.class,
                        name: v.name,
                        type: substituteTypeParams(v.type, bindings) as FuncType,
                        fullName: v.fullName,
                        traitImpls,
                    };
                }
            }
        }
        if (this.parent === null) {
            return null;
        }
        return this.parent.lookupFunction(name, argTypes, associatedType, allowIterForArr, this);
    }

    /**
     * Look for a struct definition with the given name and compatible types
     * Matches will be ignored (and we'll keep looking for a match)
     * if the type signature we find is not compatible.
     * TODO: This should probably be combined with lookupFunction -- we shouldn't be searching for them separately
     */
    lookupStruct(name: string, argTypes: Type[]): StructAttributes | null {
        for (let i = this.variables.length - 1; i >= 0; i--) {
            const v = this.variables[i];
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
        for (let i = this.variables.length - 1; i >= 0; i--) {
            const v = this.variables[i];
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
        for (let i = this.variables.length - 1; i >= 0; i--) {
            const v = this.variables[i];
            if ((v.class === "func" || v.class === "generic") && v.fullName === fullName) {
                v.type = newType;
                return;
            }
        }
        // Also check parent scopes
        if (this.parent) {
            this.parent.updateFuncType(fullName, newType);
        }
    }

    /**
     * Check that the required functions to satisfy a trait exist for the given candidate type.
     * Searches the entire scope chain for matching function definitions.
     * Returns a mapping from each required trait function name to the matching function fullName,
     * or null if the candidate type is missing one or more required function definitions.
     */
    checkCandidateTypeSatisfiesTrait(
        candidateType: Type,
        traitAttrs: TraitAttributes
    ): Record<string, string> | null {
        const fnImpls: Record<string, string> = {};

        for (const reqFn of traitAttrs.requiredFunctions) {
            // Build the expected param types by substituting Self → candidateType
            const bindings = new Map<string, Type>();
            bindings.set("Self", candidateType);
            const expectedParamTypes = reqFn.types.types.map((t) =>
                substituteTypeParams(t, bindings)
            );

            // Search the scope chain for a function definition with this name
            // whose param types match the expected ones
            let found: { fullName: string } | null = null;
            let searchScope: Scope | null = this;
            while (searchScope !== null) {
                for (const v of searchScope.variables) {
                    if (v.class !== "func" && v.class !== "generic") continue;
                    if (v.name !== reqFn.name) continue;
                    if (
                        v.type instanceof FuncType &&
                        paramTypesMatchArgTypes(v.type.paramTypes, expectedParamTypes, false)
                    ) {
                        found = { fullName: v.fullName };
                        break;
                    }
                }
                if (found) break;
                searchScope = searchScope.parent;
            }

            if (found === null) {
                return null;
            }
            fnImpls[reqFn.name] = found.fullName;
        }

        return fnImpls;
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
