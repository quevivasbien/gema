// Built-in type names that cannot be used as type parameters or user-defined types
const BUILTIN_TYPE_NAMES = new Set([
    "Int",
    "Float",
    "Str",
    "Bool",
    "Func",
    "Arr",
    "Iter",
    "MutArr",
    "Tuple",
    "Dict",
    "Set",
    "Maybe",
    "Self",
]);

export function isBuiltinTypeName(name: string): boolean {
    return BUILTIN_TYPE_NAMES.has(name);
}

// Collect all CustomType names from a type tree
export function collectCustomTypeNames(type: Type, names: Set<string>): void {
    if (type instanceof CustomType) {
        names.add(type.name);
    } else if (type instanceof FuncType) {
        type.paramTypes.forEach((pt) => collectCustomTypeNames(pt, names));
        collectCustomTypeNames(type.returnType, names);
    } else if (type instanceof ArrayType) {
        collectCustomTypeNames(type.innerType, names);
    } else if (type instanceof IterType) {
        collectCustomTypeNames(type.innerType, names);
    } else if (type instanceof MutArrType) {
        collectCustomTypeNames(type.innerType, names);
    } else if (type instanceof TupleType) {
        type.types.forEach((t) => collectCustomTypeNames(t, names));
    } else if (type instanceof DictType) {
        collectCustomTypeNames(type.keyType, names);
        collectCustomTypeNames(type.valueType, names);
    } else if (type instanceof MutDictType) {
        collectCustomTypeNames(type.keyType, names);
        collectCustomTypeNames(type.valueType, names);
    } else if (type instanceof SetType) {
        collectCustomTypeNames(type.innerType, names);
    } else if (type instanceof MutSetType) {
        collectCustomTypeNames(type.innerType, names);
    } else if (type instanceof MaybeType) {
        collectCustomTypeNames(type.innerType, names);
    }
}

// Substitute type parameters in a type tree using a binding map
export function substituteTypeParams(type: Type, bindings: Map<string, Type>): Type {
    if (type instanceof CustomType && bindings.has(type.name)) {
        const substituted = bindings.get(type.name)!;
        return substituted;
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
    return type;
}

export class FuncType {
    constructor(
        public paramTypes: Type[],
        public returnType: Type
    ) {}

    toString(): string {
        return `Func[${this.paramTypes.join(", ")}, ${this.returnType}]`;
    }
}

export class ArrayType {
    constructor(public innerType: Type) {}

    toString(): string {
        return `Arr[${this.innerType}]`;
    }

    nDims(): number {
        if (!(this.innerType instanceof ArrayType)) {
            return 1;
        }
        return 1 + this.innerType.nDims();
    }

    checkIndicesCompatible(indexTypes: Type[]): string | null {
        if (indexTypes.length < 1) {
            return "array access requires at least one index";
        }
        if (indexTypes.length > this.nDims()) {
            return `incompatible number of array indices: expected at most ${this.nDims()}, got ${indexTypes.length}`;
        }
        if (indexTypes.some((type) => type !== "Int")) {
            return `array indices are not of type Int`;
        }
        return null;
    }
}

export class IterType {
    constructor(public innerType: Type) {}

    toString(): string {
        return `Iter[${this.innerType}]`;
    }

    checkIndicesCompatible(indexTypes: Type[]): string | null {
        if (indexTypes.length !== 1) {
            return `iter type requires exactly one index, got ${indexTypes.length}`;
        }
        if (indexTypes[0] !== "Int") {
            return `iter index must be of type Int`;
        }
        return null;
    }
}

export class MutArrType {
    constructor(public innerType: Type) {}

    toString(): string {
        return `MutArr[${this.innerType}]`;
    }

    checkIndicesCompatible(indexTypes: Type[]): string | null {
        if (indexTypes.length !== 1) {
            return `mutable array requires exactly one index, got ${indexTypes.length}`;
        }
        if (indexTypes[0] !== "Int") {
            return `mutable array index must be of type Int`;
        }
        return null;
    }
}

export class TupleType {
    constructor(public types: Type[]) {}

    toString(): string {
        return `Tuple[${this.types.join(", ")}]`;
    }

    get length(): number {
        return this.types.length;
    }

    checkIndicesCompatible(indexTypes: Type[]): string | null {
        if (indexTypes.length !== 1) {
            return `tuple type requires exactly one index, got ${indexTypes.length}`;
        }
        if (indexTypes[0] !== "Int") {
            return `tuple index must be of type Int`;
        }
        return null;
    }
}

export class DictType {
    constructor(
        public keyType: Type,
        public valueType: Type
    ) {}

    toString(): string {
        return `Dict[${this.keyType}, ${this.valueType}]`;
    }

    checkIndicesCompatible(indexTypes: Type[]): string | null {
        if (indexTypes.length !== 1) {
            return `dict requires exactly one key, got ${indexTypes.length}`;
        }
        // Any type is allowed as a key
        return null;
    }
}

export class MutDictType {
    constructor(
        public keyType: Type,
        public valueType: Type
    ) {}

    toString(): string {
        return `MutDict[${this.keyType}, ${this.valueType}]`;
    }

    checkIndicesCompatible(indexTypes: Type[]): string | null {
        if (indexTypes.length !== 1) {
            return `mutdict requires exactly one key, got ${indexTypes.length}`;
        }
        // Any type is allowed as a key
        return null;
    }
}

export class SetType {
    constructor(public innerType: Type) {}

    toString(): string {
        return `Set[${this.innerType}]`;
    }
}

export class MutSetType {
    constructor(public innerType: Type) {}

    toString(): string {
        return `MutSet[${this.innerType}]`;
    }
}

export class MaybeType {
    constructor(public innerType: Type) {}

    toString(): string {
        return `Maybe[${this.innerType}]`;
    }
}

export class CustomType {
    name: string;
    traits: string[];

    constructor(name: string, traits: string[] = []) {
        this.name = name;
        this.traits = traits;
    }

    toString(): string {
        if (this.traits.length === 0) {
            return this.name;
        }
        return `${this.name}[[${this.traits.join(", ")}]]`;
    }

    addTrait(trait: string) {
        this.traits.push(trait);
    }
}

export type Type =
    | "Int"
    | "Float"
    | "Str"
    | "Bool"
    | "Null"
    | FuncType
    | ArrayType
    | IterType
    | MutArrType
    | TupleType
    | DictType
    | MutDictType
    | SetType
    | MutSetType
    | MaybeType
    | CustomType
    | "Self";

export type CallableType =
    | FuncType
    | ArrayType
    | IterType
    | MutArrType
    | TupleType
    | DictType
    | MutDictType
    | MutSetType;

export class TemplateTypes {
    constructor(
        public types: Type[] = [],
        public returnType: Type | null = null
    ) {}

    toString(): string {
        return `[${this.types.join(", ")}${this.returnType === null ? "" : ": " + this.returnType}]`;
    }

    push(type: Type) {
        this.types.push(type);
    }

    empty(): boolean {
        return this.types.length === 0 && this.returnType === null;
    }
}

export function getType(typeName: string, templateTypes: TemplateTypes): Type {
    if (["Int", "Float", "Str", "Bool", "Null", "Self"].includes(typeName)) {
        if (!templateTypes.empty()) {
            throw new Error(`${typeName} cannot have template types`);
        }
        return typeName as Type;
    }
    if (typeName === "Func") {
        if (templateTypes.returnType === null) {
            throw new Error(`Func type requires a return type`);
        }
        return new FuncType(templateTypes.types, templateTypes.returnType);
    }
    if (typeName === "Arr") {
        if (templateTypes.types.length !== 1) {
            throw new Error(`Array type requires a single template type (for the inner type)`);
        }
        if (templateTypes.returnType !== null) {
            throw new Error(`Array type cannot have a return type`);
        }
        return new ArrayType(templateTypes.types[0]);
    }
    if (typeName === "Iter") {
        if (templateTypes.types.length !== 1) {
            throw new Error(`Iter type requires a single template type (for the inner type)`);
        }
        if (templateTypes.returnType !== null) {
            throw new Error(`Iter type cannot have a return type`);
        }
        return new IterType(templateTypes.types[0]);
    }
    if (typeName === "MutArr") {
        if (templateTypes.types.length !== 1) {
            throw new Error(`MutArr type requires a single template type (for the inner type)`);
        }
        if (templateTypes.returnType !== null) {
            throw new Error(`MutArr type cannot have a return type`);
        }
        return new MutArrType(templateTypes.types[0]);
    }
    if (typeName === "Tuple") {
        if (templateTypes.types.length < 1) {
            throw new Error(`Tuple type requires at least one template type`);
        }
        if (templateTypes.returnType !== null) {
            throw new Error(`Tuple type cannot have a return type`);
        }
        return new TupleType(templateTypes.types);
    }
    if (typeName === "Dict") {
        if (templateTypes.types.length !== 2) {
            throw new Error(`Dict type requires exactly two template types (key and value)`);
        }
        if (templateTypes.returnType !== null) {
            throw new Error(`Dict type cannot have a return type`);
        }
        return new DictType(templateTypes.types[0], templateTypes.types[1]);
    }

    if (typeName === "MutDict") {
        if (templateTypes.types.length !== 2) {
            throw new Error(`MutDict type requires two template types (key type and value type)`);
        }
        if (templateTypes.returnType !== null) {
            throw new Error(`MutDict type cannot have a return type`);
        }
        return new MutDictType(templateTypes.types[0], templateTypes.types[1]);
    }

    if (typeName === "Set") {
        if (templateTypes.types.length !== 1) {
            throw new Error(`Set type requires a single template type (for the inner type)`);
        }
        if (templateTypes.returnType !== null) {
            throw new Error(`Set type cannot have a return type`);
        }
        return new SetType(templateTypes.types[0]);
    }

    if (typeName === "MutSet") {
        if (templateTypes.types.length !== 1) {
            throw new Error(`MutSet type requires a single template type (for the inner type)`);
        }
        if (templateTypes.returnType !== null) {
            throw new Error(`MutSet type cannot have a return type`);
        }
        return new MutSetType(templateTypes.types[0]);
    }

    if (typeName === "Maybe") {
        if (templateTypes.types.length !== 1) {
            throw new Error(`Maybe type requires a single template type (for the inner type)`);
        }
        if (templateTypes.returnType !== null) {
            throw new Error(`Maybe type cannot have a return type`);
        }
        return new MaybeType(templateTypes.types[0]);
    }

    return new CustomType(typeName);
}
