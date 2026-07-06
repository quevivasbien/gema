import type { Token } from "../tokens";
import type { JSWriter } from "../write-js";
import { Expression } from "./expression";
import type { Scope } from "./scope";
import { resolveGenericTaf } from "./taf-resolver";
import { substituteTypeParams, typeEquals } from "./type-utils";
import {
    ArrayType,
    CustomType,
    FuncType,
    isBuiltinTypeName,
    type TemplateTypes,
    type Type,
} from "./types";

export class ArrLit extends Expression {
    expressions: Expression[];
    innerType?: Type;

    constructor(startToken: Token, expressions: Expression[], innerType?: Type) {
        super(startToken.line, startToken.col);
        this.expressions = expressions;
        if (innerType !== undefined) {
            this.innerType = innerType;
        }
    }

    cascadeTypes(parent: Expression | null, valueUsed: boolean): void {
        super.cascadeTypes(parent, valueUsed);
        this.expressions.forEach((expr, i) => {
            expr.cascadeTypes(this, true);
            if (expr.type === null) {
                throw this.error(`unable to resolve type of array element ${i + 1}`);
            }
            if (this.innerType === undefined) {
                this.innerType = expr.type;
            } else if (!typeEquals(this.innerType, expr.type)) {
                throw this.error(
                    `incompatible types in array: expected ${this.innerType}, got ${expr.type}`
                );
            }
        });
        if (this.innerType === undefined) {
            throw this.error(`empty array must be annotated with a type`);
        }
        this.type = new ArrayType(this.innerType);
    }

    toJS(writer: JSWriter): void {
        writer.write("[");
        this.expressions.forEach((expr, i) => {
            if (i > 0) {
                writer.write(", ");
            }
            expr.toJS(writer);
        });
        writer.write("]");
    }
}

export class StructDef extends Expression {
    name: string;
    fields: { name: string; type: Type; mutable: boolean }[];
    typeParams: string[] = [];
    monomorphizedVersions: StructDef[] = [];

    constructor(
        rootToken: Token,
        name: string,
        fields: { name: string; type: Type; mutable: boolean }[],
        typeParams: string[] = []
    ) {
        super(rootToken.line, rootToken.col);
        this.name = name;
        this.fields = fields;
        this.typeParams = typeParams;
        this.type = "Null";
    }

    get isGeneric(): boolean {
        return this.typeParams.length > 0;
    }

    cascadeTypes(parent: Expression | null, valueUsed: boolean): void {
        super.cascadeTypes(parent, valueUsed);
        // Register in enclosing scope so Variable references and Call resolution can find it
        const blockScope = this.getScope();
        if (blockScope) {
            blockScope.defineVariable({
                class: "struct",
                name: this.name,
                fields: this.fields,
                isGeneric: this.isGeneric || undefined,
                typeParams: this.typeParams.length > 0 ? this.typeParams : undefined,
                def: this.isGeneric ? this : undefined,
            });
        }
    }

    // TODO: This needs to be completely reworked given our new scope system and the new GenericType
    // /**
    //  * Monomorphize this generic struct with concrete type arguments inferred
    //  * from constructor argument types. Returns the concrete field types and
    //  * registers the monomorphized version in scope.
    //  */
    // monomorphize(argTypes: Type[]): {
    //     fields: { name: string; type: Type; mutable: boolean }[];
    //     structType: CustomType;
    // } | null {
    //     if (!this.isGeneric) return null;

    //     const bindings = new Map<string, Type>();
    //     // Match field types against arg types to infer type param bindings
    //     if (
    //         !extractGenericBindingsFromParams(
    //             this.fields.map((f) => ({ name: f.name, type: f.type })),
    //             argTypes,
    //             this.typeParams,
    //             bindings
    //         )
    //     ) {
    //         return null;
    //     }

    //     // Verify all type params have bindings
    //     for (const tp of this.typeParams) {
    //         if (!bindings.has(tp)) return null;
    //     }

    //     // Substitute field types with concrete types
    //     const concreteFields = this.fields.map((f) => ({
    //         name: f.name,
    //         type: substituteTypeParams(f.type, bindings),
    //         mutable: f.mutable,
    //     }));

    //     const concreteTypeArgs = this.typeParams.map(
    //         (tp) => bindings.get(tp) ?? new CustomType(tp)
    //     );
    //     const structType = new CustomType(this.name, [], concreteTypeArgs);
    //     return { fields: concreteFields, structType };
    // }

    toJS(_writer: JSWriter): void {
        // Struct definitions are for type-checking only; not emitted to JS
    }
}

export class FieldAccess extends Expression {
    /** For type-associated function references, the full registry name (e.g., "Int.zero$"). */
    tafTargetName: string | null = null;

    constructor(
        public obj: Expression,
        public fieldName: string
    ) {
        super(obj.line, obj.col);
    }

    cascadeTypes(parent: Expression | null, valueUsed: boolean): void {
        super.cascadeTypes(parent, valueUsed);
        this.obj.cascadeTypes(this, valueUsed);
        if (this.obj.type === null) {
            throw this.error("unable to resolve type of object");
        }

        if (!(this.obj.type instanceof CustomType)) {
            throw this.error(`cannot access field on non-struct type ${this.obj.type}`);
        }
        const objTypeName = this.obj.type.name;

        // /** Look up a trait's required functions from scope, falling back to global registry. */
        // const findTraitFuncs = (
        //     traitName: string
        // ): { name: string; paramNames: string[]; types: TemplateTypes }[] | undefined => {
        //     const scope = this.getScope();
        //     if (scope) {
        //         const lookup = scope.lookup(traitName);
        //         if (lookup && lookup.attrs.class === "trait") {
        //             return lookup.attrs.requiredFunctions;
        //         }
        //     }
        //     return undefined;
        // };

        const structInfo = this.getScope()?.lookupStruct(objTypeName);
        if (!structInfo) {
            throw this.error(`type ${objTypeName} is not a struct`);
        }

        const field = structInfo.fields.find((f) => f.name === this.fieldName);
        if (!field) {
            throw this.error(`struct ${structInfo.name} has no field named "${this.fieldName}"`);
        }
        // If the struct type has template args (it was monomorphized), substitute
        // the type parameters in the field type to get the concrete field type.
        if (
            this.obj.type instanceof CustomType &&
            this.obj.type.templateArgs &&
            structInfo.isGeneric &&
            structInfo.typeParams
        ) {
            const bindings = new Map<string, Type>();
            for (let i = 0; i < structInfo.typeParams.length; i++) {
                if (i < this.obj.type.templateArgs.length) {
                    bindings.set(structInfo.typeParams[i], this.obj.type.templateArgs[i]);
                }
            }
            this.type = substituteTypeParams(field.type, bindings);
        } else {
            this.type = field.type;
        }
    }

    toJS(writer: JSWriter): void {
        writer.write("(");
        this.obj.toJS(writer);
        writer.write(`).${this.fieldName}`);
    }
}

export class FieldAssignment extends Expression {
    obj: Expression;
    fieldName: string;
    value: Expression;
    isDropped: boolean = false;

    constructor(obj: Expression, fieldName: string, value: Expression, isDropped: boolean = false) {
        super(obj.line, obj.col);
        this.obj = obj;
        this.fieldName = fieldName;
        this.value = value;
        this.isDropped = isDropped;
    }

    cascadeTypes(parent: Expression | null, valueUsed: boolean): void {
        super.cascadeTypes(parent, valueUsed);
        this.value.cascadeTypes(this, true);
        this.obj.cascadeTypes(this, valueUsed);
        if (this.obj.type === null) {
            throw this.error("unable to resolve type of object");
        }
        if (!(this.obj.type instanceof CustomType)) {
            throw this.error(`cannot assign field on non-struct type ${this.obj.type}`);
        }
        const objScope = this.getScope();
        let structInfo:
            | { name: string; fields: { name: string; type: Type; mutable: boolean }[] }
            | undefined;
        if (objScope) {
            const lookup = objScope.lookup(this.obj.type.name);
            if (lookup && lookup.attrs.class === "struct") {
                structInfo = { name: lookup.attrs.name, fields: lookup.attrs.fields };
            }
        }
        if (!structInfo) {
            throw this.error(`type ${this.obj.type.name} is not a struct`);
        }
        const field = structInfo.fields.find((f) => f.name === this.fieldName);
        if (!field) {
            throw this.error(`struct ${structInfo.name} has no field named "${this.fieldName}"`);
        }
        if (!field.mutable) {
            throw this.error(
                `cannot assign to non-mutable field '${this.fieldName}' on struct ${structInfo.name}`
            );
        }
        const assignType = this.value.type!;
        if (!typeEquals(field.type, assignType)) {
            throw this.error(
                `cannot assign value of type ${assignType} to field '${this.fieldName}' of type ${field.type}`
            );
        }
        this.type = this.isDropped ? "Null" : assignType;
    }

    toJS(writer: JSWriter): void {
        this.obj.toJS(writer);
        writer.write(`.${this.fieldName} = `);
        this.value.toJS(writer);
    }
}
