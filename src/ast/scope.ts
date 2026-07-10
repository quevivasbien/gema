import { extractGenericBindings } from "./caller-utils";
import { paramTypesMatchArgTypes, substituteTypeParams, typeEquals } from "./type-utils";
import { CustomType, FuncType, GenericType, type Type } from "./types";

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

export type GenericMappingInfo = {
    // Name of the generic type
    generic: string;
    // Type bound to generic type
    boundType: Type;
    // Required trait implementations for generic type
    // Trait impls is { traitName: { traitFnName: implementedFnName }}
    traitImpls: Record<string, Record<string, string>>;
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
    ) => GenericMappingInfo[] | null;
};

export type ResolvedGenericFunc = {
    class: "generic";
    name: string;
    type: FuncType;
    fullName: string;
    genericMapping: GenericMappingInfo[];
};

export type StructAttributes = {
    class: "struct";
    name: string;
    fields: { name: string; type: Type; mutable: boolean }[];
    templateTypes: Type[];
};

export type EnumAttributes = {
    class: "enum";
    name: string;
    variants: { name: string; type: Type | null }[];
    genericTypes: GenericType[] | null;
    isTaggedUnion: boolean;
};

export type ResolvedEnumInstantiation = {
    class: "enum";
    enumType: CustomType;
    variantIndex: number;
    isTaggedUnion: boolean;
};

export type TraitAttributes = {
    class: "trait";
    name: string;
    requiredFunctions: { name: string; signature: FuncType }[];
};

/** These are the types that can be stored within the Scope object */
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
        if (varAttrs.class === "func" || varAttrs.class === "generic") return varAttrs.fullName;
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
     * Look for a callable definition (including generic definitions) with the given name
     * and a compatible type signature.
     * Matches with incompatible param types ae skipped (we keep looking for a match).
     */
    lookupCaller(
        name: string,
        argTypes: Type[],
        associatedType: Type | null,
        rootScope: Scope | null = null
    ): FuncAttributes | ResolvedGenericFunc | StructAttributes | ResolvedEnumInstantiation | null {
        for (let i = this.variables.length - 1; i >= 0; i--) {
            const v = this.variables[i];
            if (v.name === name && v.class === "func") {
                // For concrete functions, check that param types match
                if (
                    typeEquals(v.type.associatedType, associatedType) &&
                    paramTypesMatchArgTypes(v.type.paramTypes, argTypes)
                ) {
                    return v;
                }
            } else if (v.name === name && v.class === "generic") {
                const genericMapping = v.traitImplGetter(
                    rootScope ?? this,
                    argTypes,
                    associatedType
                );
                if (genericMapping !== null) {
                    // Create bindings to remap generic types to bound types in function signature
                    const bindings = new Map<string, Type>();
                    for (const { generic, boundType } of genericMapping) {
                        bindings.set(generic, boundType);
                    }
                    return {
                        class: v.class,
                        name: v.name,
                        type: substituteTypeParams(v.type, bindings) as FuncType,
                        fullName: v.fullName,
                        genericMapping,
                    };
                }
            }
            // Handle case of struct constructor
            // TODO: This doesn't yet work with generic structs
            else if (v.name === name && v.class === "struct") {
                // TODO: For case of generic struct, need to use extractGenericBindings
                if (v.templateTypes === null || v.templateTypes.length === 0) {
                    // Not a generic struct, just need to check that types match
                    if (
                        paramTypesMatchArgTypes(
                            v.fields.map((f) => f.type),
                            argTypes
                        )
                    ) {
                        return v;
                    }
                }
                // Case of generic struct
                // Start by checking that everything except the generic types match
                else if (
                    paramTypesMatchArgTypes(
                        v.fields.map((f) => f.type),
                        argTypes,
                        true
                    )
                ) {
                    // Now check that we're setting compatible bindings
                    // (for now, this is just to make sure we don't try to bind the same generic type to multiple concrete types,
                    // but in the future we might also check traits here)
                    const bindings = new Map<string, Type>();
                    let compatible = true;
                    for (let i = 0; i < v.fields.length; i++) {
                        if (!extractGenericBindings(v.fields[i].type, argTypes[i], bindings)) {
                            // Not a match -- trying to substitute incompatible types
                            compatible = false;
                            break;
                        }
                    }
                    if (compatible) {
                        // Return the struct match with its generic types remapped to concrete types
                        return {
                            class: "struct",
                            fields: v.fields.map((f) => ({
                                name: f.name,
                                type: substituteTypeParams(f.type, bindings),
                                mutable: f.mutable,
                            })),
                            templateTypes: v.templateTypes.map((t) => {
                                if (!(t instanceof GenericType)) {
                                    throw new Error(
                                        `Unexpected non-generic template type ${t} in generic struct`
                                    );
                                }
                                const boundType = bindings.get(t.name);
                                if (boundType === undefined) {
                                    throw new Error(
                                        `Unbound generic type ${t.name} in concretized generic struct ${v.name}`
                                    );
                                }
                                return boundType;
                            }),
                            name: v.name,
                        };
                    }
                }
            }
            // Handle case of enum instantiation (like `EnumName::variantName(value)`)
            // The call must have an associated type the `EnumName` and must take exactly one value (maybe in the future we will permit multiple values)
            else if (
                v.class === "enum" &&
                associatedType !== null &&
                associatedType instanceof CustomType &&
                argTypes.length === 1
            ) {
                if (v.name === associatedType.name) {
                    // Validate type param count for generic enums
                    if (
                        v.genericTypes &&
                        v.genericTypes.length > 0 &&
                        (!associatedType.templateArgs ||
                            associatedType.templateArgs.length !== v.genericTypes.length)
                    ) {
                        continue;
                    }
                    // Check if one of the variants matches
                    for (let i = 0; i < v.variants.length; i++) {
                        const variant = v.variants[i];
                        if (variant.name !== name) continue;
                        if (variant.type === null && argTypes[0] === null) {
                            return {
                                class: v.class,
                                enumType: associatedType,
                                variantIndex: i,
                                isTaggedUnion: v.isTaggedUnion,
                            };
                        }
                        if (variant.type === null || argTypes[0] === null) continue;
                        // For generic enums, use extractGenericBindings
                        if (v.genericTypes && v.genericTypes.length > 0) {
                            const bindings = new Map<string, Type>();
                            if (extractGenericBindings(variant.type, argTypes[0], bindings)) {
                                return {
                                    class: v.class,
                                    enumType: associatedType,
                                    variantIndex: i,
                                    isTaggedUnion: v.isTaggedUnion,
                                };
                            }
                        } else if (typeEquals(variant.type, argTypes[0])) {
                            return {
                                class: v.class,
                                enumType: associatedType,
                                variantIndex: i,
                                isTaggedUnion: v.isTaggedUnion,
                            };
                        }
                    }
                }
            }
        }
        if (this.parent === null) {
            return null;
        }
        return this.parent.lookupCaller(name, argTypes, associatedType, this);
    }

    /**
     * Look for a struct definition with the given name
     */
    lookupStruct(name: string): StructAttributes | null {
        for (let i = this.variables.length - 1; i >= 0; i--) {
            const v = this.variables[i];
            if (v.name !== name) {
                continue;
            }
            if (v.class !== "struct") {
                continue;
            }
            return v;
        }
        if (this.parent === null) {
            return null;
        }
        return this.parent.lookupStruct(name);
    }

    lookupEnum(
        enumType: Type,
        argName: string,
        argType: Type | null = null
    ): ResolvedEnumInstantiation | null {
        if (!(enumType instanceof CustomType)) {
            return null;
        }
        for (let i = this.variables.length - 1; i >= 0; i--) {
            const v = this.variables[i];
            if (v.class !== "enum") {
                continue;
            }
            if (enumType.name !== v.name) {
                continue;
            }
            // Check if one of the variants matches
            for (let j = 0; j < v.variants.length; j++) {
                const variant = v.variants[j];
                if (variant.name !== argName) continue;
                // Both null: plain variant with no data
                if (variant.type === null && argType === null) {
                    return {
                        class: v.class,
                        enumType: enumType,
                        variantIndex: j,
                        isTaggedUnion: v.isTaggedUnion,
                    };
                }
                if (variant.type === null || argType === null) continue;
                // For generic enums, use extractGenericBindings
                if (v.genericTypes && v.genericTypes.length > 0) {
                    const bindings = new Map<string, Type>();
                    if (extractGenericBindings(variant.type, argType, bindings)) {
                        return {
                            class: v.class,
                            enumType: enumType,
                            variantIndex: j,
                            isTaggedUnion: v.isTaggedUnion,
                        };
                    }
                } else if (typeEquals(variant.type, argType)) {
                    return {
                        class: v.class,
                        enumType: enumType,
                        variantIndex: j,
                        isTaggedUnion: v.isTaggedUnion,
                    };
                }
            }
        }
        if (this.parent === null) {
            return null;
        }
        return this.parent.lookupEnum(enumType, argName, argType);
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
        // When candidateType is a GenericType that already declares the required trait,
        // the trait is satisfied by the generic type's own bounds. The concrete
        // implementations will be resolved when the outer generic function is
        // monomorphized. Reference the trait dictionary parameter directly.
        if (
            candidateType instanceof GenericType &&
            candidateType.traits.includes(traitAttrs.name)
        ) {
            const fnImpls: Record<string, string> = {};
            for (const reqFn of traitAttrs.requiredFunctions) {
                fnImpls[reqFn.name] = `$$impl${traitAttrs.name}_${candidateType.name}`;
            }
            return fnImpls;
        }

        const fnImpls: Record<string, string> = {};

        for (const reqFn of traitAttrs.requiredFunctions) {
            // Build the expected param types by substituting Self → candidateType
            const bindings = new Map<string, Type>();
            bindings.set("Self", candidateType);
            const expectedParamTypes = reqFn.signature.paramTypes.map((t) =>
                substituteTypeParams(t, bindings)
            );

            // Search the scope chain for a function definition with this name
            // whose param types match the expected ones
            let found: { fullName: string } | null = null;
            // eslint-disable-next-line @typescript-eslint/no-this-alias
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
