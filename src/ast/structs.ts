import type { Token } from "../tokens";
import type { JSWriter } from "../write-js";
import { Expression } from "./expression";
import { substituteTypeParams, typeEquals } from "./type-utils";
import { CustomType, GenericType, type Type } from "./types";

export class StructDef extends Expression {
    name: string;
    fields: { name: string; type: Type; mutable: boolean }[];
    genericTypes: GenericType[];

    constructor(
        rootToken: Token,
        name: string,
        fields: { name: string; type: Type; mutable: boolean }[],
        genericTypes: GenericType[]
    ) {
        super(rootToken.line, rootToken.col);
        this.name = name;
        this.fields = fields;
        this.genericTypes = genericTypes;
        this.type = "Null";
    }

    isGeneric(): boolean {
        return this.genericTypes !== null && this.genericTypes.length > 0;
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
                templateTypes: this.genericTypes,
            });
        }
    }

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

        // Look up the original struct definition in scope
        const structInfo = this.getScope()?.lookupStruct(objTypeName);
        if (!structInfo) {
            throw this.error(`type ${objTypeName} is not a struct`);
        }

        const field = structInfo.fields.find((f) => f.name === this.fieldName);
        if (!field) {
            throw this.error(`struct ${structInfo.name} has no field named "${this.fieldName}"`);
        }
        // If the original struct definition was generic, substitute the appropriate type(s)
        if (structInfo.templateTypes.length > 0) {
            const bindings = new Map<string, Type>();
            for (let i = 0; i < structInfo.templateTypes.length; i++) {
                if (structInfo.templateTypes[i] instanceof GenericType) {
                    bindings.set(
                        (structInfo.templateTypes[i] as GenericType).name,
                        this.obj.type.templateArgs[i]
                    );
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
