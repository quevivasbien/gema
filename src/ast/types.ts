// Built-in type names that cannot be used as type parameters or user-defined types
const BUILTIN_TYPE_NAMES = new Set([
    "Int",
    "Num",
    "Str",
    "Bool",
    "Func",
    "Arr",
    "Iter",
    "MutArr",
    "Tup",
    "Dict",
    "Set",
    "Maybe",
    "Self",
]);

export function isBuiltinTypeName(name: string): boolean {
    return BUILTIN_TYPE_NAMES.has(name);
}

export class FuncType {
    constructor(
        /** The types of arguments that this function expects to receive */
        public paramTypes: Type[],
        /** The type of the value that this function produces */
        public returnType: Type,
        /** If this function is associated with a specific type --
         * e.g., a call to Foo.bar(1, 2, 3) would have associated type Foo
         */
        public associatedType: Type | null = null
    ) {}

    toString(): string {
        const str = `$Func[${this.paramTypes.join(", ")}: ${this.returnType}]`;
        if (this.associatedType !== null) {
            return `(${this.associatedType.toString()})${str}`;
        }
        return str;
    }
}

export class ArrayType {
    constructor(public innerType: Type) {}

    toString(): string {
        return `Arr[${this.innerType}]`;
    }
}

export class IterType {
    constructor(public innerType: Type) {}

    toString(): string {
        return `Iter[${this.innerType}]`;
    }
}

export class MutArrType {
    constructor(public innerType: Type) {}

    toString(): string {
        return `MutArr[${this.innerType}]`;
    }
}

export class TupleType {
    constructor(public types: Type[]) {}

    toString(): string {
        return `Tup[${this.types.join(", ")}]`;
    }

    get length(): number {
        return this.types.length;
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
        // TODO: This is not right! The type has to match!
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
    /** Template arguments for generic types (e.g., Pair[Int] → templateArgs=[Int]).
     *  Used by generic structs and enums to carry concrete type args. */
    templateArgs: Type[];

    constructor(name: string, templateArgs: Type[] = []) {
        this.name = name;
        this.templateArgs = templateArgs;
    }

    toString(): string {
        if (this.templateArgs.length === 0) {
            return this.name;
        } else {
            return `${this.name}[${this.templateArgs.map((ta) => ta.toString()).join(", ")}]`;
        }
    }
}

export class GenericType {
    name: string;
    traits: string[];

    constructor(name: string, traits: string[]) {
        this.name = name;
        this.traits = traits;
    }

    toString(): string {
        return `${this.name}[[${this.traits.join(", ")}]]`;
    }

    addTrait(trait: string) {
        this.traits.push(trait);
    }
}

export class EscapeType {
    constructor(public innerType: Type) {}

    toString(): string {
        return `Escape[${this.innerType}]`;
    }
}

export type Type =
    | "Int"
    | "Num"
    | "Str"
    | "Bool"
    | "Null"
    | EscapeType
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
    | GenericType
    | "Self"
    | "Unknown";

export type CallableType =
    | FuncType
    | IterType
    | ArrayType
    | MutArrType
    | TupleType
    | DictType
    | MutDictType
    | "Str";

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

export function getType(
    typeName: string,
    templateTypes: TemplateTypes,
    generics: Record<string, { traits: string[]; used: boolean }> | null = null
): Type {
    if (generics !== null && typeName in generics) {
        if (!templateTypes.empty()) {
            throw new Error(`Generic type ${typeName} cannot have template types`);
        }
        // Mark this generic as used so the parser can easily figure out if we try to declare a function with a generic that is not used as part of the function definition
        generics[typeName].used = true;
        return new GenericType(typeName, generics[typeName].traits);
    }
    if (["Int", "Num", "Str", "Bool", "Null", "Self"].includes(typeName)) {
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
    if (typeName === "Tup") {
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

    return new CustomType(
        typeName,
        templateTypes.types.length > 0 ? templateTypes.types : undefined
    );
}
