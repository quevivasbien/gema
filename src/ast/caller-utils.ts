import type { JSWriter } from "../write-js";
import type { Expression } from "./expression";
import { typeEquals } from "./type-utils";
import {
    ArrayType,
    CustomType,
    DictType,
    FuncType,
    GenericType,
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
    if (t instanceof GenericType) return `$Generic_${t.name}`;
    if (t instanceof ArrayType) return `$Arr_${typeToName(t.innerType)}`;
    if (t instanceof IterType) return `$Iter_${typeToName(t.innerType)}`;
    if (t instanceof MutArrType) return `$MutArr_${typeToName(t.innerType)}`;
    if (t instanceof TupleType) return `$Tup_${t.types.map(typeToName).join("_")}`;
    if (t instanceof DictType) return `$Dict_${typeToName(t.keyType)}_${typeToName(t.valueType)}`;
    if (t instanceof MutDictType)
        return `$MutDict_${typeToName(t.keyType)}_${typeToName(t.valueType)}`;
    if (t instanceof SetType) return `$Set_${typeToName(t.innerType)}`;
    if (t instanceof MutSetType) return `$MutSet_${typeToName(t.innerType)}`;
    if (t instanceof FuncType)
        return `$Func_${t.paramTypes.map(typeToName).join("_")}_${typeToName(t.returnType)}`;
    if (t instanceof MaybeType) return `$Maybe_${typeToName(t.innerType)}`;
    return "Null";
}

export function functionNameWithParamTypes(name: string | null, paramTypes: Type[]): string {
    return `${name}$${paramTypes.map(typeToName).join("$")}`;
}

/**
 * Recursively extract generic type bindings from function parameters
 * Mutates `bindings` in place
 */
export function extractGenericBindings(
    paramType: Type,
    argType: Type,
    bindings: Map<string, Type>
): boolean {
    // "Infer" is a wildcard sentinel for unresolved lambda params — skip binding.
    if (argType === "Infer") return true;

    if (paramType instanceof GenericType) {
        const existing = bindings.get(paramType.name);
        if (existing && !typeEquals(existing, argType)) {
            // This generic type has a different type already bound to it!
            return false;
        }
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
                !extractGenericBindings(
                    paramType.templateArgs[i],
                    argType.templateArgs[i],
                    bindings
                )
            )
                return false;
        }
        return true;
    }
    if (paramType instanceof ArrayType && argType instanceof ArrayType) {
        return extractGenericBindings(paramType.innerType, argType.innerType, bindings);
    }
    if (paramType instanceof MutArrType && argType instanceof MutArrType) {
        return extractGenericBindings(paramType.innerType, argType.innerType, bindings);
    }
    if (paramType instanceof IterType && argType instanceof IterType) {
        return extractGenericBindings(paramType.innerType, argType.innerType, bindings);
    }
    if (paramType instanceof SetType && argType instanceof SetType) {
        return extractGenericBindings(paramType.innerType, argType.innerType, bindings);
    }
    if (paramType instanceof MutSetType && argType instanceof MutSetType) {
        return extractGenericBindings(paramType.innerType, argType.innerType, bindings);
    }
    if (paramType instanceof DictType && argType instanceof DictType) {
        if (!extractGenericBindings(paramType.keyType, argType.keyType, bindings)) return false;
        return extractGenericBindings(paramType.valueType, argType.valueType, bindings);
    }
    if (paramType instanceof MutDictType && argType instanceof MutDictType) {
        if (!extractGenericBindings(paramType.keyType, argType.keyType, bindings)) return false;
        return extractGenericBindings(paramType.valueType, argType.valueType, bindings);
    }
    if (paramType instanceof FuncType && argType instanceof FuncType) {
        if (paramType.paramTypes.length !== argType.paramTypes.length) return false;
        for (let i = 0; i < paramType.paramTypes.length; i++) {
            if (!extractGenericBindings(paramType.paramTypes[i], argType.paramTypes[i], bindings))
                return false;
        }
        return extractGenericBindings(paramType.returnType, argType.returnType, bindings);
    }
    if (paramType instanceof MaybeType && argType instanceof MaybeType) {
        return extractGenericBindings(paramType.innerType, argType.innerType, bindings);
    }
    if (!typeEquals(paramType, argType)) return false;
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
}
