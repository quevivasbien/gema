import { TokenType, type Token } from "../tokens";
import type { JSWriter } from "../write-js";
import { Expression } from "./expression";
import { resolveGenericTaf } from "./taf-resolver";
import { findFunctionByPrefix, getEnum, getStruct, getTrait, registerStruct } from "./registries";
import { deepEquals } from "./type-utils";
import {
    ArrayType,
    CustomType,
    EnumType,
    FuncType,
    substituteTypeParams,
    TemplateTypes,
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

    cascadeTypes(valueUsed: boolean): void {
        this.isValueUsed = valueUsed;
        this.expressions.forEach((expr, i) => {
            expr.cascadeTypes(true);
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

    cascadeTypes(valueUsed: boolean): void {
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
    /** For type-associated function references, the full registry name (e.g., "Int.zero$"). */
    tafTargetName: string | null = null;

    constructor(
        public obj: Expression,
        public fieldName: string
    ) {
        super(obj.line, obj.col);
    }

    cascadeTypes(valueUsed: boolean): void {
        this.isValueUsed = valueUsed;
        this.obj.cascadeTypes(valueUsed);
        if (this.obj.type === null) {
            throw this.error("unable to resolve type of object");
        }

        if (this.obj.type instanceof EnumType) {
            const enumInfo = getEnum(this.obj.type.name);
            if (!enumInfo) {
                throw this.error(`enum ${this.obj.type.name} not found in registry`);
            }
            const variant = enumInfo.variants.find((v) => v.name === this.fieldName);
            if (!variant) {
                throw this.error(`enum ${enumInfo.name} has no variant named "${this.fieldName}"`);
            }
            // Tagged variant: resolves to a constructor function (valueType → Enum)
            if (variant.type !== null) {
                this.type = new FuncType([variant.type], this.obj.type);
            } else {
                // Plain variant: resolves to the enum type itself
                this.type = this.obj.type;
            }
            return;
        }

        if (!(this.obj.type instanceof CustomType)) {
            throw this.error(`cannot access field on non-struct type ${this.obj.type}`);
        }
        const objTypeName = this.obj.type.name;

        // Build TAF search key, incorporating template types if the object has templates (Variable)
        const tafPrefix = `${objTypeName}.${this.fieldName}`;
        const hasTemplates =
            this.obj instanceof Expression &&
            "templateTypes" in (this.obj as object) &&
            (this.obj as unknown as Record<string, unknown>).templateTypes instanceof
                TemplateTypes &&
            !(
                (this.obj as unknown as Record<string, unknown>).templateTypes as TemplateTypes
            ).empty();
        if (hasTemplates) {
            // For Arr[Int].empty(), also try Arr[Int].empty as search key
            const templatedPrefix = `${objTypeName}${(this.obj as unknown as Record<string, unknown>).templateTypes}.${this.fieldName}`;
            // Try templated version first (concrete TAFs like Arr[Int].empty)
            const templatedDef =
                findFunctionByPrefix(templatedPrefix + "$") ??
                findFunctionByPrefix(templatedPrefix);
            if (templatedDef) {
                this.type = templatedDef.getFuncType();
                this.tafTargetName = templatedDef.fullName;
                return;
            }
        }

        // Helper: try to find and monomorphize a generic TAF among sibling definitions
        const tryResolveGenericTaf = (): boolean => {
            const callTemplateTypes =
                this.obj instanceof Expression &&
                typeof (this.obj as unknown as Record<string, unknown>).templateTypes !==
                    "undefined"
                    ? (
                          (this.obj as unknown as Record<string, unknown>)
                              .templateTypes as TemplateTypes
                      ).types
                    : [];
            const result = resolveGenericTaf(
                this.parent,
                objTypeName,
                this.fieldName,
                callTemplateTypes
            );
            if (result) {
                this.type = result.funcType;
                this.tafTargetName = result.fullName;
                return true;
            }
            return false;
        };

        // Check for type-associated function: TypeName.funcName
        if (!getStruct(objTypeName)) {
            // This CustomType is not a struct — check for a type-associated function
            let fnDef = findFunctionByPrefix(tafPrefix);
            if (!fnDef) fnDef = findFunctionByPrefix(tafPrefix + "$");
            if (fnDef) {
                this.type = fnDef.getFuncType();
                this.tafTargetName = fnDef.fullName;
                return;
            }
            // Try generic TAF resolution
            if (tryResolveGenericTaf()) return;
            // Try trait dispatch for type-associated functions inside generic bodies
            const objType = this.obj.type;
            if (objType instanceof CustomType && objType.traits.length > 0) {
                const traitFuncName = `Self.${this.fieldName}`;
                for (const traitName of objType.traits) {
                    const traitFuncs = getTrait(traitName);
                    if (!traitFuncs) continue;
                    for (const tf of traitFuncs) {
                        if (tf.name !== traitFuncName) continue;
                        // Replace Self with this type in param and return types
                        const selfType = objType;
                        const replacedParamTypes = tf.types.types.map((t) => {
                            if (t === "Self" || (t instanceof CustomType && t.name === "Self"))
                                return selfType;
                            return t;
                        });
                        const replacedReturnType: Type =
                            tf.types.returnType === "Self" ||
                            (tf.types.returnType instanceof CustomType &&
                                tf.types.returnType.name === "Self")
                                ? selfType
                                : (tf.types.returnType ?? "Null");
                        this.type = new FuncType(replacedParamTypes, replacedReturnType);
                        this.tafTargetName = `${objTypeName}.${this.fieldName}`;
                        return;
                    }
                }
            }
            throw this.error(
                `type ${objTypeName} has no field or function named "${this.fieldName}"`
            );
        }

        const structInfo = getStruct(objTypeName);
        if (!structInfo) {
            throw this.error(`type ${objTypeName} is not a struct`);
        }
        // Check for type-associated function on struct before checking fields
        const tafDef = findFunctionByPrefix(tafPrefix + "$") ?? findFunctionByPrefix(tafPrefix);
        if (tafDef) {
            this.type = tafDef.getFuncType();
            this.tafTargetName = tafDef.fullName;
            return;
        }
        // Try generic TAF resolution for structs too
        if (tryResolveGenericTaf()) return;
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
        if (this.obj.type instanceof EnumType) {
            const enumInfo = getEnum(this.obj.type.name)!;
            const vIdx = enumInfo.variants.findIndex((v) => v.name === this.fieldName);
            if (vIdx === -1) return; // shouldn't happen
            const variant = enumInfo.variants[vIdx];

            // Plain enum (no tagged variants): emit tag index as number
            if (!this.obj.type.isTagged) {
                writer.write(String(vIdx));
                return;
            }

            // Tagged variant: emit a factory function so DirectCall can invoke it
            if (variant.type !== null) {
                // TODO: This could be made more efficient if we check ahead of time whether this is immediately invoked
                writer.write(`($$val) => { return { "$tag": ${vIdx}, "$val": $$val }; }`);
                return;
            }

            // Plain variant in a mixed/tagged enum: emit the object directly
            writer.write(`{"$tag": ${vIdx}, "$val": null}`);
            return;
        }

        // Type-associated function reference: emit sanitized function name
        if (this.tafTargetName) {
            writer.write(writer.safeName(this.tafTargetName));
            return;
        }

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

    cascadeTypes(valueUsed: boolean): void {
        this.isValueUsed = valueUsed;
        this.value.cascadeTypes(true);
        this.obj.cascadeTypes(valueUsed);
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
