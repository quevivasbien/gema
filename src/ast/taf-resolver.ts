import { DropValue, type Expression } from "./expression";
import { deepEquals } from "./type-utils";
import { CustomType, type FuncType, type Type } from "./types";

/**
 * Search the enclosing block for a generic TAF matching the given type name and field name.
 * If found, monomorphize it and return the function type + fullName.
 * Uses duck-typing to avoid circular imports with nodes.ts.
 */
export function resolveGenericTaf(
    parent: Expression | null,
    objTypeName: string,
    fieldName: string,
    callTemplateTypes: Type[]
): { funcType: FuncType; fullName: string } | null {
    let node: Expression | null = parent;
    while (node) {
        // Duck-type check for Block: expressions is an array
        const expressions = (node as unknown as Record<string, unknown>).expressions;
        if (Array.isArray(expressions)) {
            for (const rawExpr of expressions) {
                let e = rawExpr;
                while (e instanceof DropValue) e = e.child;
                const eRecord = e as Record<string, unknown>;

                // Duck-type check for FunctionDef: has isGeneric, typeAssociatedName, tafMonomorphize
                if (
                    typeof eRecord.isGeneric !== "boolean" ||
                    !eRecord.isGeneric ||
                    typeof eRecord.typeAssociatedName !== "string" ||
                    typeof eRecord.name !== "string" ||
                    typeof eRecord.tafMonomorphize !== "function" ||
                    !Array.isArray(eRecord.typeParams) ||
                    typeof eRecord.typeAssociatedTemplates !== "object"
                )
                    continue;

                const fnName = eRecord.name as string;
                const fnTypeAssociatedName = eRecord.typeAssociatedName as string;
                const fnTypeParams = eRecord.typeParams as string[];
                const fnTemplates = eRecord.typeAssociatedTemplates as { types?: Type[] };
                const fnTafMonomorphize = eRecord.tafMonomorphize as (
                    typeParams: string[],
                    bindings: Map<string, Type>
                ) => { fullName: string; funcType: FuncType; returnType: Type } | null;

                if (fnName !== fieldName) continue;

                // Determine base name from typeAssociatedName (strip templates)
                const defBaseName = fnTypeAssociatedName.includes("[")
                    ? fnTypeAssociatedName.slice(0, fnTypeAssociatedName.indexOf("["))
                    : fnTypeAssociatedName;

                const isTypeParamCase = fnTypeParams.includes(defBaseName);
                const typeMatches = defBaseName === objTypeName;

                if (!typeMatches && !isTypeParamCase) continue;

                // Create bindings from template matching
                const bindings = new Map<string, Type>();
                const defTemplateTypes = fnTemplates?.types ?? [];
                let match = true;

                for (
                    let ti = 0;
                    ti < Math.min(callTemplateTypes.length, defTemplateTypes.length);
                    ti++
                ) {
                    const defT = defTemplateTypes[ti];
                    const callT = callTemplateTypes[ti];
                    const defTypeName =
                        defT instanceof CustomType
                            ? defT.name
                            : typeof defT === "string"
                              ? defT
                              : null;
                    if (defTypeName && fnTypeParams.includes(defTypeName)) {
                        bindings.set(defTypeName, callT);
                    } else if (!deepEquals(defT, callT)) {
                        match = false;
                        break;
                    }
                }

                if (callTemplateTypes.length !== defTemplateTypes.length) match = false;

                // For type-param case (e.g., T.emptyArray), bind T to the concrete type
                if (isTypeParamCase) {
                    bindings.set(defBaseName, new CustomType(objTypeName));
                }

                if (!match || bindings.size === 0) continue;

                const result = fnTafMonomorphize.call(e, fnTypeParams, bindings);
                if (result) {
                    return { funcType: result.funcType, fullName: result.fullName };
                }
            }
        }
        // Walk up: duck-type check for parent property
        node = (node as unknown as Record<string, unknown>).parent as Expression | null;
    }
    return null;
}
