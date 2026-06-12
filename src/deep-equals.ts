import {
    CustomType,
    ArrayType,
    IterType,
    MutArrType,
    FuncType,
    TupleType,
    HashMapType,
    HashSetType,
} from "./types";

/**
 * Structural deep equality for Gema's type system.
 *
 * Handles:
 * - String primitives ("Int", "Float", "Str", "Bool", "Null", "Self")
 * - CustomType (name + traits)
 * - ArrayType, IterType, MutArrType (innerType recursion)
 * - FuncType (paramTypes array + returnType recursion)
 * - null values
 */
export function deepEquals(a: unknown, b: unknown): boolean {
    if (a === b) return true;

    if (a == null || b == null) return false;

    // String primitives
    if (typeof a === "string" && typeof b === "string") {
        return a === b;
    }

    // If one is a string and the other isn't, they can't be equal
    if (typeof a !== typeof b) return false;

    // If they're not objects at this point, use strict equality
    if (typeof a !== "object" || typeof b !== "object") return a === b;

    // CustomType
    if (a instanceof CustomType && b instanceof CustomType) {
        if (a.name !== b.name) return false;
        if (a.traits.length !== b.traits.length) return false;
        for (let i = 0; i < a.traits.length; i++) {
            if (a.traits[i] !== b.traits[i]) return false;
        }
        return true;
    }

    // ArrayType
    if (a instanceof ArrayType && b instanceof ArrayType) {
        return deepEquals(a.innerType, b.innerType);
    }

    // IterType
    if (a instanceof IterType && b instanceof IterType) {
        return deepEquals(a.innerType, b.innerType);
    }

    // MutArrType
    if (a instanceof MutArrType && b instanceof MutArrType) {
        return deepEquals(a.innerType, b.innerType);
    }

    // TupleType
    if (a instanceof TupleType && b instanceof TupleType) {
        if (a.types.length !== b.types.length) return false;
        for (let i = 0; i < a.types.length; i++) {
            if (!deepEquals(a.types[i], b.types[i])) return false;
        }
        return true;
    }

    // HashMapType
    if (a instanceof HashMapType && b instanceof HashMapType) {
        if (!deepEquals(a.keyType, b.keyType)) return false;
        if (!deepEquals(a.valueType, b.valueType)) return false;
        return true;
    }

    // HashSetType
    if (a instanceof HashSetType && b instanceof HashSetType) {
        return deepEquals(a.innerType, b.innerType);
    }

    // FuncType
    if (a instanceof FuncType && b instanceof FuncType) {
        if (!deepEquals(a.returnType, b.returnType)) return false;
        if (a.paramTypes.length !== b.paramTypes.length) return false;
        for (let i = 0; i < a.paramTypes.length; i++) {
            if (!deepEquals(a.paramTypes[i], b.paramTypes[i])) return false;
        }
        return true;
    }

    // Mismatched types
    return false;
}
