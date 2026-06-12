import { deepEquals } from "../deep-equals";
import {
    isBuiltinTypeName,
    FuncType,
    ArrayType,
    IterType,
    MutArrType,
    TupleType,
    DictType,
    SetType,
    CustomType,
    type Type,
} from "../types";
import { getStruct } from "./registries";

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
    if (t instanceof SetType) {
        return new SetType(stripTraits(t.innerType));
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
    if (t instanceof SetType) return isConcreteType(t.innerType);
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
    return [];
}
