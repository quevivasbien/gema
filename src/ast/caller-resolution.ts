import { safeJSName, type JSWriter } from "../write-js";
import { findBuiltin } from "./builtins/builtin-calls";
import type { Expression } from "./expression";
import { Literal } from "./literals";
import { RangeIter } from "./nodes";
import type { GenericMappingInfo, Scope } from "./scope";
import {
    compatibleIndicesForArrayType,
    paramTypesMatchArgTypes,
    substituteTypeParams,
} from "./type-utils";
import {
    ArrayType,
    CustomType,
    DictType,
    FuncType,
    GenericType,
    IterType,
    MaybeType,
    MutArrType,
    MutDictType,
    TupleType,
    type CallableType,
    type Type,
} from "./types";

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

/**
 * Inside a generic function body, when arg types include GenericType instances,
 * route the call through the trait dictionary instead of looking for a concrete function.
 */
function resolveTraitFunctionCall(
    scope: Scope,
    name: string,
    args: Expression[],
    argTypes: Type[]
): CallerResult | null {
    // Collect all unique { traitName, genericName } pairs from generic arg types
    const neededTraits: { traitName: string; genericName: string }[] = [];
    for (const argType of argTypes) {
        if (argType instanceof GenericType) {
            for (const traitName of argType.traits) {
                if (
                    !neededTraits.some(
                        (nt) => nt.traitName === traitName && nt.genericName === argType.name
                    )
                ) {
                    neededTraits.push({ traitName, genericName: argType.name });
                }
            }
        }
    }

    // For each needed trait, check if it defines a function matching the call name
    for (const { traitName, genericName } of neededTraits) {
        const traitDef = scope.lookupTrait(traitName);
        if (traitDef) {
            const matchingFn = traitDef.requiredFunctions.find((rf) => rf.name === name);
            if (matchingFn) {
                // Build bindings: substitute Self in the trait's param types with
                // the actual arg types at the corresponding positions.
                // TODO: Doesn't yet work with associated types
                const bindings = new Map<string, Type>();
                for (let i = 0; i < matchingFn.types.types.length && i < argTypes.length; i++) {
                    if (matchingFn.types.types[i] === "Self") {
                        bindings.set("Self", argTypes[i]);
                    }
                }
                const substitutedParamTypes = matchingFn.types.types.map((t) =>
                    substituteTypeParams(t, bindings)
                );
                const substitutedReturnType = matchingFn.types.returnType
                    ? substituteTypeParams(matchingFn.types.returnType, bindings)
                    : "Unknown";
                return {
                    kind: "function",
                    callerType: new FuncType(substitutedParamTypes, substitutedReturnType),
                    toJS(writer) {
                        writer.write(`$$impl${traitName}_${genericName}.${name}(`);
                        args.forEach((arg, i) => {
                            if (i > 0) {
                                writer.write(", ");
                            }
                            arg.toJS(writer);
                        });
                        writer.write(")");
                    },
                };
            }
        }
    }

    return null;
}

function writeTraitImplDictionaries(writer: JSWriter, genericMapping: GenericMappingInfo[]) {
    for (const genericInfo of genericMapping) {
        for (const trait of Object.keys(genericInfo.traitImpls)) {
            const traitImpl = genericInfo.traitImpls[trait];
            writer.write(", {");
            let first = true;
            for (const fnName of Object.keys(traitImpl)) {
                if (!first) writer.write(", ");
                first = false;
                writer.write(`${fnName}: ${safeJSName(traitImpl[fnName])}`);
            }
            writer.write("}");
        }
    }
}

export function findCaller(
    callExpr: Expression,
    name: string,
    args: Expression[],
    associatedType: Type | null = null
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

    // If any arg type is a GenericType (i.e., we're inside a generic function body),
    // skip normal concrete function lookup and route through trait dictionaries instead.
    const hasGenericArg = argTypes.some((t) => t instanceof GenericType);
    if (hasGenericArg) {
        const traitResult = resolveTraitFunctionCall(scope, name, args, argTypes);
        if (traitResult) {
            return { error: null, result: traitResult };
        }
    }

    // See if we can find a function definition with a compatible type signature
    // TODO: Cannot yet match TAFs!
    const funcMatch = scope.lookupFunction(name, argTypes, associatedType);
    if (funcMatch) {
        if (funcMatch.class === "func") {
            // Concrete function definition
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
        } else {
            // Generic function definition
            // TODO: Determine the concrete return type by substituting generic type params
            // with the actual argument types — for now, use the generic return type as-is
            console.log("Matched with", funcMatch);
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
                        // Pass trait implementation dictionaries
                        writeTraitImplDictionaries(writer, funcMatch.genericMapping);
                        writer.write(")");
                    },
                },
            };
        }
    }
    // If we didn't find an exact function match, try again allowing implicit Arr -> Iter conversion
    const looseFuncMatch = scope.lookupFunction(name, argTypes, associatedType, true);
    if (looseFuncMatch !== null) {
        if (looseFuncMatch.class === "func") {
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
    }
    // Check for generic loose match
    if (looseFuncMatch && looseFuncMatch.class === "generic") {
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
                    writeTraitImplDictionaries(writer, looseFuncMatch.genericMapping);
                    writer.write(")");
                },
            },
        };
    }

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
