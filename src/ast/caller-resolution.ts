import type { Expression } from "./expression";
import { FunctionDef } from "./function-defs";
import { RangeIter } from "./nodes";
import type { StructDef } from "./structs";
import type { Scope } from "./scope";
import {
    collectTraitsForTypeParam,
    compatibleIndicesForArrayType,
    paramTypesMatchArgTypes,
} from "./type-utils";
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
import { safeJSName, type JSWriter } from "../write-js";
import { findBuiltin } from "./builtins/builtin-calls";
import { Literal } from "./literals";

// ── Discriminated union for findCaller results ──
// TODO: Probably do not need to include the callerType in each of these -- can just save the return type

type VariableResult = {
    kind: "variable";
    callerType: CallableType;
    returnType: Type;
    toJS: (writer: JSWriter) => void;
};

type FuncDefResult = {
    kind: "function";
    callerType: FuncType;
    toJS: (writer: JSWriter) => void;
};

type StructDefResult = {
    kind: "struct-constructor";
    callerType: FuncType;
    toJS: (writer: JSWriter) => void;
};

type BuiltinResult = {
    kind: "builtin";
    callerType: FuncType;
    toJS: (writer: JSWriter) => void;
};

export type CallerResult = VariableResult | FuncDefResult | StructDefResult | BuiltinResult;

// ── Main caller resolution ──

export function deprecated_findCaller(
    root: Expression,
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
                            returnType: varType.returnType,
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
                                returnType: varType,
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
                            returnType: new MaybeType(varType.innerType),
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
                            returnType: new MaybeType(varType.innerType),
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
                            returnType: varType.types.length > 0 ? varType.types[0] : "Null",
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
                            returnType: new MaybeType(varType.valueType),
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
    let traitFn: Expression | null = root.parent;
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

/**
 * Check whether a variable or expression is being called with compatible argument types
 * and return the toJS callback that should be used to compile the call.
 */
export function resolveDirectCaller(
    caller: string | Expression,
    args: Expression[],
    callerType: Type,
    argTypes: Type[],
    isUnsafe: boolean = false
):
    | {
          error: null;
          result: VariableResult;
      }
    | { error: string; result: null } {
    const isVarCall = typeof caller === "string";
    const name = isVarCall ? caller : "<anon>";

    // Helper to either write the literal caller name or compile the caller expression (in the case of a direct call to a non-variable expression)
    let writeCaller = isVarCall
        ? (writer: JSWriter) => {
              writer.write(writer.safeName(name));
          }
        : (writer: JSWriter) => {
              writer.write("(");
              caller.toJS(writer);
              writer.write(")");
          };

    // Check each of the callable types and handle them as appropriate
    if (callerType instanceof FuncType) {
        if (!paramTypesMatchArgTypes(callerType.paramTypes, argTypes)) {
            return {
                error: "incompatible type signature for this function call",
                result: null,
            };
        }
        return {
            error: null,
            result: {
                kind: "variable",
                callerType: callerType,
                returnType: callerType.returnType,
                toJS(writer) {
                    writeCaller(writer);
                    writer.write("(");
                    args.forEach((arg, i) => {
                        if (i > 0) {
                            writer.write(", ");
                        }
                        // Auto-convert Arg to Iter when the function expects Iter but gets Arg
                        if (
                            callerType.paramTypes[i] instanceof IterType &&
                            arg.type instanceof ArrayType
                        ) {
                            writer.useBuiltin("$ArrayIterator$");
                            writer.write("new $ArrayIterator$(");
                            arg.toJS(writer);
                            writer.write(")");
                        } else {
                            arg.toJS(writer);
                        }
                    });
                    writer.write(")");
                },
            },
        };
    }
    if (
        callerType instanceof ArrayType ||
        callerType instanceof MutArrType ||
        callerType === "Str"
    ) {
        // Handle special case of slicing with RangeIter
        if (
            argTypes.length === 1 &&
            argTypes[0] instanceof IterType &&
            args[0] instanceof RangeIter
        ) {
            const range = args[0];
            const rangeType = argTypes[0].innerType;
            return {
                error: null,
                result: {
                    kind: "variable",
                    callerType: callerType,
                    returnType: callerType,
                    toJS(writer) {
                        writeCaller(writer);
                        writer.write(".slice(");
                        if (rangeType === "Int") {
                            writer.write("Number(");
                            range.start.toJS(writer);
                            writer.write(")");
                        } else {
                            range.start.toJS(writer);
                        }
                        if (range.end !== null) {
                            writer.write(", ");
                            if (rangeType === "Int") {
                                writer.write("Number(");
                                range.end.toJS(writer);
                                writer.write(") + 1");
                            } else {
                                range.end.toJS(writer);
                                writer.write(" + 1");
                            }
                        }
                        writer.write(")");
                    },
                },
            };
        }
        // Case of indexing with a single integer index
        const incompatible = compatibleIndicesForArrayType(argTypes);
        if (incompatible !== null) {
            return { error: incompatible, result: null };
        }
        const innerType = callerType === "Str" ? "Str" : callerType.innerType;
        return {
            error: null,
            result: {
                kind: "variable",
                callerType: callerType,
                returnType: isUnsafe ? innerType : new MaybeType(innerType),
                toJS(writer) {
                    writer.write("(");
                    writeCaller(writer);
                    writer.write("[");
                    args[0].toJS(writer);
                    writer.write("] ?? null)");
                },
            },
        };
    }
    // Case of indexed access of iterator with single integer index
    if (callerType instanceof IterType) {
        const incompatible = compatibleIndicesForArrayType(argTypes);
        if (incompatible !== null) {
            return { error: incompatible, result: null };
        }
        const index = args[0];
        return {
            error: null,
            result: {
                kind: "variable",
                callerType: callerType,
                returnType: isUnsafe ? callerType.innerType : new MaybeType(callerType.innerType),
                toJS(writer) {
                    writer.useBuiltin("$iterGet$");
                    writer.write("$iterGet$(");
                    if (index.type === "Num") {
                        index.toJS(writer);
                        writer.write(", ");
                    } else if (index.type === "Int") {
                        writer.write("Number(");
                        index.toJS(writer);
                        writer.write("), ");
                    }
                    writeCaller(writer);
                    writer.write(")");
                },
            },
        };
    }
    // Access to element of a tuple
    if (callerType instanceof TupleType) {
        // Only integer literals are allowed for tuple indexed access
        const incompatible = compatibleIndicesForArrayType(argTypes);
        if (incompatible !== null) {
            return { error: incompatible, result: null };
        }
        // Also need to check that the indices used are a literal that is in bounds
        let validIndex = true;
        if (!(args[0] instanceof Literal)) {
            validIndex = false;
        } else {
            const literalValue = parseInt(args[0].value.trim());
            if (literalValue < 0 || literalValue >= callerType.length) {
                validIndex = false;
            }
        }
        if (!validIndex) {
            return {
                error: "Tuple indices must be integer literals that are in bounds for the tuple type",
                result: null,
            };
        }
        return {
            error: null,
            result: {
                kind: "variable",
                callerType: callerType,
                returnType: callerType.types[0],
                toJS(writer) {
                    writeCaller(writer);
                    writer.write("[");
                    args[0].toJS(writer);
                    writer.write("]");
                },
            },
        };
    }
    // Access to entry of a Dict
    if (callerType instanceof DictType || callerType instanceof MutDictType) {
        const incompatible = callerType.checkIndicesCompatible(argTypes);
        if (incompatible !== null) {
            return { error: incompatible, result: null };
        }
        return {
            error: null,
            result: {
                kind: "variable",
                callerType: callerType,
                returnType: isUnsafe ? callerType.valueType : new MaybeType(callerType.valueType),
                toJS(writer) {
                    writer.write("(");
                    writeCaller(writer);
                    writer.write(".get(");
                    args[0].toJS(writer);
                    writer.write(") ?? null)");
                },
            },
        };
    }
    return {
        error: `variable ${name} is of type ${callerType}, which is not a callable object.`,
        result: null,
    };
}

export function findCaller(
    callExpr: Expression,
    name: string,
    args: Expression[]
):
    | {
          error: null;
          result: CallerResult;
      }
    | { error: string; result: null } {
    const scope = callExpr.getScope();
    if (scope === null) {
        return {
            error: `missing scope when trying to resolve caller ${name}`,
            result: null,
        };
    }
    const argTypes: Type[] = [];
    for (const arg of args) {
        if (arg.type === null) {
            return {
                error: "arg types not resolved before attempting to resolve caller",
                result: null,
            };
        }
        argTypes.push(arg.type);
    }

    // See if the first match for `name` is a variable
    const varMatch = scope.lookupVariable(name);
    if (varMatch) {
        return resolveDirectCaller(name, args, varMatch.type, argTypes);
    }

    // See if we can find a function definition with a compatible type signature
    // TODO: This doesn't yet work with generic functions!
    const funcMatch = scope.lookupFunction(name, argTypes);
    if (funcMatch) {
        return {
            error: null,
            result: {
                kind: "function",
                callerType: funcMatch.type,
                toJS(writer) {
                    writer.write(safeJSName(funcMatch.fullName));
                    writer.write("(");
                    args.forEach((arg, i) => {
                        if (i > 0) {
                            writer.write(", ");
                        }
                        arg.toJS(writer);
                    });
                    writer.write(")");
                },
            },
        };
    }
    // If we didn't find an exact function match, try again allowing implicit Arr -> Iter conversion
    const looseFuncMatch = scope.lookupFunction(name, argTypes, true);
    if (looseFuncMatch !== null) {
        return {
            error: null,
            result: {
                kind: "function",
                callerType: looseFuncMatch.type,
                toJS(writer) {
                    writer.write(safeJSName(looseFuncMatch.fullName));
                    writer.write("(");
                    args.forEach((arg, i) => {
                        if (i > 0) {
                            writer.write(", ");
                        }
                        // Auto-convert Arg to Iter when the function expects Iter but gets Arg
                        if (
                            looseFuncMatch.type.paramTypes[i] instanceof IterType &&
                            arg.type instanceof ArrayType
                        ) {
                            writer.useBuiltin("$ArrayIterator$");
                            writer.write("new $ArrayIterator$(");
                            arg.toJS(writer);
                            writer.write(")");
                        } else {
                            arg.toJS(writer);
                        }
                    });
                    writer.write(")");
                },
            },
        };
    }

    // TODO: Check for matches dependent on whether arg types satisfy traits

    // Check for struct constructor definitions
    // TODO: This doesn't yet work with generic structs!
    const structMatch = scope.lookupStruct(name, argTypes);
    if (structMatch) {
        return {
            error: null,
            result: {
                kind: "struct-constructor",
                callerType: new FuncType(
                    structMatch.fields.map((f) => f.type),
                    new CustomType(name)
                ),
                toJS(writer) {
                    const safeNames = structMatch.fields.map((f) => writer.safeName(f.name));
                    writer.write("{");
                    args.forEach((arg, i) => {
                        if (i > 0) {
                            writer.write(", ");
                        }
                        writer.write(`${safeNames[i]}: `);
                        arg.toJS(writer);
                    });
                    writer.write("}");
                },
            },
        };
    }

    // Check for builtin functions
    const builtinResult = findBuiltin(name, args, argTypes);
    if (builtinResult) {
        return { error: null, result: builtinResult };
    }

    return {
        error: `function ${name}[${argTypes.map((t) => t.toString()).join(", ")}: unknown] not found`,
        result: null,
    };
}
