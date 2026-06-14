import { deepEquals } from "../deep-equals";
import {
    FuncType,
    ArrayType,
    IterType,
    MutArrType,
    MaybeType,
    CustomType,
    type Type,
} from "../types";
import { getTrait, findFunction } from "./registries";
import { typesMatchWithConversion } from "./type-utils";

/** Produce a stable, readable name fragment for a type. */
export function typeToName(t: Type): string {
    if (typeof t === "string") return t;
    if (t instanceof CustomType) return t.name;
    if (t instanceof ArrayType) return `Arr_${typeToName(t.innerType)}`;
    if (t instanceof IterType) return `Iter_${typeToName(t.innerType)}`;
    if (t instanceof MutArrType) return `MutArr_${typeToName(t.innerType)}`;
    if (t instanceof FuncType)
        return `Func_${t.paramTypes.map(typeToName).join("_")}_${typeToName(t.returnType)}`;
    if (t instanceof MaybeType) return `Maybe_${typeToName(t.innerType)}`;
    return "Null";
}

export function functionNameWithParamTypes(name: string | null, paramTypes: Type[]): string {
    return `${name}$${paramTypes.map(typeToName).join("$")}`;
}

/**
 * Recursively extract type param bindings from param types against arg types.
 */
export function extractBindingsFromParams(
    params: { name: string; type: Type }[],
    argTypes: Type[],
    typeParams: string[],
    bindings: Map<string, Type>
): boolean {
    if (params.length !== argTypes.length) return false;
    for (let i = 0; i < params.length; i++) {
        if (!extractBindings(params[i].type, argTypes[i], typeParams, bindings)) {
            return false;
        }
    }
    return true;
}

function extractBindings(
    paramType: Type,
    argType: Type,
    typeParams: string[],
    bindings: Map<string, Type>
): boolean {
    if (paramType instanceof CustomType && typeParams.includes(paramType.name)) {
        const existing = bindings.get(paramType.name);
        if (existing && !deepEquals(existing, argType)) return false;
        bindings.set(paramType.name, argType);
        return true;
    }
    if (paramType instanceof ArrayType && argType instanceof ArrayType) {
        return extractBindings(paramType.innerType, argType.innerType, typeParams, bindings);
    }
    if (paramType instanceof IterType && argType instanceof IterType) {
        return extractBindings(paramType.innerType, argType.innerType, typeParams, bindings);
    }
    // Auto-convert: Arr[X] matches Iter[X]
    if (paramType instanceof IterType && argType instanceof ArrayType) {
        return extractBindings(paramType.innerType, argType.innerType, typeParams, bindings);
    }
    if (paramType instanceof FuncType && argType instanceof FuncType) {
        if (paramType.paramTypes.length !== argType.paramTypes.length) return false;
        for (let i = 0; i < paramType.paramTypes.length; i++) {
            if (
                !extractBindings(
                    paramType.paramTypes[i],
                    argType.paramTypes[i],
                    typeParams,
                    bindings
                )
            )
                return false;
        }
        return extractBindings(paramType.returnType, argType.returnType, typeParams, bindings);
    }
    if (paramType instanceof MaybeType && argType instanceof MaybeType) {
        return extractBindings(paramType.innerType, argType.innerType, typeParams, bindings);
    }
    if (!typesMatchWithConversion(paramType, argType)) return false;
    return true;
}

/**
 * Check if a concrete type satisfies a trait by looking for standalone function definitions.
 */
export function checkTraitSatisfied(
    concreteType: Type,
    traitName: string,
    _contextFnName: string
): boolean {
    const traitFuncs = getTrait(traitName);
    if (!traitFuncs) return false;

    for (const { name, types } of traitFuncs) {
        const requiredParamTypes = types.types.map((t) => {
            if (t === "Self" || (t instanceof CustomType && t.name === "Self")) return concreteType;
            return t;
        });
        const targetFullName = functionNameWithParamTypes(name, requiredParamTypes);
        const fn = findFunction(targetFullName);
        if (!fn) return false;
    }
    return true;
}
