import type { JSWriter } from "../write-js";
import { TokenType, type Token } from "../tokens";
import { deepEquals } from "../deep-equals";
import { ArrayType, CustomType, substituteTypeParams, type Type } from "../types";
import { Expression } from "./expression";
import { getStruct, registerStruct } from "./registries";

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

    cascadeTypes(ancestors: Expression[], valueUsed: boolean): void {
        this.isValueUsed = valueUsed;
        this.expressions.forEach((expr, i) => {
            expr.cascadeTypes(ancestors, true);
            if (expr.type === null) {
                throw this.error(`unable to resolve type of array element ${i + 1}`);
            }
            if (this.innerType === undefined) {
                this.innerType = expr.type;
            } else if (!deepEquals(this.innerType, expr.type)) {
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

    clone(bindings?: Map<string, Type>): Expression {
        const newInnerType =
            this.innerType !== undefined && bindings
                ? substituteTypeParams(this.innerType, bindings)
                : this.innerType;
        return new ArrLit(
            { line: this.line, col: this.col, text: "[", type: TokenType.LBracket },
            this.expressions.map((e) => e.clone(bindings)),
            newInnerType
        );
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

    constructor(
        rootToken: Token,
        name: string,
        fields: { name: string; type: Type; mutable: boolean }[]
    ) {
        super(rootToken.line, rootToken.col);
        this.name = name;
        this.fields = fields;
        this.type = "Null";

        registerStruct(name, fields);
    }

    cascadeTypes(_ancestors: Expression[], valueUsed: boolean): void {
        this.isValueUsed = valueUsed;
        // Nothing to cascade — struct definition just registers its type
    }

    clone(_bindings?: Map<string, Type>): Expression {
        return this; // Struct definitions are immutable, safe to share
    }

    toJS(_writer: JSWriter): void {
        // Struct definitions are for type-checking only; not emitted to JS
    }
}

export class FieldAccess extends Expression {
    constructor(
        public obj: Expression,
        public fieldName: string
    ) {
        super(obj.line, obj.col);
    }

    cascadeTypes(ancestors: Expression[], valueUsed: boolean): void {
        this.isValueUsed = valueUsed;
        this.obj.cascadeTypes([...ancestors, this], valueUsed);
        if (this.obj.type === null) {
            throw this.error("unable to resolve type of object");
        }
        if (!(this.obj.type instanceof CustomType)) {
            throw this.error(`cannot access field on non-struct type ${this.obj.type}`);
        }
        const structInfo = getStruct(this.obj.type.name);
        if (!structInfo) {
            throw this.error(`type ${this.obj.type.name} is not a struct`);
        }
        const field = structInfo.fields.find((f) => f.name === this.fieldName);
        if (!field) {
            throw this.error(`struct ${structInfo.name} has no field named "${this.fieldName}"`);
        }
        this.type = field.type;
    }

    clone(bindings?: Map<string, Type>): Expression {
        return new FieldAccess(this.obj.clone(bindings), this.fieldName);
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

    cascadeTypes(ancestors: Expression[], valueUsed: boolean): void {
        this.isValueUsed = valueUsed;
        this.value.cascadeTypes([...ancestors, this], true);
        this.obj.cascadeTypes([...ancestors, this], valueUsed);
        if (this.obj.type === null) {
            throw this.error("unable to resolve type of object");
        }
        if (!(this.obj.type instanceof CustomType)) {
            throw this.error(`cannot assign field on non-struct type ${this.obj.type}`);
        }
        const structInfo = getStruct(this.obj.type.name);
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
        if (!deepEquals(field.type, assignType)) {
            throw this.error(
                `cannot assign value of type ${assignType} to field '${this.fieldName}' of type ${field.type}`
            );
        }
        this.type = this.isDropped ? "Null" : assignType;
    }

    clone(bindings?: Map<string, Type>): Expression {
        return new FieldAssignment(
            this.obj.clone(bindings),
            this.fieldName,
            this.value.clone(bindings),
            this.isDropped
        );
    }

    toJS(writer: JSWriter): void {
        this.obj.toJS(writer);
        writer.write(`.${this.fieldName} = `);
        this.value.toJS(writer);
    }
}
