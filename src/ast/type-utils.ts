import { getStruct } from "./registries";
import {
    ArrayType,
    CustomType,
    DictType,
    FuncType,
    isBuiltinTypeName,
    IterType,
    MaybeType,
    MutArrType,
    MutDictType,
    MutSetType,
    SetType,
    TupleType,
    type Type,
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

    // DictType
    if (a instanceof DictType && b instanceof DictType) {
        if (!deepEquals(a.keyType, b.keyType)) return false;
        if (!deepEquals(a.valueType, b.valueType)) return false;
        return true;
    }

    // MutDictType
    if (a instanceof MutDictType && b instanceof MutDictType) {
        if (!deepEquals(a.keyType, b.keyType)) return false;
        if (!deepEquals(a.valueType, b.valueType)) return false;
        return true;
    }

    // SetType
    if (a instanceof SetType && b instanceof SetType) {
        return deepEquals(a.innerType, b.innerType);
    }

    // MutSetType
    if (a instanceof MutSetType && b instanceof MutSetType) {
        return deepEquals(a.innerType, b.innerType);
    }

    // MaybeType
    if (a instanceof MaybeType && b instanceof MaybeType) {
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

/** Return a copy of a type with all trait information removed. */
export function stripTraits(t: Type): Type {
    if (t instanceof CustomType) {
        return new CustomType(t.name);
    }
    if (t instanceof ArrayType) {
        return new ArrayType(stripTraits(t.innerType));
    }
    if (t instanceof IterType) {
        return new IterType(stripTraits(t.innerType));
    }
    if (t instanceof MutArrType) {
        return new MutArrType(stripTraits(t.innerType));
    }
    if (t instanceof TupleType) {
        return new TupleType(t.types.map((tt) => stripTraits(tt)));
    }
    if (t instanceof DictType) {
        return new DictType(stripTraits(t.keyType), stripTraits(t.valueType));
    }
    if (t instanceof MutDictType) {
        return new MutDictType(stripTraits(t.keyType), stripTraits(t.valueType));
    }
    if (t instanceof SetType) {
        return new SetType(stripTraits(t.innerType));
    }
    if (t instanceof MutSetType) {
        return new MutSetType(stripTraits(t.innerType));
    }
    if (t instanceof MaybeType) {
        return new MaybeType(stripTraits(t.innerType));
    }
    if (t instanceof FuncType) {
        return new FuncType(
            t.paramTypes.map((pt) => stripTraits(pt)),
            stripTraits(t.returnType)
        );
    }
    return t;
}

/** Compare two types for equality, ignoring trait differences on CustomTypes. */
export function typeEquals(a: Type, b: Type): boolean {
    return deepEquals(stripTraits(a), stripTraits(b));
}

/** Check if a type is fully concrete (not a type variable from an enclosing generic). */
export function isConcreteType(t: Type): boolean {
    if (typeof t === "string") return true;
    if (t instanceof CustomType) {
        return isBuiltinTypeName(t.name) || getStruct(t.name) !== undefined;
    }
    if (t instanceof ArrayType) return isConcreteType(t.innerType);
    if (t instanceof IterType) return isConcreteType(t.innerType);
    if (t instanceof MutArrType) return isConcreteType(t.innerType);
    if (t instanceof TupleType) return t.types.every((tt) => isConcreteType(tt));
    if (t instanceof DictType) return isConcreteType(t.keyType) && isConcreteType(t.valueType);
    if (t instanceof MutDictType) return isConcreteType(t.keyType) && isConcreteType(t.valueType);
    if (t instanceof SetType) return isConcreteType(t.innerType);
    if (t instanceof MutSetType) return isConcreteType(t.innerType);
    if (t instanceof MaybeType) return isConcreteType(t.innerType);
    if (t instanceof FuncType)
        return t.paramTypes.every(isConcreteType) && isConcreteType(t.returnType);
    return true;
}

/** Check if two types match, allowing Arr[X] ↔ Iter[X] auto-conversion
 *  and ignoring trait differences on CustomTypes. */
export function typesMatchWithConversion(a: Type, b: Type): boolean {
    if (deepEquals(a, b)) return true;
    // Try comparison with traits stripped (traits are metadata, not semantic type identity)
    if (deepEquals(stripTraits(a), stripTraits(b))) return true;
    // Arr[X] can be treated as Iter[X]
    if (a instanceof IterType && b instanceof ArrayType) {
        return typesMatchWithConversion(a.innerType, b.innerType);
    }
    if (a instanceof ArrayType && b instanceof IterType) {
        return typesMatchWithConversion(a.innerType, b.innerType);
    }
    return false;
}

export function paramTypesMatchArgTypes(funcParamTypes: Type[], argTypes: Type[]): boolean {
    if (funcParamTypes.length !== argTypes.length) return false;
    return funcParamTypes.every((t, i) => typesMatchWithConversion(t, argTypes[i]));
}

/** Loose type comparison that allows type variables (non-concrete types) to match anything */
export function looseMatch(a: Type, b: Type): boolean {
    if (a === b) return true;
    // If either type is not concrete, allow the match (for generic function bodies)
    if (!isConcreteType(a) || !isConcreteType(b)) return true;
    return deepEquals(a, b);
}

/** Collect trait names associated with a type param name inside a type tree. */
export function collectTraitsForTypeParam(t: Type, typeParamName: string): string[] {
    if (t instanceof CustomType && t.name === typeParamName) {
        return [...t.traits];
    }
    if (t instanceof ArrayType) {
        return collectTraitsForTypeParam(t.innerType, typeParamName);
    }
    if (t instanceof IterType) {
        return collectTraitsForTypeParam(t.innerType, typeParamName);
    }
    if (t instanceof FuncType) {
        const result: string[] = [];
        t.paramTypes.forEach((pt) => result.push(...collectTraitsForTypeParam(pt, typeParamName)));
        result.push(...collectTraitsForTypeParam(t.returnType, typeParamName));
        return result;
    }
    if (t instanceof DictType) {
        return [
            ...collectTraitsForTypeParam(t.keyType, typeParamName),
            ...collectTraitsForTypeParam(t.valueType, typeParamName),
        ];
    }
    if (t instanceof MutDictType) {
        return [
            ...collectTraitsForTypeParam(t.keyType, typeParamName),
            ...collectTraitsForTypeParam(t.valueType, typeParamName),
        ];
    }
    if (t instanceof SetType) {
        return collectTraitsForTypeParam(t.innerType, typeParamName);
    }
    if (t instanceof MutSetType) {
        return collectTraitsForTypeParam(t.innerType, typeParamName);
    }
    if (t instanceof MaybeType) {
        return collectTraitsForTypeParam(t.innerType, typeParamName);
    }
    return [];
}
