import type { Expression } from "./expression";
import { FunctionDef } from "./nodes";
import type { StructDef } from "./structs";
import type { Scope } from "./scope";
import { collectTraitsForTypeParam, paramTypesMatchArgTypes } from "./type-utils";
import {
    ArrayType,
    CustomType,
    DictType,
    FuncType,
    IterType,
    MaybeType,
    MutArrType,
    MutDictType,
    type TemplateTypes,
    TupleType,
    type CallableType,
    type Type,
} from "./types";
import type { JSWriter } from "../write-js";
import { findBuiltin } from "./builtins/builtin-calls";

// ── Discriminated union for findCaller results ──

export type CallerResult =
    | {
          kind: "function";
          referToByName: string;
          callerType: FuncType;
          paramNames?: string[];
      }
    | {
          kind: "struct-constructor";
          referToByName: string;
          callerType: FuncType;
      }
    | {
          kind: "type-conversion";
          referToByName: string;
          callerType: FuncType;
          jsExpr: (arg: string) => string;
      }
    | {
          kind: "builtin";
          referToByName: string;
          callerType: FuncType;
          toJS: (writer: JSWriter, args: Expression[]) => void;
      }
    | {
          kind: "variable";
          referToByName: string;
          callerType: CallableType;
          rootType: Type;
      };

// ── Main caller resolution ──

export function findCaller(
    root: Expression,
    parent: Expression | null,
    name: string,
    argTypes: Type[]
):
    | {
          error: null;
          result: CallerResult;
      }
    | { error: string; result: null } {
    // Scope-based lookup — the single source of truth for name resolution.
    // Scope entries are populated by FunctionDef.cascadeTypes (for functions),
    // Assignment.cascadeTypes (for variables), and UseModule.cascadeTypes (for imports).
    const fnCallScope = root.getScope();
    if (fnCallScope) {
        // First, specifically look for function entries (they can coexist with
        // struct/trait/enum entries for the same name, e.g., struct constructor
        // overloading).
        let scopeResult = fnCallScope.lookup(name);
        // If the first match isn't a function, search the scope chain for a func entry
        if (scopeResult && scopeResult.attrs.class !== "func") {
            let searchScope: Scope | null = fnCallScope;
            while (searchScope) {
                for (const v of searchScope.variables) {
                    if (v.class === "func" && v.name === name) {
                        scopeResult = { inCurrentScope: searchScope === fnCallScope, attrs: v };
                        break;
                    }
                }
                if (scopeResult && scopeResult.attrs.class === "func") break;
                searchScope = searchScope.parent;
            }
        }

        if (scopeResult) {
            // For function resolution, search ALL scope entries with matching name
            // (to handle overloads — multiple functions with same name, different types).
            // Iterate the entire scope chain to find all matching entries.
            const matchedFunc = (() => {
                // Pass 1: strict match — require exact param type match without Arr→Iter conversion.
                // This ensures that when both `foo(iter: Arr[Int])` and `foo(iter: Iter[Int])` exist,
                // the Arr overload is preferred for array arguments.
                let searchScope: Scope | null = fnCallScope;
                while (searchScope) {
                    for (const v of searchScope.variables) {
                        if (v.class !== "func" || v.name !== name) continue;
                        if (!v.isGeneric) {
                            if (
                                v.type instanceof FuncType &&
                                paramTypesMatchArgTypes(v.type.paramTypes, argTypes, false)
                            ) {
                                return {
                                    kind: "function" as const,
                                    referToByName: v.fullName,
                                    callerType: v.type,
                                    rootType: v.type.returnType,
                                    paramNames: v.paramNames,
                                };
                            }
                        } else if (v.def) {
                            const genericFn = v.def as FunctionDef;
                            if (genericFn.params.length === argTypes.length) {
                                const result = genericFn.monomorphize(argTypes, root.parent);
                                if (result !== null) {
                                    return {
                                        kind: "function" as const,
                                        referToByName: result.fullName,
                                        callerType: result.funcType,
                                        rootType: result.returnType,
                                        paramNames: v.paramNames,
                                    };
                                }
                            }
                        }
                    }
                    searchScope = searchScope.parent;
                }

                if (!argTypes.some((e) => e instanceof ArrayType)) {
                    return null;
                }

                // Pass 2: loose match — allow Arr→Iter conversion. Only reached if
                // no strict match was found in pass 1 and one of the argTypes is an array type
                searchScope = fnCallScope;
                while (searchScope) {
                    for (const v of searchScope.variables) {
                        if (v.class !== "func" || v.name !== name) continue;
                        if (!v.isGeneric) {
                            if (
                                v.type instanceof FuncType &&
                                paramTypesMatchArgTypes(v.type.paramTypes, argTypes, true)
                            ) {
                                return {
                                    kind: "function" as const,
                                    referToByName: v.fullName,
                                    callerType: v.type,
                                    rootType: v.type.returnType,
                                    paramNames: v.paramNames,
                                };
                            }
                        } else if (v.def) {
                            const genericFn = v.def as FunctionDef;
                            if (genericFn.params.length === argTypes.length) {
                                const result = genericFn.monomorphize(argTypes, root.parent);
                                if (result !== null) {
                                    return {
                                        kind: "function" as const,
                                        referToByName: result.fullName,
                                        callerType: result.funcType,
                                        rootType: result.returnType,
                                        paramNames: v.paramNames,
                                    };
                                }
                            }
                        }
                    }
                    searchScope = searchScope.parent;
                }
                return null;
            })();
            if (matchedFunc) {
                return { error: null, result: matchedFunc };
            }

            // Fall back to the first scope result for non-func entries
            const fa = scopeResult.attrs;

            // Variable-based callable (e.g., FuncType variable, array indexing, etc.)
            if (fa.class === "var") {
                const varType = fa.type;
                if (fa.isConsumed) {
                    return {
                        error: `cannot use variable '${name}' after it was consumed`,
                        result: null,
                    };
                }
                if (varType instanceof FuncType) {
                    if (!paramTypesMatchArgTypes(varType.paramTypes, argTypes)) {
                        return {
                            error: `variable ${name} has an incompatible type signature for this function call.`,
                            result: null,
                        };
                    }
                    return {
                        error: null,
                        result: {
                            kind: "variable",
                            referToByName: name,
                            callerType: varType,
                            rootType: varType.returnType,
                        },
                    };
                }
                if (varType instanceof ArrayType || varType instanceof MutArrType) {
                    if (argTypes.length === 1 && argTypes[0] instanceof IterType) {
                        return {
                            error: null,
                            result: {
                                kind: "variable",
                                referToByName: name,
                                callerType: varType,
                                rootType: varType,
                            },
                        };
                    }
                    const incompatible = varType.checkIndicesCompatible(argTypes);
                    if (incompatible !== null) {
                        return { error: incompatible, result: null };
                    }
                    return {
                        error: null,
                        result: {
                            kind: "variable",
                            referToByName: name,
                            callerType: varType,
                            rootType: new MaybeType(varType.innerType),
                        },
                    };
                }
                if (varType instanceof IterType) {
                    const incompatible = varType.checkIndicesCompatible(argTypes);
                    if (incompatible !== null) {
                        return { error: incompatible, result: null };
                    }
                    return {
                        error: null,
                        result: {
                            kind: "variable",
                            referToByName: name,
                            callerType: varType,
                            rootType: new MaybeType(varType.innerType),
                        },
                    };
                }
                if (varType instanceof TupleType) {
                    const incompatible = varType.checkIndicesCompatible(argTypes);
                    if (incompatible !== null) {
                        return { error: incompatible, result: null };
                    }
                    return {
                        error: null,
                        result: {
                            kind: "variable",
                            referToByName: name,
                            callerType: varType,
                            rootType: varType.types.length > 0 ? varType.types[0] : "Null",
                        },
                    };
                }
                if (varType instanceof DictType || varType instanceof MutDictType) {
                    const incompatible = varType.checkIndicesCompatible(argTypes);
                    if (incompatible !== null) {
                        return { error: incompatible, result: null };
                    }
                    return {
                        error: null,
                        result: {
                            kind: "variable",
                            referToByName: name,
                            callerType: varType,
                            rootType: new MaybeType(varType.valueType),
                        },
                    };
                }
                if (varType instanceof CustomType) {
                    // Check if this is a struct type (fall through to struct constructor)
                    const structCheck = fnCallScope?.lookup(varType.name);
                    if (structCheck && structCheck.attrs.class === "struct") {
                        // fall through
                    } else {
                        return {
                            error: `variable ${name} is of type ${varType}, which is not a callable object.`,
                            result: null,
                        };
                    }
                } else if (varType === "Str") {
                    // fall through to string indexing
                } else {
                    return {
                        error: `variable ${name} is of type ${varType}, which is not a callable object.`,
                        result: null,
                    };
                }
            }
        }
    }

    // Check for iterator/array builtins (includes type conversions like toInt/toStr etc.)
    const builtinResult = findBuiltin(name, argTypes);
    if (builtinResult) {
        return { error: null, result: builtinResult };
    }

    // Trait dispatch — resolve trait definitions from scope
    const callScope = root.getScope();
    const traitCandidates: { traitName: string; selfType: Type }[] = [];
    for (const argType of argTypes) {
        if (argType instanceof CustomType) {
            for (const trait of argType.traits) {
                traitCandidates.push({ traitName: trait, selfType: argType });
            }
        }
    }

    /** Look up a trait's required functions from the scope chain. */
    const findTraitInfo = (
        traitName: string
    ): { name: string; paramNames: string[]; types: TemplateTypes }[] | undefined => {
        if (callScope) {
            const lookup = callScope.lookup(traitName);
            if (lookup && lookup.attrs.class === "trait") {
                return lookup.attrs.requiredFunctions;
            }
        }
        return undefined;
    };

    for (const { traitName, selfType } of traitCandidates) {
        const traitFuncs = findTraitInfo(traitName);
        if (!traitFuncs) continue;
        for (const tf of traitFuncs) {
            if (tf.name !== name) continue;
            const replacedParamTypes = tf.types.types.map((t) => {
                if (t === "Self" || (t instanceof CustomType && t.name === "Self")) return selfType;
                return t;
            });
            if (paramTypesMatchArgTypes(replacedParamTypes, argTypes)) {
                const returnType =
                    tf.types.returnType !== null
                        ? tf.types.returnType === "Self" ||
                          (tf.types.returnType instanceof CustomType &&
                              tf.types.returnType.name === "Self")
                            ? selfType
                            : tf.types.returnType
                        : "Null";
                return {
                    error: null,
                    result: {
                        kind: "function",
                        referToByName: name,
                        callerType: new FuncType(argTypes, returnType),
                        paramNames: tf.paramNames,
                    },
                };
            }
        }
    }

    // Fallback: inside a generic function body, check for trait functions
    let traitFn: Expression | null = parent;
    while (traitFn) {
        if (traitFn instanceof FunctionDef && traitFn.isGeneric) {
            for (const tp of traitFn.typeParams) {
                const traits = new Set<string>();
                for (const param of traitFn.params) {
                    for (const t of collectTraitsForTypeParam(param.type, tp)) {
                        traits.add(t);
                    }
                }
                for (const t of collectTraitsForTypeParam(traitFn.returnType, tp)) {
                    traits.add(t);
                }
                for (const traitName of traits) {
                    const traitFuncs = findTraitInfo(traitName);
                    if (!traitFuncs) continue;
                    for (const tf of traitFuncs) {
                        if (tf.name !== name) continue;
                        const selfType = new CustomType(tp);
                        const replacedParamTypes = tf.types.types.map((t) => {
                            if (t === "Self" || (t instanceof CustomType && t.name === "Self"))
                                return selfType;
                            return t;
                        });
                        if (paramTypesMatchArgTypes(replacedParamTypes, argTypes)) {
                            const returnType =
                                tf.types.returnType !== null
                                    ? tf.types.returnType === "Self" ||
                                      (tf.types.returnType instanceof CustomType &&
                                          tf.types.returnType.name === "Self")
                                        ? selfType
                                        : tf.types.returnType
                                    : "Null";
                            return {
                                error: null,
                                result: {
                                    kind: "function",
                                    referToByName: name,
                                    callerType: new FuncType(argTypes, returnType),
                                    paramNames: tf.paramNames,
                                },
                            };
                        }
                    }
                }
            }
            break;
        }
        traitFn = traitFn.parent;
    }

    // No user-defined function matched — fall back to struct constructor if one exists.
    let structEntry:
        | {
              name: string;
              fields: { name: string; type: Type; mutable: boolean }[];
              isGeneric?: true;
              def?: unknown;
          }
        | undefined;
    if (callScope) {
        const lookup = callScope.lookup(name);
        if (lookup && lookup.attrs.class === "struct") {
            structEntry = {
                name: lookup.attrs.name,
                fields: lookup.attrs.fields,
                isGeneric: (lookup.attrs as { isGeneric?: true }).isGeneric,
                def: (lookup.attrs as { def?: unknown }).def,
            };
        }
    }
    if (structEntry) {
        // If the struct is generic, monomorphize it using the constructor argument types
        let monomorphizedResult: {
            fields: { name: string; type: Type; mutable: boolean }[];
            structType: CustomType;
        } | null = null;
        if (structEntry.isGeneric && structEntry.def) {
            const structDefNode = structEntry.def as StructDef;
            monomorphizedResult = structDefNode.monomorphize(argTypes);
            if (!monomorphizedResult) {
                const genericFieldTypes = structEntry.fields.map((f) => f.type);
                return {
                    error: `struct ${name} constructor expects arguments of types [${genericFieldTypes}], got [${argTypes}]`,
                    result: null,
                };
            }
        }
        const fields = monomorphizedResult ? monomorphizedResult.fields : structEntry.fields;
        const structType = monomorphizedResult
            ? monomorphizedResult.structType
            : new CustomType(name);
        const fieldTypes = fields.map((f) => f.type);
        if (paramTypesMatchArgTypes(fieldTypes, argTypes)) {
            return {
                error: null,
                result: {
                    kind: "struct-constructor",
                    referToByName: name,
                    callerType: new FuncType(fieldTypes, structType),
                },
            };
        }
        return {
            error: `struct ${name} constructor expects arguments of types [${fieldTypes}], got [${argTypes}]`,
            result: null,
        };
    }

    return {
        error: `function ${name}[${argTypes.map((t) => t.toString()).join(", ")}: unknown] not found`,
        result: null,
    };
}
