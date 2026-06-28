import {
    ArrayType,
    CustomType,
    DictType,
    EnumType,
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
 * - String primitives ("Num", "Int", "Str", "Bool", "Null", "Self")
 * - CustomType (name + traits)
 * - ArrayType, IterType, MutArrType (innerType recursion)
 * - FuncType (paramTypes array + returnType recursion)
 * - null values
 */
export function typeEquals(a: unknown, b: unknown): boolean {
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
        return typeEquals(a.innerType, b.innerType);
    }

    // IterType
    if (a instanceof IterType && b instanceof IterType) {
        return typeEquals(a.innerType, b.innerType);
    }

    // MutArrType
    if (a instanceof MutArrType && b instanceof MutArrType) {
        return typeEquals(a.innerType, b.innerType);
    }

    // TupleType
    if (a instanceof TupleType && b instanceof TupleType) {
        if (a.types.length !== b.types.length) return false;
        for (let i = 0; i < a.types.length; i++) {
            if (!typeEquals(a.types[i], b.types[i])) return false;
        }
        return true;
    }

    // DictType
    if (a instanceof DictType && b instanceof DictType) {
        if (!typeEquals(a.keyType, b.keyType)) return false;
        if (!typeEquals(a.valueType, b.valueType)) return false;
        return true;
    }

    // MutDictType
    if (a instanceof MutDictType && b instanceof MutDictType) {
        if (!typeEquals(a.keyType, b.keyType)) return false;
        if (!typeEquals(a.valueType, b.valueType)) return false;
        return true;
    }

    // SetType
    if (a instanceof SetType && b instanceof SetType) {
        return typeEquals(a.innerType, b.innerType);
    }

    // MutSetType
    if (a instanceof MutSetType && b instanceof MutSetType) {
        return typeEquals(a.innerType, b.innerType);
    }

    // MaybeType
    if (a instanceof MaybeType && b instanceof MaybeType) {
        return typeEquals(a.innerType, b.innerType);
    }

    // EnumType
    if (a instanceof EnumType && b instanceof EnumType) {
        if (a.name !== b.name) return false;
        if (a.variants.length !== b.variants.length) return false;
        for (let i = 0; i < a.variants.length; i++) {
            if (a.variants[i].name !== b.variants[i].name) return false;
            if (!typeEquals(a.variants[i].type, b.variants[i].type)) return false;
        }
        return true;
    }

    // FuncType
    if (a instanceof FuncType && b instanceof FuncType) {
        if (!typeEquals(a.returnType, b.returnType)) return false;
        if (a.paramTypes.length !== b.paramTypes.length) return false;
        for (let i = 0; i < a.paramTypes.length; i++) {
            if (!typeEquals(a.paramTypes[i], b.paramTypes[i])) return false;
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
export function typeEqualsWithStrippedTraits(a: Type, b: Type): boolean {
    return typeEquals(stripTraits(a), stripTraits(b));
}

/** Check if a type is fully concrete (not a type variable from an enclosing generic). */
export function isConcreteType(t: Type): boolean {
    if (typeof t === "string") return true;
    if (t instanceof CustomType) {
        return isBuiltinTypeName(t.name);
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

/** Check if two types match, allowing optional Arr[X] ↔ Iter[X] auto-conversion
 *  and ignoring trait differences on CustomTypes. */
export function typesMatchWithConversion(a: Type, b: Type, allowIterForArr: boolean): boolean {
    if (typeEquals(a, b)) return true;
    // Try comparison with traits stripped (traits are metadata, not semantic type identity)
    if (typeEquals(stripTraits(a), stripTraits(b))) return true;
    if (allowIterForArr) {
        // Arr[X] can be treated as Iter[X]
        if (a instanceof IterType && b instanceof ArrayType) {
            return typesMatchWithConversion(a.innerType, b.innerType, allowIterForArr);
        }
        if (a instanceof ArrayType && b instanceof IterType) {
            return typesMatchWithConversion(a.innerType, b.innerType, allowIterForArr);
        }
    }
    return false;
}

export function paramTypesMatchArgTypes(
    funcParamTypes: Type[],
    argTypes: Type[],
    allowIterForArr: boolean = true
): boolean {
    if (funcParamTypes.length !== argTypes.length) return false;
    return funcParamTypes.every((t, i) =>
        typesMatchWithConversion(t, argTypes[i], allowIterForArr)
    );
}

/** Loose type comparison that allows type variables (non-concrete types) to match anything */
export function looseMatch(a: Type, b: Type): boolean {
    if (a === b) return true;
    // If either type is not concrete, allow the match (for generic function bodies)
    // TODO: This probably is not quite correct and could lead to bugs!
    if (!isConcreteType(a) || !isConcreteType(b)) return true;
    return typeEquals(a, b);
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
