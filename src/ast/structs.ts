import { TokenType, type Token } from "../tokens";
import type { JSWriter } from "../write-js";
import { Expression } from "./expression";
import { resolveGenericTaf } from "./taf-resolver";
import type { Scope } from "./scope";
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

/**
 * Search a scope for a function entry whose fullName starts with the given prefix.
 * Used as a replacement for the removed global findFunctionByPrefix.
 */
function findFunctionInScopeByPrefix(
    scope: Scope | null,
    prefix: string
): { fullName: string; getFuncType: () => FuncType } | null {
    if (!scope) return null;
    // Search current scope first, then parent scopes
    let current: Scope | null = scope;
    while (current) {
        for (const v of current.variables) {
            if (v.class === "func" && v.fullName && v.fullName.startsWith(prefix)) {
                return {
                    fullName: v.fullName,
                    getFuncType: () => v.type,
                };
            }
        }
        current = current.parent;
    }
    return null;
}

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
            });
        }
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

    cascadeTypes(parent: Expression | null, valueUsed: boolean): void {
        super.cascadeTypes(parent, valueUsed);
        this.obj.cascadeTypes(this, valueUsed);
        if (this.obj.type === null) {
            throw this.error("unable to resolve type of object");
        }

        if (this.obj.type instanceof EnumType) {
            // Resolve enum definition from scope (since we no longer rely on global registry)
            const enumScope = this.obj.getScope();
            let enumInfo: { name: string; variants: { name: string; type: Type | null }[] } | null =
                null;
            if (enumScope) {
                const lookup = enumScope.lookup(this.obj.type.name);
                if (lookup && lookup.attrs.class === "enum") {
                    enumInfo = { name: lookup.attrs.name, variants: lookup.attrs.variants };
                }
            }
            if (!enumInfo) {
                throw this.error(`enum ${this.obj.type.name} not found in scope`);
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

        // Build TAF search key, incorporating template types if the object has templates (e.g., Arr[Int])
        const tafPrefix = `${objTypeName}.${this.fieldName}`;
        const objTemplates = this.obj.getTemplateTypes();
        if (objTemplates && !objTemplates.empty()) {
            // For Arr[Int].empty(), also try Arr[Int].empty as search key
            const templatedPrefix = `${objTypeName}${objTemplates}.${this.fieldName}`;
            const templatedDef =
                findFunctionInScopeByPrefix(this.getScope(), templatedPrefix + "$") ??
                findFunctionInScopeByPrefix(this.getScope(), templatedPrefix);
            if (templatedDef) {
                this.type = templatedDef.getFuncType();
                this.tafTargetName = templatedDef.fullName;
                return;
            }
        }

        // Helper: try to find and monomorphize a generic TAF among sibling definitions
        const tryResolveGenericTaf = (): boolean => {
            const callTemplateTypes = this.obj.getTemplateTypes()?.types ?? [];
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

        /** Look up a struct definition from scope, falling back to global registry. */
        const findStructInScope = (
            typeName: string
        ):
            | { name: string; fields: { name: string; type: Type; mutable: boolean }[] }
            | undefined => {
            const scope = this.getScope();
            if (scope) {
                const lookup = scope.lookup(typeName);
                if (lookup && lookup.attrs.class === "struct") {
                    return { name: lookup.attrs.name, fields: lookup.attrs.fields };
                }
            }
            return undefined;
        };

        /** Look up a trait's required functions from scope, falling back to global registry. */
        const findTraitFuncs = (
            traitName: string
        ): { name: string; paramNames: string[]; types: TemplateTypes }[] | undefined => {
            const scope = this.getScope();
            if (scope) {
                const lookup = scope.lookup(traitName);
                if (lookup && lookup.attrs.class === "trait") {
                    return lookup.attrs.requiredFunctions;
                }
            }
            return undefined;
        };

        // Check for type-associated function: TypeName.funcName
        if (!findStructInScope(objTypeName)) {
            // This CustomType is not a struct — check for a type-associated function
            let fnDef = findFunctionInScopeByPrefix(this.getScope(), tafPrefix);
            if (!fnDef) fnDef = findFunctionInScopeByPrefix(this.getScope(), tafPrefix + "$");
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
                    const traitFuncs = findTraitFuncs(traitName);
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

        const structInfo = findStructInScope(objTypeName);
        if (!structInfo) {
            throw this.error(`type ${objTypeName} is not a struct`);
        }
        // Check for type-associated function on struct before checking fields
        const tafDef =
            findFunctionInScopeByPrefix(this.getScope(), tafPrefix + "$") ??
            findFunctionInScopeByPrefix(this.getScope(), tafPrefix);
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
            const enumType = this.obj.type as EnumType;
            const vIdx = enumType.variantIndex(this.fieldName);
            if (vIdx === -1) return; // shouldn't happen

            // Plain enum (no tagged variants): emit tag index as number
            if (!enumType.isTagged) {
                writer.write(String(vIdx));
                return;
            }

            // Tagged variant: emit a factory function so DirectCall can invoke it
            if (enumType.variantType(this.fieldName) !== null) {
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
