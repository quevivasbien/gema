import {
    ArrayType,
    CustomType,
    DictType,
    EscapeType,
    FuncType,
    GenericType,
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
export function typeEquals(
    a: unknown,
    b: unknown,
    looseMatchForGenerics: boolean = false
): boolean {
    if (a === b) return true;

    if (a == null || b == null) return false;

    // String primitives
    if (typeof a === "string" && typeof b === "string") {
        return a === b;
    }

    // Handle (optional) loose match for generic types
    if (looseMatchForGenerics && (a instanceof GenericType || b instanceof GenericType)) {
        return true;
    }

    // If one is a string and the other isn't, they can't be equal
    if (typeof a !== typeof b) return false;

    // If they're not objects at this point, use strict equality
    if (typeof a !== "object" || typeof b !== "object") return a === b;

    // EscapeType
    if (a instanceof EscapeType && b instanceof EscapeType) {
        return typeEquals(a.innerType, b.innerType, looseMatchForGenerics);
    }
    if (a instanceof EscapeType || b instanceof EscapeType) {
        return false;
    }

    // CustomType
    if (a instanceof CustomType && b instanceof CustomType) {
        if (a.name !== b.name) return false;
        // Compare template args
        if (a.templateArgs && b.templateArgs) {
            if (a.templateArgs.length !== b.templateArgs.length) return false;
            for (let i = 0; i < a.templateArgs.length; i++) {
                if (!typeEquals(a.templateArgs[i], b.templateArgs[i], looseMatchForGenerics))
                    return false;
            }
        } else if (a.templateArgs || b.templateArgs) {
            return false;
        }
        return true;
    }

    // GenericType
    if (a instanceof GenericType && b instanceof GenericType) {
        if (a.name !== b.name) return false;
        if (a.traits.length !== b.traits.length) return false;
        for (let i = 0; i < a.traits.length; i++) {
            if (a.traits[i] !== b.traits[i]) return false;
        }
        return true;
    }

    // ArrayType
    if (a instanceof ArrayType && b instanceof ArrayType) {
        return typeEquals(a.innerType, b.innerType, looseMatchForGenerics);
    }

    // IterType
    if (a instanceof IterType && b instanceof IterType) {
        return typeEquals(a.innerType, b.innerType, looseMatchForGenerics);
    }

    // MutArrType
    if (a instanceof MutArrType && b instanceof MutArrType) {
        return typeEquals(a.innerType, b.innerType, looseMatchForGenerics);
    }

    // TupleType
    if (a instanceof TupleType && b instanceof TupleType) {
        if (a.types.length !== b.types.length) return false;
        for (let i = 0; i < a.types.length; i++) {
            if (!typeEquals(a.types[i], b.types[i], looseMatchForGenerics)) return false;
        }
        return true;
    }

    // DictType
    if (a instanceof DictType && b instanceof DictType) {
        if (!typeEquals(a.keyType, b.keyType, looseMatchForGenerics)) return false;
        if (!typeEquals(a.valueType, b.valueType, looseMatchForGenerics)) return false;
        return true;
    }

    // MutDictType
    if (a instanceof MutDictType && b instanceof MutDictType) {
        if (!typeEquals(a.keyType, b.keyType, looseMatchForGenerics)) return false;
        if (!typeEquals(a.valueType, b.valueType, looseMatchForGenerics)) return false;
        return true;
    }

    // SetType
    if (a instanceof SetType && b instanceof SetType) {
        return typeEquals(a.innerType, b.innerType, looseMatchForGenerics);
    }

    // MutSetType
    if (a instanceof MutSetType && b instanceof MutSetType) {
        return typeEquals(a.innerType, b.innerType, looseMatchForGenerics);
    }

    // MaybeType
    if (a instanceof MaybeType && b instanceof MaybeType) {
        return typeEquals(a.innerType, b.innerType, looseMatchForGenerics);
    }

    // FuncType
    if (a instanceof FuncType && b instanceof FuncType) {
        if (!typeEquals(a.returnType, b.returnType, looseMatchForGenerics)) return false;
        if (a.paramTypes.length !== b.paramTypes.length) return false;
        for (let i = 0; i < a.paramTypes.length; i++) {
            if (!typeEquals(a.paramTypes[i], b.paramTypes[i], looseMatchForGenerics)) return false;
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
    if (t instanceof EscapeType) {
        return new EscapeType(stripTraits(t.innerType));
    }
    return t;
}

/** Check if a type is fully concrete (not a type variable from an enclosing generic).
 * TODO: This is not used by anything anymore and maybe could be removed
 */
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
    if (t instanceof EscapeType) return isConcreteType(t.innerType);
    if (t instanceof FuncType)
        return t.paramTypes.every(isConcreteType) && isConcreteType(t.returnType);
    return true;
}

/** Check if two types match, allowing optional Arr[X] ↔ Iter[X] auto-conversion
 *  and ignoring trait differences on CustomTypes.
 *  TODO: I think we may want to get rid of this helper. */
export function typesMatchWithConversion(a: Type, b: Type, allowArrForIter: boolean): boolean {
    if (typeEquals(a, b)) return true;
    // Try comparison with traits stripped (traits are metadata, not semantic type identity)
    if (typeEquals(stripTraits(a), stripTraits(b))) return true;
    if (allowArrForIter) {
        // Arr[X] can be treated as Iter[X]
        if (a instanceof IterType && b instanceof ArrayType) {
            return typesMatchWithConversion(a.innerType, b.innerType, allowArrForIter);
        }
        if (a instanceof ArrayType && b instanceof IterType) {
            return typesMatchWithConversion(a.innerType, b.innerType, allowArrForIter);
        }
    }
    return false;
}

export function paramTypesMatchArgTypes(
    funcParamTypes: Type[],
    argTypes: Type[],
    allowArrForIter: boolean = false
): boolean {
    if (funcParamTypes.length !== argTypes.length) return false;
    return funcParamTypes.every((t, i) =>
        typesMatchWithConversion(t, argTypes[i], allowArrForIter)
    );
}

export function compatibleIndicesForArrayType(indexTypes: Type[]): string | null {
    if (indexTypes.length !== 1) {
        return `indexed access requires exactly one index, got ${indexTypes.length}`;
    }
    if (indexTypes[0] !== "Int" && indexTypes[0] !== "Num") {
        return `indexed access index must be of type Int or Num`;
    }
    return null;
}

// Substitute type parameters in a type tree using a binding map
export function substituteTypeParams(type: Type, bindings: Map<string, Type>): Type {
    if (type === "Self" && bindings.has("Self")) {
        const substituted = bindings.get("Self")!;
        return substituted;
    }
    if ((type instanceof CustomType || type instanceof GenericType) && bindings.has(type.name)) {
        const substituted = bindings.get(type.name)!;
        return substituted;
    }
    if (type instanceof CustomType && type.templateArgs) {
        return new CustomType(
            type.name,
            type.templateArgs.map((t) => substituteTypeParams(t, bindings))
        );
    }
    if (type instanceof FuncType) {
        return new FuncType(
            type.paramTypes.map((pt) => substituteTypeParams(pt, bindings)),
            substituteTypeParams(type.returnType, bindings)
        );
    }
    if (type instanceof ArrayType) {
        return new ArrayType(substituteTypeParams(type.innerType, bindings));
    }
    if (type instanceof IterType) {
        return new IterType(substituteTypeParams(type.innerType, bindings));
    }
    if (type instanceof MutArrType) {
        return new MutArrType(substituteTypeParams(type.innerType, bindings));
    }
    if (type instanceof TupleType) {
        return new TupleType(type.types.map((t) => substituteTypeParams(t, bindings)));
    }
    if (type instanceof DictType) {
        return new DictType(
            substituteTypeParams(type.keyType, bindings),
            substituteTypeParams(type.valueType, bindings)
        );
    }
    if (type instanceof MutDictType) {
        return new MutDictType(
            substituteTypeParams(type.keyType, bindings),
            substituteTypeParams(type.valueType, bindings)
        );
    }
    if (type instanceof SetType) {
        return new SetType(substituteTypeParams(type.innerType, bindings));
    }
    if (type instanceof MutSetType) {
        return new MutSetType(substituteTypeParams(type.innerType, bindings));
    }
    if (type instanceof MaybeType) {
        return new MaybeType(substituteTypeParams(type.innerType, bindings));
    }
    if (type instanceof EscapeType) {
        return new EscapeType(substituteTypeParams(type.innerType, bindings));
    }
    return type;
}
