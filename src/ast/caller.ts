import {
    FuncType,
    ArrayType,
    IterType,
    MutArrType,
    TupleType,
    MaybeType,
    DictType,
    SetType,
    MutDictType,
    MutSetType,
    CustomType,
    type Type,
    type CallableType,
} from "../types";
import { getStruct, getTrait, findFunction, isVarConsumed } from "./registries";
import { functionNameWithParamTypes } from "./caller-utils";
import { deepEquals } from "../deep-equals";
import { paramTypesMatchArgTypes, collectTraitsForTypeParam, looseMatch } from "./type-utils";
import type { Expression } from "./expression";
import { Block, Function, Assignment, AnonymousFunction } from "./nodes";
import { DropValue } from "./expression";

// ── Discriminated union for findCaller results ──

export type CallerResult =
    | {
          kind: "function";
          referToByName: string;
          callerType: FuncType;
          rootType: Type;
          paramNames?: string[];
      }
    | {
          kind: "struct-constructor";
          referToByName: string;
          callerType: FuncType;
          rootType: Type;
      }
    | {
          kind: "type-conversion";
          referToByName: string;
          callerType: FuncType;
          rootType: Type;
          jsExpr: (arg: string) => string;
      }
    | {
          kind: "builtin";
          referToByName: string;
          callerType: FuncType;
          rootType: Type;
          builtinKind: string;
      }
    | {
          kind: "variable";
          referToByName: string;
          callerType: CallableType;
          rootType: Type;
      };

// ── Type conversion builtins ──

const TYPE_CONVERSIONS: Record<
    string,
    Record<string, { returnType: Type; jsExpr: (arg: string) => string }>
> = {
    toStr: {
        Int: { returnType: "Str", jsExpr: (a) => `String(${a})` },
        Float: { returnType: "Str", jsExpr: (a) => `String(${a})` },
        Bool: { returnType: "Str", jsExpr: (a) => `String(${a})` },
    },
    toInt: {
        Float: { returnType: "Int", jsExpr: (a) => `BigInt(Math.trunc(${a}))` },
        Bool: { returnType: "Int", jsExpr: (a) => `BigInt(${a})` },
    },
    toFloat: {
        Int: { returnType: "Float", jsExpr: (a) => `Number(${a})` },
    },
    toBool: {
        Int: { returnType: "Bool", jsExpr: (a) => `Boolean(${a})` },
        Float: { returnType: "Bool", jsExpr: (a) => `Boolean(${a})` },
    },
};

function findTypeConversion(
    name: string,
    inputType: Type
): {
    error: null;
    result: {
        kind: "type-conversion";
        referToByName: string;
        callerType: FuncType;
        rootType: Type;
        jsExpr: (arg: string) => string;
    };
} | null {
    const byInput = TYPE_CONVERSIONS[name];
    if (!byInput) return null;
    let inputTypeKey: string | null = null;
    if (inputType === "Int") inputTypeKey = "Int";
    else if (inputType === "Float") inputTypeKey = "Float";
    else if (inputType === "Bool") inputTypeKey = "Bool";
    else if (inputType === "Str") inputTypeKey = "Str";
    if (!inputTypeKey) return null;
    const conversion = byInput[inputTypeKey];
    if (!conversion) return null;
    const fullName = functionNameWithParamTypes(name, [inputType]);
    return {
        error: null,
        result: {
            kind: "type-conversion",
            referToByName: fullName,
            callerType: new FuncType([inputType], conversion.returnType),
            rootType: conversion.returnType,
            jsExpr: conversion.jsExpr,
        },
    };
}

// ── Builtin function dispatch ──

function findBuiltin(
    name: string,
    argTypes: Type[]
):
    | {
          error: null;
          result: {
              kind: "builtin";
              referToByName: string;
              callerType: FuncType;
              rootType: Type;
              builtinKind: string;
          };
      }
    | undefined {
    switch (name) {
        case "collect": {
            if (argTypes.length !== 1) return undefined;
            const inner = argTypes[0];
            if (inner instanceof IterType) {
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "collect",
                        callerType: new FuncType([inner], new ArrayType(inner.innerType)),
                        rootType: new ArrayType(inner.innerType),
                        builtinKind: "collect",
                    },
                };
            }
            if (inner instanceof ArrayType || inner instanceof MutArrType) {
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "collect",
                        callerType: new FuncType([inner], inner),
                        rootType: inner,
                        builtinKind: "collect",
                    },
                };
            }
            if (inner === "Str") {
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "collect",
                        callerType: new FuncType([inner], new ArrayType("Str")),
                        rootType: new ArrayType("Str"),
                        builtinKind: "collect",
                    },
                };
            }
            return undefined;
        }
        case "map": {
            if (argTypes.length !== 2) return undefined;
            const [mapFirst, mapSecond] = argTypes;
            // map(arr, indices) — array-as-index-mapping
            if (mapFirst instanceof ArrayType || mapFirst instanceof MutArrType) {
                if (
                    !(
                        mapSecond instanceof IterType ||
                        mapSecond instanceof ArrayType ||
                        mapSecond instanceof MutArrType
                    )
                )
                    return undefined;
                const secondInner =
                    mapSecond instanceof IterType ? mapSecond.innerType : mapSecond.innerType;
                if (secondInner !== "Int") return undefined;
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "map",
                        callerType: new FuncType(
                            [mapFirst, mapSecond],
                            new IterType(mapFirst.innerType)
                        ),
                        rootType: new IterType(mapFirst.innerType),
                        builtinKind: "mapFromArray",
                    },
                };
            }
            // Str → Iter[Str] conversion
            if (
                mapFirst instanceof FuncType &&
                mapFirst.paramTypes.length === 1 &&
                mapSecond === "Str"
            ) {
                if (!looseMatch(mapFirst.paramTypes[0], "Str")) return undefined;
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "map",
                        callerType: new FuncType(
                            [mapFirst, mapSecond],
                            new IterType(mapFirst.returnType)
                        ),
                        rootType: new IterType(mapFirst.returnType),
                        builtinKind: "map",
                    },
                };
            }
            if (!(mapFirst instanceof FuncType) || mapFirst.paramTypes.length !== 1)
                return undefined;
            if (
                !(
                    mapSecond instanceof IterType ||
                    mapSecond instanceof ArrayType ||
                    mapSecond instanceof MutArrType
                )
            )
                return undefined;
            const mapIterInner =
                mapSecond instanceof IterType ? mapSecond.innerType : mapSecond.innerType;
            if (!looseMatch(mapFirst.paramTypes[0], mapIterInner)) return undefined;
            const mapOutputType = mapFirst.returnType;
            return {
                error: null,
                result: {
                    kind: "builtin",
                    referToByName: "map",
                    callerType: new FuncType([mapFirst, mapSecond], new IterType(mapOutputType)),
                    rootType: new IterType(mapOutputType),
                    builtinKind: "map",
                },
            };
        }
        case "filter": {
            if (argTypes.length !== 2) return undefined;
            const [fFnType, fIterType] = argTypes;
            if (!(fFnType instanceof FuncType) || fFnType.paramTypes.length !== 1) return undefined;
            if (fIterType === "Str") {
                if (!looseMatch(fFnType.paramTypes[0], "Str")) return undefined;
                if (fFnType.returnType !== "Bool") return undefined;
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "filter",
                        callerType: new FuncType([fFnType, fIterType], new IterType("Str")),
                        rootType: new IterType("Str"),
                        builtinKind: "filter",
                    },
                };
            }
            if (
                !(
                    fIterType instanceof IterType ||
                    fIterType instanceof ArrayType ||
                    fIterType instanceof MutArrType
                )
            )
                return undefined;
            const fIterInner =
                fIterType instanceof IterType ? fIterType.innerType : fIterType.innerType;
            if (!looseMatch(fFnType.paramTypes[0], fIterInner)) return undefined;
            if (fFnType.returnType !== "Bool") return undefined;
            return {
                error: null,
                result: {
                    kind: "builtin",
                    referToByName: "filter",
                    callerType: new FuncType([fFnType, fIterType], new IterType(fIterInner)),
                    rootType: new IterType(fIterInner),
                    builtinKind: "filter",
                },
            };
        }
        case "reduce": {
            if (argTypes.length !== 3) return undefined;
            const [rFnType, rInitType, rIterType] = argTypes;
            if (!(rFnType instanceof FuncType) || rFnType.paramTypes.length !== 2) return undefined;
            if (rIterType === "Str") {
                if (!looseMatch(rFnType.paramTypes[0], rInitType)) return undefined;
                if (!looseMatch(rFnType.paramTypes[1], "Str")) return undefined;
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "reduce",
                        callerType: new FuncType([rFnType, rInitType, rIterType], rInitType),
                        rootType: rInitType,
                        builtinKind: "reduce",
                    },
                };
            }
            if (
                !(
                    rIterType instanceof IterType ||
                    rIterType instanceof ArrayType ||
                    rIterType instanceof MutArrType
                )
            )
                return undefined;
            const rIterInner =
                rIterType instanceof IterType ? rIterType.innerType : rIterType.innerType;
            if (!looseMatch(rFnType.paramTypes[0], rInitType)) return undefined;
            if (!looseMatch(rFnType.paramTypes[1], rIterInner)) return undefined;
            if (!looseMatch(rFnType.returnType, rInitType)) return undefined;
            return {
                error: null,
                result: {
                    kind: "builtin",
                    referToByName: "reduce",
                    callerType: new FuncType([rFnType, rInitType, rIterType], rInitType),
                    rootType: rInitType,
                    builtinKind: "reduce",
                },
            };
        }
        case "range": {
            if (argTypes.length !== 2 && argTypes.length !== 3) return undefined;
            if (argTypes.some((t) => t !== "Int")) return undefined;
            return {
                error: null,
                result: {
                    kind: "builtin",
                    referToByName: "range",
                    callerType: new FuncType(argTypes, new IterType("Int")),
                    rootType: new IterType("Int"),
                    builtinKind: "range",
                },
            };
        }
        case "iterate": {
            if (argTypes.length !== 2) return undefined;
            const [iFnType, iStartType] = argTypes;
            if (!(iFnType instanceof FuncType) || iFnType.paramTypes.length !== 1) return undefined;
            if (!looseMatch(iFnType.paramTypes[0], iStartType)) return undefined;
            if (!looseMatch(iFnType.returnType, iStartType)) return undefined;
            return {
                error: null,
                result: {
                    kind: "builtin",
                    referToByName: "iterate",
                    callerType: new FuncType([iFnType, iStartType], new IterType(iStartType)),
                    rootType: new IterType(iStartType),
                    builtinKind: "iterate",
                },
            };
        }
        case "step": {
            if (argTypes.length !== 2) return undefined;
            const [sIter, sStep] = argTypes;
            if (sStep !== "Int") return undefined;
            if (
                sIter instanceof IterType ||
                sIter instanceof ArrayType ||
                sIter instanceof MutArrType
            ) {
                const sInner = sIter instanceof IterType ? sIter.innerType : sIter.innerType;
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "step",
                        callerType: new FuncType([sIter, sStep], new IterType(sInner)),
                        rootType: new IterType(sInner),
                        builtinKind: "step",
                    },
                };
            }
            if (sIter === "Str") {
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "step",
                        callerType: new FuncType([sIter, sStep], new IterType("Str")),
                        rootType: new IterType("Str"),
                        builtinKind: "step",
                    },
                };
            }
            return undefined;
        }
        case "last": {
            if (argTypes.length !== 1) return undefined;
            const lInner = argTypes[0];
            if (
                lInner instanceof IterType ||
                lInner instanceof ArrayType ||
                lInner instanceof MutArrType
            ) {
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "last",
                        callerType: new FuncType([lInner], new MaybeType(lInner.innerType)),
                        rootType: new MaybeType(lInner.innerType),
                        builtinKind: "last",
                    },
                };
            }
            if (lInner === "Str") {
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "last",
                        callerType: new FuncType([lInner], new MaybeType("Str")),
                        rootType: new MaybeType("Str"),
                        builtinKind: "last",
                    },
                };
            }
            return undefined;
        }
        case "length": {
            if (argTypes.length !== 1) return undefined;
            const lenInner = argTypes[0];
            if (
                lenInner instanceof IterType ||
                lenInner instanceof ArrayType ||
                lenInner instanceof MutArrType
            ) {
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "length",
                        callerType: new FuncType([lenInner], "Int"),
                        rootType: "Int",
                        builtinKind: "length",
                    },
                };
            }
            if (lenInner === "Str") {
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "length",
                        callerType: new FuncType([lenInner], "Int"),
                        rootType: "Int",
                        builtinKind: "length",
                    },
                };
            }
            return undefined;
        }
        case "take": {
            if (argTypes.length !== 2) return undefined;
            if (argTypes[0] !== "Int") return undefined;
            const tInner = argTypes[1];
            if (tInner instanceof IterType) {
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "take",
                        callerType: new FuncType(
                            [argTypes[0], tInner],
                            new IterType(tInner.innerType)
                        ),
                        rootType: new IterType(tInner.innerType),
                        builtinKind: "take",
                    },
                };
            }
            if (tInner instanceof ArrayType || tInner instanceof MutArrType) {
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "take",
                        callerType: new FuncType(
                            [argTypes[0], tInner],
                            new IterType(tInner.innerType)
                        ),
                        rootType: new IterType(tInner.innerType),
                        builtinKind: "take",
                    },
                };
            }
            if (tInner === "Str") {
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "take",
                        callerType: new FuncType([argTypes[0], tInner], new IterType("Str")),
                        rootType: new IterType("Str"),
                        builtinKind: "take",
                    },
                };
            }
            return undefined;
        }
        case "drop": {
            if (argTypes.length !== 2) return undefined;
            if (argTypes[0] !== "Int") return undefined;
            const dInner = argTypes[1];
            if (dInner instanceof IterType) {
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "drop",
                        callerType: new FuncType(
                            [argTypes[0], dInner],
                            new IterType(dInner.innerType)
                        ),
                        rootType: new IterType(dInner.innerType),
                        builtinKind: "drop",
                    },
                };
            }
            if (dInner instanceof ArrayType || dInner instanceof MutArrType) {
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "drop",
                        callerType: new FuncType(
                            [argTypes[0], dInner],
                            new IterType(dInner.innerType)
                        ),
                        rootType: new IterType(dInner.innerType),
                        builtinKind: "drop",
                    },
                };
            }
            if (dInner === "Str") {
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "drop",
                        callerType: new FuncType([argTypes[0], dInner], new IterType("Str")),
                        rootType: new IterType("Str"),
                        builtinKind: "drop",
                    },
                };
            }
            return undefined;
        }
        case "takeWhile": {
            if (argTypes.length !== 2) return undefined;
            const [twFnType, twIterType] = argTypes;
            if (!(twFnType instanceof FuncType) || twFnType.paramTypes.length !== 1)
                return undefined;
            if (twFnType.returnType !== "Bool") return undefined;
            if (twIterType instanceof IterType) {
                if (!looseMatch(twFnType.paramTypes[0], twIterType.innerType)) return undefined;
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "takeWhile",
                        callerType: new FuncType(
                            [twFnType, twIterType],
                            new IterType(twIterType.innerType)
                        ),
                        rootType: new IterType(twIterType.innerType),
                        builtinKind: "takeWhile",
                    },
                };
            }
            if (twIterType instanceof ArrayType || twIterType instanceof MutArrType) {
                if (!looseMatch(twFnType.paramTypes[0], twIterType.innerType)) return undefined;
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "takeWhile",
                        callerType: new FuncType(
                            [twFnType, twIterType],
                            new IterType(twIterType.innerType)
                        ),
                        rootType: new IterType(twIterType.innerType),
                        builtinKind: "takeWhile",
                    },
                };
            }
            if (twIterType === "Str") {
                if (!looseMatch(twFnType.paramTypes[0], "Str")) return undefined;
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "takeWhile",
                        callerType: new FuncType([twFnType, twIterType], new IterType("Str")),
                        rootType: new IterType("Str"),
                        builtinKind: "takeWhile",
                    },
                };
            }
            return undefined;
        }
        case "dropWhile": {
            if (argTypes.length !== 2) return undefined;
            const [dwFnType, dwIterType] = argTypes;
            if (!(dwFnType instanceof FuncType) || dwFnType.paramTypes.length !== 1)
                return undefined;
            if (dwFnType.returnType !== "Bool") return undefined;
            if (dwIterType instanceof IterType) {
                if (!looseMatch(dwFnType.paramTypes[0], dwIterType.innerType)) return undefined;
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "dropWhile",
                        callerType: new FuncType(
                            [dwFnType, dwIterType],
                            new IterType(dwIterType.innerType)
                        ),
                        rootType: new IterType(dwIterType.innerType),
                        builtinKind: "dropWhile",
                    },
                };
            }
            if (dwIterType instanceof ArrayType || dwIterType instanceof MutArrType) {
                if (!looseMatch(dwFnType.paramTypes[0], dwIterType.innerType)) return undefined;
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "dropWhile",
                        callerType: new FuncType(
                            [dwFnType, dwIterType],
                            new IterType(dwIterType.innerType)
                        ),
                        rootType: new IterType(dwIterType.innerType),
                        builtinKind: "dropWhile",
                    },
                };
            }
            if (dwIterType === "Str") {
                if (!looseMatch(dwFnType.paramTypes[0], "Str")) return undefined;
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "dropWhile",
                        callerType: new FuncType([dwFnType, dwIterType], new IterType("Str")),
                        rootType: new IterType("Str"),
                        builtinKind: "dropWhile",
                    },
                };
            }
            return undefined;
        }
        case "trans": {
            if (argTypes.length !== 1) return undefined;
            if (argTypes[0] instanceof ArrayType) {
                const mutResult = new MutArrType(argTypes[0].innerType);
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "trans",
                        callerType: new FuncType(argTypes, mutResult),
                        rootType: mutResult,
                        builtinKind: "trans",
                    },
                };
            }
            if (argTypes[0] instanceof DictType) {
                const mutResult = new MutDictType(argTypes[0].keyType, argTypes[0].valueType);
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "trans",
                        callerType: new FuncType(argTypes, mutResult),
                        rootType: mutResult,
                        builtinKind: "transDict",
                    },
                };
            }
            if (argTypes[0] instanceof SetType) {
                const mutResult = new MutSetType(argTypes[0].innerType);
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "trans",
                        callerType: new FuncType(argTypes, mutResult),
                        rootType: mutResult,
                        builtinKind: "transSet",
                    },
                };
            }
            return undefined;
        }
        case "unsafeTrans": {
            if (argTypes.length !== 1) return undefined;
            if (argTypes[0] instanceof ArrayType) {
                const unsafeResult = new MutArrType(argTypes[0].innerType);
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "unsafeTrans",
                        callerType: new FuncType(argTypes, unsafeResult),
                        rootType: unsafeResult,
                        builtinKind: "unsafeTrans",
                    },
                };
            }
            if (argTypes[0] instanceof DictType) {
                const unsafeResult = new MutDictType(argTypes[0].keyType, argTypes[0].valueType);
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "unsafeTrans",
                        callerType: new FuncType(argTypes, unsafeResult),
                        rootType: unsafeResult,
                        builtinKind: "unsafeTransDict",
                    },
                };
            }
            if (argTypes[0] instanceof SetType) {
                const unsafeResult = new MutSetType(argTypes[0].innerType);
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "unsafeTrans",
                        callerType: new FuncType(argTypes, unsafeResult),
                        rootType: unsafeResult,
                        builtinKind: "unsafeTransSet",
                    },
                };
            }
            return undefined;
        }
        case "detrans": {
            if (argTypes.length !== 1) return undefined;
            if (argTypes[0] instanceof MutArrType) {
                const detResult = new ArrayType(argTypes[0].innerType);
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "detrans",
                        callerType: new FuncType(argTypes, detResult),
                        rootType: detResult,
                        builtinKind: "detrans",
                    },
                };
            }
            if (argTypes[0] instanceof MutDictType) {
                const detResult = new DictType(argTypes[0].keyType, argTypes[0].valueType);
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "detrans",
                        callerType: new FuncType(argTypes, detResult),
                        rootType: detResult,
                        builtinKind: "detransDict",
                    },
                };
            }
            if (argTypes[0] instanceof MutSetType) {
                const detResult = new SetType(argTypes[0].innerType);
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "detrans",
                        callerType: new FuncType(argTypes, detResult),
                        rootType: detResult,
                        builtinKind: "detransSet",
                    },
                };
            }
            return undefined;
        }
        case "push": {
            if (argTypes.length !== 2) return undefined;
            // MutArr push: (mutarr, value) → MutArr (chainable)
            if (argTypes[0] instanceof MutArrType) {
                if (!looseMatch(argTypes[0].innerType, argTypes[1])) return undefined;
                const mutArrResult = argTypes[0];
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "push",
                        callerType: new FuncType(argTypes, mutArrResult),
                        rootType: mutArrResult,
                        builtinKind: "push",
                    },
                };
            }
            // MutSet push: (mutset, value) → MutSet (chainable)
            if (argTypes[0] instanceof MutSetType) {
                if (!looseMatch(argTypes[0].innerType, argTypes[1])) return undefined;
                const mutsetResult = argTypes[0];
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "push",
                        callerType: new FuncType(argTypes, mutsetResult),
                        rootType: mutsetResult,
                        builtinKind: "pushSet",
                    },
                };
            }
            return undefined;
        }
        case "put": {
            if (argTypes.length !== 3) return undefined;
            // MutArr put: (mutarr, Int index, value) → MutArr (chainable)
            if (argTypes[0] instanceof MutArrType) {
                if (argTypes[1] !== "Int") return undefined;
                if (!looseMatch(argTypes[0].innerType, argTypes[2])) return undefined;
                const mutArrResult = argTypes[0];
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "put",
                        callerType: new FuncType(argTypes, mutArrResult),
                        rootType: mutArrResult,
                        builtinKind: "put",
                    },
                };
            }
            // MutDict put: (mutdict, key, value) → MutDict (chainable)
            if (argTypes[0] instanceof MutDictType) {
                const mutDictResult = argTypes[0];
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "put",
                        callerType: new FuncType(argTypes, mutDictResult),
                        rootType: mutDictResult,
                        builtinKind: "putDict",
                    },
                };
            }
            return undefined;
        }
        case "remove": {
            if (argTypes.length !== 2) return undefined;
            if (argTypes[0] instanceof MutDictType) {
                const mutdictResult = argTypes[0];
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "remove",
                        callerType: new FuncType(argTypes, mutdictResult),
                        rootType: mutdictResult,
                        builtinKind: "removeDict",
                    },
                };
            }
            if (argTypes[0] instanceof MutSetType) {
                const mutsetResult = argTypes[0];
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "remove",
                        callerType: new FuncType(argTypes, mutsetResult),
                        rootType: mutsetResult,
                        builtinKind: "removeSet",
                    },
                };
            }
            return undefined;
        }
        case "Dict": {
            if (argTypes.length !== 1) return undefined;
            const hmArg = argTypes[0];
            if (!(hmArg instanceof ArrayType)) return undefined;
            if (!(hmArg.innerType instanceof TupleType)) return undefined;
            if (hmArg.innerType.types.length !== 2) return undefined;
            const [keyType, valueType] = hmArg.innerType.types;
            return {
                error: null,
                result: {
                    kind: "builtin",
                    referToByName: "Dict",
                    callerType: new FuncType(argTypes, new DictType(keyType, valueType)),
                    rootType: new DictType(keyType, valueType),
                    builtinKind: "Dict",
                },
            };
        }
        case "Set": {
            if (argTypes.length !== 1) return undefined;
            const hsArg = argTypes[0];
            if (!(hsArg instanceof ArrayType)) return undefined;
            return {
                error: null,
                result: {
                    kind: "builtin",
                    referToByName: "Set",
                    callerType: new FuncType(argTypes, new SetType(hsArg.innerType)),
                    rootType: new SetType(hsArg.innerType),
                    builtinKind: "Set",
                },
            };
        }
        case "contains": {
            if (argTypes.length !== 2) return undefined;
            const [cContainer, cValue] = argTypes;
            if (
                cContainer instanceof SetType ||
                cContainer instanceof MutSetType ||
                cContainer instanceof ArrayType ||
                cContainer instanceof MutArrType ||
                cContainer instanceof IterType
            ) {
                if (cValue !== cContainer.innerType) return undefined;
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "contains",
                        callerType: new FuncType(argTypes, "Bool"),
                        rootType: "Bool",
                        builtinKind: "contains",
                    },
                };
            }
            if (cContainer instanceof DictType || cContainer instanceof MutDictType) {
                if (cValue !== cContainer.keyType) return undefined;
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "contains",
                        callerType: new FuncType(argTypes, "Bool"),
                        rootType: "Bool",
                        builtinKind: "contains",
                    },
                };
            }
            if (cContainer === "Str") {
                if (cValue !== "Str") return undefined;
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "contains",
                        callerType: new FuncType(argTypes, "Bool"),
                        rootType: "Bool",
                        builtinKind: "contains",
                    },
                };
            }
            return undefined;
        }
        case "find": {
            if (argTypes.length !== 2) return undefined;
            const [fContainer, fValue] = argTypes;
            if (fContainer instanceof ArrayType || fContainer instanceof MutArrType) {
                if (!deepEquals(fContainer.innerType, fValue)) return undefined;
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "find",
                        callerType: new FuncType(argTypes, new MaybeType("Int")),
                        rootType: new MaybeType("Int"),
                        builtinKind: "find",
                    },
                };
            }
            if (fContainer instanceof IterType) {
                if (!deepEquals(fContainer.innerType, fValue)) return undefined;
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "find",
                        callerType: new FuncType(argTypes, new MaybeType("Int")),
                        rootType: new MaybeType("Int"),
                        builtinKind: "find",
                    },
                };
            }
            if (fContainer === "Str" && fValue === "Str") {
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "find",
                        callerType: new FuncType(argTypes, new MaybeType("Int")),
                        rootType: new MaybeType("Int"),
                        builtinKind: "find",
                    },
                };
            }
            return undefined;
        }
        case "split": {
            if (argTypes.length !== 2) return undefined;
            if (argTypes[0] === "Str" && argTypes[1] === "Str") {
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "split",
                        callerType: new FuncType(argTypes, new ArrayType("Str")),
                        rootType: new ArrayType("Str"),
                        builtinKind: "split",
                    },
                };
            }
            return undefined;
        }
        case "replace": {
            if (argTypes.length !== 3) return undefined;
            if (argTypes[0] === "Str" && argTypes[1] === "Str" && argTypes[2] === "Str") {
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "replace",
                        callerType: new FuncType(argTypes, "Str"),
                        rootType: "Str",
                        builtinKind: "replace",
                    },
                };
            }
            return undefined;
        }
        case "union": {
            if (argTypes.length !== 2) return undefined;
            if (
                argTypes[0] instanceof SetType &&
                argTypes[1] instanceof SetType &&
                deepEquals(argTypes[0].innerType, argTypes[1].innerType)
            ) {
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "union",
                        callerType: new FuncType(argTypes, argTypes[0]),
                        rootType: argTypes[0],
                        builtinKind: "union",
                    },
                };
            }
            return undefined;
        }
        case "intersect": {
            if (argTypes.length !== 2) return undefined;
            if (
                argTypes[0] instanceof SetType &&
                argTypes[1] instanceof SetType &&
                deepEquals(argTypes[0].innerType, argTypes[1].innerType)
            ) {
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "intersect",
                        callerType: new FuncType(argTypes, argTypes[0]),
                        rootType: argTypes[0],
                        builtinKind: "intersect",
                    },
                };
            }
            return undefined;
        }
        case "zip": {
            if (argTypes.length < 2) return undefined;
            // All args must be iterable types
            for (const t of argTypes) {
                if (
                    !(t instanceof IterType) &&
                    !(t instanceof ArrayType) &&
                    !(t instanceof MutArrType) &&
                    t !== "Str"
                ) {
                    return undefined;
                }
            }
            const innerTypes: Type[] = argTypes.map((t) => {
                if (t instanceof IterType) return t.innerType;
                if (t instanceof ArrayType) return t.innerType;
                if (t instanceof MutArrType) return t.innerType;
                return "Str";
            });
            return {
                error: null,
                result: {
                    kind: "builtin",
                    referToByName: "zip",
                    callerType: new FuncType(argTypes, new IterType(new TupleType(innerTypes))),
                    rootType: new IterType(new TupleType(innerTypes)),
                    builtinKind: "zip",
                },
            };
        }
        case "repeat": {
            if (argTypes.length !== 2) return undefined;
            const [repeatCount, repeatInner] = argTypes;
            if (repeatCount !== "Int") return undefined;
            if (
                repeatInner instanceof IterType ||
                repeatInner instanceof ArrayType ||
                repeatInner instanceof MutArrType
            ) {
                const rInner =
                    repeatInner instanceof IterType ? repeatInner.innerType : repeatInner.innerType;
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "repeat",
                        callerType: new FuncType([repeatCount, repeatInner], new IterType(rInner)),
                        rootType: new IterType(rInner),
                        builtinKind: "repeat",
                    },
                };
            }
            if (repeatInner === "Str") {
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "repeat",
                        callerType: new FuncType([repeatCount, repeatInner], new IterType("Str")),
                        rootType: new IterType("Str"),
                        builtinKind: "repeat",
                    },
                };
            }
            return undefined;
        }
        case "repeatInner": {
            if (argTypes.length !== 2) return undefined;
            const [riCount, riInner] = argTypes;
            if (riCount !== "Int") return undefined;
            if (
                riInner instanceof IterType ||
                riInner instanceof ArrayType ||
                riInner instanceof MutArrType
            ) {
                const riInnerType =
                    riInner instanceof IterType ? riInner.innerType : riInner.innerType;
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "repeatInner",
                        callerType: new FuncType([riCount, riInner], new IterType(riInnerType)),
                        rootType: new IterType(riInnerType),
                        builtinKind: "repeatInner",
                    },
                };
            }
            if (riInner === "Str") {
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "repeatInner",
                        callerType: new FuncType([riCount, riInner], new IterType("Str")),
                        rootType: new IterType("Str"),
                        builtinKind: "repeatInner",
                    },
                };
            }
            return undefined;
        }
        case "cartesian": {
            if (argTypes.length < 2) return undefined;
            const innerTypes: Type[] = argTypes.map((t) => {
                if (t instanceof IterType) return t.innerType;
                if (t instanceof ArrayType) return t.innerType;
                if (t instanceof MutArrType) return t.innerType;
                return t === "Str" ? "Str" : t;
            });
            return {
                error: null,
                result: {
                    kind: "builtin",
                    referToByName: "cartesian",
                    callerType: new FuncType(argTypes, new IterType(new TupleType(innerTypes))),
                    rootType: new IterType(new TupleType(innerTypes)),
                    builtinKind: "cartesian",
                },
            };
        }
        case "permutations": {
            if (argTypes.length !== 1) return undefined;
            const permInner = argTypes[0];
            if (
                permInner instanceof IterType ||
                permInner instanceof ArrayType ||
                permInner instanceof MutArrType
            ) {
                const pInner =
                    permInner instanceof IterType ? permInner.innerType : permInner.innerType;
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "permutations",
                        callerType: new FuncType(
                            [permInner],
                            new IterType(new TupleType([pInner]))
                        ),
                        rootType: new IterType(new TupleType([pInner])),
                        builtinKind: "permutations",
                    },
                };
            }
            return undefined;
        }
        case "combinations": {
            if (argTypes.length !== 2) return undefined;
            const [combIter, combN] = argTypes;
            if (combN !== "Int") return undefined;
            if (
                combIter instanceof IterType ||
                combIter instanceof ArrayType ||
                combIter instanceof MutArrType
            ) {
                const cInner =
                    combIter instanceof IterType ? combIter.innerType : combIter.innerType;
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "combinations",
                        callerType: new FuncType(
                            [combIter, combN],
                            new IterType(new TupleType([cInner]))
                        ),
                        rootType: new IterType(new TupleType([cInner])),
                        builtinKind: "combinations",
                    },
                };
            }
            return undefined;
        }
        case "toIter": {
            if (argTypes.length !== 1) return undefined;
            const tiInner = argTypes[0];
            if (tiInner instanceof ArrayType || tiInner instanceof MutArrType) {
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "toIter",
                        callerType: new FuncType([tiInner], new IterType(tiInner.innerType)),
                        rootType: new IterType(tiInner.innerType),
                        builtinKind: "toIter",
                    },
                };
            }
            if (tiInner instanceof DictType || tiInner instanceof MutDictType) {
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "toIter",
                        callerType: new FuncType(
                            [tiInner],
                            new IterType(new TupleType([tiInner.keyType, tiInner.valueType]))
                        ),
                        rootType: new IterType(new TupleType([tiInner.keyType, tiInner.valueType])),
                        builtinKind: "toIter",
                    },
                };
            }
            if (tiInner instanceof SetType || tiInner instanceof MutSetType) {
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "toIter",
                        callerType: new FuncType([tiInner], new IterType(tiInner.innerType)),
                        rootType: new IterType(tiInner.innerType),
                        builtinKind: "toIter",
                    },
                };
            }
            if (tiInner === "Str") {
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "toIter",
                        callerType: new FuncType([tiInner], new IterType("Str")),
                        rootType: new IterType("Str"),
                        builtinKind: "toIter",
                    },
                };
            }
            return undefined;
        }
        case "toArr": {
            if (argTypes.length !== 1) return undefined;
            const taInner = argTypes[0];
            if (taInner instanceof DictType || taInner instanceof MutDictType) {
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "toArr",
                        callerType: new FuncType(
                            [taInner],
                            new ArrayType(new TupleType([taInner.keyType, taInner.valueType]))
                        ),
                        rootType: new ArrayType(
                            new TupleType([taInner.keyType, taInner.valueType])
                        ),
                        builtinKind: "toArr",
                    },
                };
            }
            if (taInner instanceof SetType || taInner instanceof MutSetType) {
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "toArr",
                        callerType: new FuncType([taInner], new ArrayType(taInner.innerType)),
                        rootType: new ArrayType(taInner.innerType),
                        builtinKind: "toArr",
                    },
                };
            }
            if (taInner === "Str") {
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "toArr",
                        callerType: new FuncType([taInner], new ArrayType("Str")),
                        rootType: new ArrayType("Str"),
                        builtinKind: "toArr",
                    },
                };
            }
            return undefined;
        }
        case "unwrap": {
            if (argTypes.length < 1 || argTypes.length > 2) return undefined;
            if (!(argTypes[0] instanceof MaybeType)) return undefined;
            const innerType = argTypes[0].innerType;
            if (argTypes.length === 2) {
                if (!deepEquals(innerType, argTypes[1])) return undefined;
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "unwrap",
                        callerType: new FuncType(argTypes, innerType),
                        rootType: innerType,
                        builtinKind: "unwrap",
                    },
                };
            }
            return {
                error: null,
                result: {
                    kind: "builtin",
                    referToByName: "unwrap",
                    callerType: new FuncType(argTypes, innerType),
                    rootType: innerType,
                    builtinKind: "unwrap",
                },
            };
        }
        case "isnone": {
            if (argTypes.length !== 1) return undefined;
            if (!(argTypes[0] instanceof MaybeType)) return undefined;
            return {
                error: null,
                result: {
                    kind: "builtin",
                    referToByName: "isnone",
                    callerType: new FuncType(argTypes, "Bool"),
                    rootType: "Bool",
                    builtinKind: "isnone",
                },
            };
        }
        default:
            return undefined;
    }
}

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
    // Check if name matches a registered struct (constructor call)
    const structDef = getStruct(name);
    if (structDef) {
        const fieldTypes = structDef.fields.map((f) => f.type);
        if (!paramTypesMatchArgTypes(fieldTypes, argTypes)) {
            return {
                error: `struct ${name} constructor expects arguments of types [${fieldTypes}], got [${argTypes}]`,
                result: null,
            };
        }
        const structType = new CustomType(name);
        return {
            error: null,
            result: {
                kind: "struct-constructor",
                referToByName: name,
                callerType: new FuncType(fieldTypes, structType),
                rootType: structType,
            },
        };
    }

    // Check if a local variable with this name shadows any global function.
    // Variable assignments and function params take priority over globally
    // registered functions.
    let hasLocalVar = false;
    // Walk up parent chain from root looking for local definitions
    let scanChild: Expression = root;
    let scanNode: Expression | null = root.parent;
    while (scanNode) {
        if (scanNode instanceof Block) {
            const olderSiblings = scanNode.expressions.slice(
                0,
                scanNode.expressions.indexOf(scanChild)
            );
            for (let j = olderSiblings.length - 1; j >= 0; j--) {
                let sib = olderSiblings[j];
                while (sib instanceof DropValue) sib = sib.child;
                if (sib instanceof Assignment && sib.name === name) {
                    hasLocalVar = true;
                    break;
                }
            }
            if (hasLocalVar) break;
        } else if (scanNode instanceof Function) {
            for (const param of scanNode.params) {
                if (param.name === name) {
                    hasLocalVar = true;
                    break;
                }
            }
            if (hasLocalVar) break;
        } else if (scanNode instanceof AnonymousFunction) {
            for (const param of scanNode.params) {
                if (param.name === name) {
                    hasLocalVar = true;
                    break;
                }
            }
            if (hasLocalVar) break;
        }
        if (hasLocalVar) break;
        scanChild = scanNode;
        scanNode = scanNode.parent;
    }

    // First try direct match by fullName (skip if a local variable shadows)
    const fullName = functionNameWithParamTypes(name, argTypes);
    const foundFn = !hasLocalVar ? findFunction(fullName) : undefined;
    if (foundFn) {
        return {
            error: null,
            result: {
                kind: "function",
                referToByName: fullName,
                callerType: foundFn.getFuncType(),
                rootType: foundFn.returnType,
            },
        };
    }

    // Walk up parent chain from original root looking for sibling function defs
    let walkNode: Expression | null = root.parent;
    let child: Expression = root;
    while (walkNode) {
        if (walkNode instanceof Block) {
            const olderSiblings = walkNode.expressions.slice(
                0,
                walkNode.expressions.indexOf(child)
            );
            for (let j = olderSiblings.length - 1; j >= 0; j--) {
                let olderSibling = olderSiblings[j];
                while (olderSibling instanceof DropValue) {
                    olderSibling = olderSibling.child;
                }

                // Direct match with a non-generic function
                if (
                    olderSibling instanceof Function &&
                    !olderSibling.isGeneric &&
                    olderSibling.name === name &&
                    paramTypesMatchArgTypes(
                        olderSibling.params.map((t) => t.type),
                        argTypes
                    )
                ) {
                    return {
                        error: null,
                        result: {
                            kind: "function",
                            referToByName: olderSibling.fullName,
                            callerType: olderSibling.getFuncType(),
                            rootType: olderSibling.returnType,
                        },
                    };
                }

                // Generic function matching — attempt monomorphization
                if (
                    olderSibling instanceof Function &&
                    olderSibling.isGeneric &&
                    olderSibling.params.length === argTypes.length
                ) {
                    if (olderSibling.name === name) {
                        const result = olderSibling.monomorphize(argTypes);
                        if (result !== null) {
                            return {
                                error: null,
                                result: {
                                    kind: "function",
                                    referToByName: result.fullName,
                                    callerType: result.funcType,
                                    rootType: result.returnType,
                                },
                            };
                        }
                    }
                }

                // Variable-based callable (assignment)
                if (olderSibling instanceof Assignment && olderSibling.name === name) {
                    if (isVarConsumed(name)) {
                        return {
                            error: `cannot use variable '${name}' after it was detrans'd`,
                            result: null,
                        };
                    }
                    const varType = olderSibling.value.type;
                    if (varType instanceof FuncType) {
                        if (!paramTypesMatchArgTypes(varType.paramTypes, argTypes)) {
                            return {
                                error: `most recent definition of variable ${name} has an incompatible type signature for this function call.`,
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
                        // Array slicing with range: arr(a..b) returns array
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
                        // For literal indices, the exact type will be resolved in Call.cascadeTypes
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
                    if (varType instanceof CustomType && getStruct(varType.name)) {
                        break;
                    }
                    if (varType === "Str") {
                        break;
                    }
                    return {
                        error: `most recent definition of variable ${name} is of type ${varType}, which is not a callable object.`,
                        result: null,
                    };
                }
            }
        } else if (walkNode instanceof Function) {
            for (const param of walkNode.params) {
                if (param.name === name) {
                    if (param.type instanceof FuncType) {
                        if (!paramTypesMatchArgTypes(param.type.paramTypes, argTypes)) {
                            return {
                                error: `variable ${name} (parameter of function ${walkNode.name}) has an incompatible type signature for this function call.`,
                                result: null,
                            };
                        }
                        return {
                            error: null,
                            result: {
                                kind: "variable",
                                referToByName: name,
                                callerType: param.type,
                                rootType: param.type.returnType,
                            },
                        };
                    }
                    if (param.type instanceof ArrayType) {
                        // Array slicing with range: arr(a..b) returns array
                        if (argTypes.length === 1 && argTypes[0] instanceof IterType) {
                            return {
                                error: null,
                                result: {
                                    kind: "variable",
                                    referToByName: name,
                                    callerType: param.type,
                                    rootType: param.type,
                                },
                            };
                        }
                        const incompatible = param.type.checkIndicesCompatible(argTypes);
                        if (incompatible !== null) {
                            return { error: incompatible, result: null };
                        }
                        return {
                            error: null,
                            result: {
                                kind: "variable",
                                referToByName: name,
                                callerType: param.type,
                                rootType: new MaybeType(param.type.innerType),
                            },
                        };
                    }
                    if (param.type instanceof MutArrType) {
                        // Array slicing with range: arr(a..b) returns array
                        if (argTypes.length === 1 && argTypes[0] instanceof IterType) {
                            return {
                                error: null,
                                result: {
                                    kind: "variable",
                                    referToByName: name,
                                    callerType: param.type,
                                    rootType: param.type,
                                },
                            };
                        }
                        const incompatible = param.type.checkIndicesCompatible(argTypes);
                        if (incompatible !== null) {
                            return { error: incompatible, result: null };
                        }
                        return {
                            error: null,
                            result: {
                                kind: "variable",
                                referToByName: name,
                                callerType: param.type,
                                rootType: new MaybeType(param.type.innerType),
                            },
                        };
                    }
                    if (param.type instanceof IterType) {
                        const incompatible = param.type.checkIndicesCompatible(argTypes);
                        if (incompatible !== null) {
                            return { error: incompatible, result: null };
                        }
                        return {
                            error: null,
                            result: {
                                kind: "variable",
                                referToByName: name,
                                callerType: param.type,
                                rootType: new MaybeType(param.type.innerType),
                            },
                        };
                    }
                    if (param.type instanceof TupleType) {
                        const incompatible = param.type.checkIndicesCompatible(argTypes);
                        if (incompatible !== null) {
                            return { error: incompatible, result: null };
                        }
                        return {
                            error: null,
                            result: {
                                kind: "variable",
                                referToByName: name,
                                callerType: param.type,
                                rootType:
                                    param.type.types.length > 0 ? param.type.types[0] : "Null",
                            },
                        };
                    }
                    if (param.type instanceof DictType) {
                        const incompatible = param.type.checkIndicesCompatible(argTypes);
                        if (incompatible !== null) {
                            return { error: incompatible, result: null };
                        }
                        return {
                            error: null,
                            result: {
                                kind: "variable",
                                referToByName: name,
                                callerType: param.type,
                                rootType: param.type.valueType,
                            },
                        };
                    }
                    if (param.type instanceof CustomType && getStruct(param.type.name)) {
                        break;
                    }
                    if (param.type === "Str") {
                        break;
                    }
                    return {
                        error: `variable ${name} (parameter of function ${walkNode.name}) is not a function.`,
                        result: null,
                    };
                }
            }
            if (walkNode.fullName === fullName) {
                return {
                    error: null,
                    result: {
                        kind: "function",
                        referToByName: fullName,
                        callerType: walkNode.getFuncType(),
                        rootType: walkNode.returnType,
                    },
                };
            }
        } else if (walkNode instanceof AnonymousFunction) {
            for (const param of walkNode.params) {
                if (param.name === name) {
                    if (param.type instanceof FuncType) {
                        if (!paramTypesMatchArgTypes(param.type.paramTypes, argTypes)) {
                            return {
                                error: `variable ${name} (parameter of anonymous function) has an incompatible type signature for this function call.`,
                                result: null,
                            };
                        }
                        return {
                            error: null,
                            result: {
                                kind: "variable",
                                referToByName: name,
                                callerType: param.type,
                                rootType: param.type.returnType,
                            },
                        };
                    }
                    if (param.type instanceof ArrayType) {
                        // Array slicing with range: arr(a..b) returns array
                        if (argTypes.length === 1 && argTypes[0] instanceof IterType) {
                            return {
                                error: null,
                                result: {
                                    kind: "variable",
                                    referToByName: name,
                                    callerType: param.type,
                                    rootType: param.type,
                                },
                            };
                        }
                        const incompatible = param.type.checkIndicesCompatible(argTypes);
                        if (incompatible !== null) {
                            return { error: incompatible, result: null };
                        }
                        return {
                            error: null,
                            result: {
                                kind: "variable",
                                referToByName: name,
                                callerType: param.type,
                                rootType: new MaybeType(param.type.innerType),
                            },
                        };
                    }
                    if (param.type instanceof MutArrType) {
                        // Array slicing with range: arr(a..b) returns array
                        if (argTypes.length === 1 && argTypes[0] instanceof IterType) {
                            return {
                                error: null,
                                result: {
                                    kind: "variable",
                                    referToByName: name,
                                    callerType: param.type,
                                    rootType: param.type,
                                },
                            };
                        }
                        const incompatible = param.type.checkIndicesCompatible(argTypes);
                        if (incompatible !== null) {
                            return { error: incompatible, result: null };
                        }
                        return {
                            error: null,
                            result: {
                                kind: "variable",
                                referToByName: name,
                                callerType: param.type,
                                rootType: new MaybeType(param.type.innerType),
                            },
                        };
                    }
                    if (param.type instanceof IterType) {
                        const incompatible = param.type.checkIndicesCompatible(argTypes);
                        if (incompatible !== null) {
                            return { error: incompatible, result: null };
                        }
                        return {
                            error: null,
                            result: {
                                kind: "variable",
                                referToByName: name,
                                callerType: param.type,
                                rootType: new MaybeType(param.type.innerType),
                            },
                        };
                    }
                    if (param.type instanceof TupleType) {
                        const incompatible = param.type.checkIndicesCompatible(argTypes);
                        if (incompatible !== null) {
                            return { error: incompatible, result: null };
                        }
                        return {
                            error: null,
                            result: {
                                kind: "variable",
                                referToByName: name,
                                callerType: param.type,
                                rootType:
                                    param.type.types.length > 0 ? param.type.types[0] : "Null",
                            },
                        };
                    }
                    if (param.type instanceof DictType || param.type instanceof MutDictType) {
                        const incompatible = param.type.checkIndicesCompatible(argTypes);
                        if (incompatible !== null) {
                            return { error: incompatible, result: null };
                        }
                        return {
                            error: null,
                            result: {
                                kind: "variable",
                                referToByName: name,
                                callerType: param.type,
                                rootType: param.type.valueType,
                            },
                        };
                    }
                    if (param.type instanceof CustomType && getStruct(param.type.name)) {
                        break;
                    }
                    if (param.type === "Str") {
                        break;
                    }
                    return {
                        error: `variable ${name} (parameter of anonymous function) is not a function.`,
                        result: null,
                    };
                }
            }
        }
        child = walkNode;
        walkNode = walkNode.parent;
    }

    // Check for type conversion builtins
    if (argTypes.length === 1) {
        const conversionResult = findTypeConversion(name, argTypes[0]);
        if (conversionResult) {
            return conversionResult;
        }
    }

    // Check for iterator/array builtins
    const builtinResult = findBuiltin(name, argTypes);
    if (builtinResult) {
        return builtinResult;
    }

    // Trait dispatch
    const traitCandidates: { traitName: string; selfType: Type }[] = [];
    for (const argType of argTypes) {
        if (argType instanceof CustomType) {
            for (const trait of argType.traits) {
                traitCandidates.push({ traitName: trait, selfType: argType });
            }
        }
    }
    for (const { traitName, selfType } of traitCandidates) {
        const traitFuncs = getTrait(traitName);
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
                        rootType: returnType,
                        paramNames: tf.paramNames,
                    },
                };
            }
        }
    }

    // Fallback: inside a generic function body, check for trait functions
    let traitFn: Expression | null = parent;
    while (traitFn) {
        if (traitFn instanceof Function && traitFn.isGeneric) {
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
                    const traitFuncs = getTrait(traitName);
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
                                    rootType: returnType,
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

    return {
        error: `function ${name}[${argTypes.map((t) => t.toString()).join(", ")}: unknown] not found`,
        result: null,
    };
}
