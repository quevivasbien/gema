import type { JSWriter } from "../write-js";
import type { Expression } from "./expression";
import { typeEquals, typesMatchWithConversion } from "./type-utils";
import {
    ArrayType,
    CustomType,
    DictType,
    EnumType,
    FuncType,
    IterType,
    MaybeType,
    MutArrType,
    MutDictType,
    MutSetType,
    SetType,
    TupleType,
    type Type,
} from "./types";

/** Produce a stable, readable name fragment for a type. */
export function typeToName(t: Type): string {
    if (typeof t === "string") return t;
    if (t instanceof CustomType) return t.name;
    if (t instanceof EnumType) return t.name;
    if (t instanceof ArrayType) return `Arr_${typeToName(t.innerType)}`;
    if (t instanceof IterType) return `Iter_${typeToName(t.innerType)}`;
    if (t instanceof MutArrType) return `MutArr_${typeToName(t.innerType)}`;
    if (t instanceof TupleType) return `Tup_${t.types.map(typeToName).join("_")}`;
    if (t instanceof DictType) return `Dict_${typeToName(t.keyType)}_${typeToName(t.valueType)}`;
    if (t instanceof MutDictType)
        return `MutDict_${typeToName(t.keyType)}_${typeToName(t.valueType)}`;
    if (t instanceof SetType) return `Set_${typeToName(t.innerType)}`;
    if (t instanceof MutSetType) return `MutSet_${typeToName(t.innerType)}`;
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
        if (existing && !typeEquals(existing, argType)) return false;
        bindings.set(paramType.name, argType);
        return true;
    }
    // CustomType with template args: Pair[T] ← Pair[Num] → extract T←Num
    if (
        paramType instanceof CustomType &&
        paramType.templateArgs &&
        argType instanceof CustomType &&
        argType.templateArgs &&
        paramType.name === argType.name &&
        paramType.templateArgs.length === argType.templateArgs.length
    ) {
        for (let i = 0; i < paramType.templateArgs.length; i++) {
            if (
                !extractBindings(
                    paramType.templateArgs[i],
                    argType.templateArgs[i],
                    typeParams,
                    bindings
                )
            )
                return false;
        }
        return true;
    }
    if (paramType instanceof ArrayType && argType instanceof ArrayType) {
        return extractBindings(paramType.innerType, argType.innerType, typeParams, bindings);
    }
    if (paramType instanceof MutArrType && argType instanceof MutArrType) {
        return extractBindings(paramType.innerType, argType.innerType, typeParams, bindings);
    }
    if (paramType instanceof IterType && argType instanceof IterType) {
        return extractBindings(paramType.innerType, argType.innerType, typeParams, bindings);
    }
    // Auto-convert: Arr[X] matches Iter[X]
    if (paramType instanceof IterType && argType instanceof ArrayType) {
        return extractBindings(paramType.innerType, argType.innerType, typeParams, bindings);
    }
    if (paramType instanceof SetType && argType instanceof SetType) {
        return extractBindings(paramType.innerType, argType.innerType, typeParams, bindings);
    }
    if (paramType instanceof MutSetType && argType instanceof MutSetType) {
        return extractBindings(paramType.innerType, argType.innerType, typeParams, bindings);
    }
    if (paramType instanceof DictType && argType instanceof DictType) {
        if (!extractBindings(paramType.keyType, argType.keyType, typeParams, bindings))
            return false;
        return extractBindings(paramType.valueType, argType.valueType, typeParams, bindings);
    }
    if (paramType instanceof MutDictType && argType instanceof MutDictType) {
        if (!extractBindings(paramType.keyType, argType.keyType, typeParams, bindings))
            return false;
        return extractBindings(paramType.valueType, argType.valueType, typeParams, bindings);
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
    if (!typesMatchWithConversion(paramType, argType, true)) return false;
    return true;
}

/**
 * Check if a concrete type satisfies a trait by looking for standalone function definitions.
 * Uses a scope for lookup if provided; falls back to optimistic assumption otherwise.
 */
export function checkTraitSatisfied(
    concreteType: Type,
    traitName: string,
    scope?: {
        lookup: (
            name: string
        ) => { attrs: { class: string; name: string; [key: string]: unknown } } | null;
        allVariables?: () => { class: string; name: string; fullName?: string }[];
    }
): boolean {
    if (scope) {
        const traitLookup = scope.lookup(traitName);
        if (!traitLookup || traitLookup.attrs.class !== "trait") return false;
        const attrs = traitLookup.attrs as unknown as {
            requiredFunctions: {
                name: string;
                paramNames: string[];
                types: { types: Type[]; returnType: Type | null };
            }[];
        };
        const traitFuncs = attrs.requiredFunctions;

        for (const { name, types } of traitFuncs) {
            if (name.startsWith("Self.")) {
                const funcName = name.slice(5);
                const concreteTypeName =
                    concreteType instanceof CustomType
                        ? concreteType.name
                        : typeof concreteType === "string"
                          ? concreteType
                          : "";
                const tafScopeName = `${concreteTypeName}.${funcName}`;
                if (!scope.lookup(tafScopeName)) return false;
            } else {
                const requiredParamTypes = types.types.map((t) => {
                    if (t === "Self" || (t instanceof CustomType && t.name === "Self"))
                        return concreteType;
                    return t;
                });
                const targetFullName = functionNameWithParamTypes(name, requiredParamTypes);
                // Search all scope variables for a func with matching fullName
                const allVars = scope.allVariables ? scope.allVariables() : [];
                let found = false;
                for (const v of allVars) {
                    if (v.class === "func" && v.fullName === targetFullName) {
                        found = true;
                        break;
                    }
                }
                if (!found) return false;
            }
        }
        return true;
    }
    return true;
}

export function wrapArrayToIter(writer: JSWriter, arg: Expression) {
    if (arg.type instanceof ArrayType || arg.type instanceof MutArrType) {
        writer.useBuiltin("$ArrayIterator$");
        writer.write("new $ArrayIterator$(");
        arg.toJS(writer);
        writer.write(")");
    } else if (arg && arg.type === "Str") {
        // Convert string to array iterator by splitting into characters
        writer.useBuiltin("$ArrayIterator$");
        writer.write("new $ArrayIterator$(");
        arg.toJS(writer);
        writer.write('.split(""))');
    } else {
        arg.toJS(writer);
    }
};
