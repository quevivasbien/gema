import type { Expression } from "./expression";
import { FunctionDef } from "./nodes";
import type { StructDef } from "./structs";
import type { Scope } from "./scope";
import {
    collectTraitsForTypeParam,
    typeEquals,
    looseMatch,
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
    MutSetType,
    SetType,
    type TemplateTypes,
    TupleType,
    type CallableType,
    type Type,
} from "./types";

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
                if (secondInner !== "Int" && secondInner !== "Num") return undefined;
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
            const allInt = argTypes.every((t) => t === "Int");
            const allNum = argTypes.every((t) => t === "Num");
            if (!allInt && !allNum) return undefined;
            const innerType = allInt ? "Int" : "Num";
            return {
                error: null,
                result: {
                    kind: "builtin",
                    referToByName: "range",
                    callerType: new FuncType(argTypes, new IterType(innerType)),
                    rootType: new IterType(innerType),
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
            const [sStep, sIter] = argTypes;
            if (sStep !== "Int" && sStep !== "Num") return undefined;
            if (
                sIter instanceof IterType ||
                sIter instanceof ArrayType ||
                sIter instanceof MutArrType
            ) {
                const sInner = sIter.innerType;
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "step",
                        callerType: new FuncType([sStep, sIter], new IterType(sInner)),
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
                        callerType: new FuncType([sStep, sIter], new IterType("Str")),
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
                        callerType: new FuncType([lenInner], "Num"),
                        rootType: "Num",
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
                        callerType: new FuncType([lenInner], "Num"),
                        rootType: "Num",
                        builtinKind: "length",
                    },
                };
            }
            return undefined;
        }
        case "head": {
            if (argTypes.length !== 1) return undefined;
            const hInner = argTypes[0];
            if (
                hInner instanceof IterType ||
                hInner instanceof ArrayType ||
                hInner instanceof MutArrType
            ) {
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "head",
                        callerType: new FuncType([hInner], new MaybeType(hInner.innerType)),
                        rootType: new MaybeType(hInner.innerType),
                        builtinKind: "head",
                    },
                };
            } else if (hInner === "Str") {
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "head",
                        callerType: new FuncType([hInner], new MaybeType("Str")),
                        rootType: new MaybeType("Str"),
                        builtinKind: "head",
                    },
                };
            }
            return undefined;
        }
        case "take": {
            if (argTypes.length !== 2) return undefined;
            if (argTypes[0] !== "Int" && argTypes[0] !== "Num") return undefined;
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
            if (argTypes[0] !== "Int" && argTypes[0] !== "Num") return undefined;
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
            // MutArr push: (value, mutarr) → MutArr (chainable)
            if (argTypes[1] instanceof MutArrType) {
                const [valueType, mutArrType] = argTypes;
                if (!looseMatch(mutArrType.innerType, valueType)) return undefined;
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "push",
                        callerType: new FuncType(argTypes, mutArrType),
                        rootType: mutArrType,
                        builtinKind: "push",
                    },
                };
            }
            // MutSet push: (value, mutset) → MutSet (chainable)
            if (argTypes[1] instanceof MutSetType) {
                const [valueType, mutSetType] = argTypes;
                if (!looseMatch(mutSetType.innerType, valueType)) return undefined;
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "push",
                        callerType: new FuncType(argTypes, mutSetType),
                        rootType: mutSetType,
                        builtinKind: "pushSet",
                    },
                };
            }
            return undefined;
        }
        case "put": {
            if (argTypes.length !== 3) return undefined;
            // MutArr put: (value, index, mutarr) → MutArr (chainable)
            if (argTypes[2] instanceof MutArrType) {
                const [valueType, indexType, mutArrType] = argTypes;
                if (indexType !== "Int" && indexType !== "Num") return undefined;
                if (!looseMatch(mutArrType.innerType, valueType)) return undefined;
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "put",
                        callerType: new FuncType(argTypes, mutArrType),
                        rootType: mutArrType,
                        builtinKind: "put",
                    },
                };
            }
            // MutDict put: (value, key, mutdict) → MutDict (chainable)
            if (argTypes[2] instanceof MutDictType) {
                const [valueType, keyType, mutDictType] = argTypes;
                if (!looseMatch(mutDictType.keyType, keyType)) return undefined;
                if (!looseMatch(mutDictType.valueType, valueType)) return undefined;
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "put",
                        callerType: new FuncType(argTypes, mutDictType),
                        rootType: mutDictType,
                        builtinKind: "putDict",
                    },
                };
            }
            return undefined;
        }
        case "remove": {
            if (argTypes.length !== 2) return undefined;
            if (argTypes[1] instanceof MutDictType) {
                const [keyType, mutDictType] = argTypes;
                if (!looseMatch(mutDictType.keyType, keyType)) return undefined;
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "remove",
                        callerType: new FuncType(argTypes, mutDictType),
                        rootType: mutDictType,
                        builtinKind: "removeDict",
                    },
                };
            }
            if (argTypes[1] instanceof MutSetType) {
                const [valueType, mutSetType] = argTypes;
                if (!looseMatch(mutSetType.innerType, valueType)) return undefined;
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "remove",
                        callerType: new FuncType(argTypes, mutSetType),
                        rootType: mutSetType,
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
            const [cValue, cContainer] = argTypes;
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
            const [fValue, fContainer] = argTypes;
            if (fContainer instanceof ArrayType || fContainer instanceof MutArrType) {
                if (!typeEquals(fContainer.innerType, fValue)) return undefined;
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "find",
                        callerType: new FuncType(argTypes, new MaybeType("Num")),
                        rootType: new MaybeType("Num"),
                        builtinKind: "find",
                    },
                };
            }
            if (fContainer instanceof IterType) {
                if (!typeEquals(fContainer.innerType, fValue)) return undefined;
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "find",
                        callerType: new FuncType(argTypes, new MaybeType("Num")),
                        rootType: new MaybeType("Num"),
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
                        callerType: new FuncType(argTypes, new MaybeType("Num")),
                        rootType: new MaybeType("Num"),
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
                typeEquals(argTypes[0].innerType, argTypes[1].innerType)
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
                typeEquals(argTypes[0].innerType, argTypes[1].innerType)
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
            if (repeatCount !== "Int" && repeatCount !== "Num") return undefined;
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
            if (riCount !== "Int" && riCount !== "Num") return undefined;
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
            const innerTypes: Type[] = [];
            for (const t of argTypes) {
                if (t instanceof IterType || t instanceof ArrayType || t instanceof MutArrType) {
                    innerTypes.push(t.innerType);
                    continue;
                }
                if (t === "Str") {
                    innerTypes.push("Str");
                    continue;
                }
                // Got invalid type for cartesian iterator
                return undefined;
            }
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
                        callerType: new FuncType([permInner], new IterType(new ArrayType(pInner))),
                        rootType: new IterType(new ArrayType(pInner)),
                        builtinKind: "permutations",
                    },
                };
            }
            return undefined;
        }
        case "combinations": {
            if (argTypes.length !== 2) return undefined;
            const [combN, combIter] = argTypes;
            if (combN !== "Num" && combN !== "Int") return undefined;
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
                            [combN, combIter],
                            new IterType(new ArrayType(cInner))
                        ),
                        rootType: new IterType(new ArrayType(cInner)),
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
            if (argTypes.length === 2) {
                if (!(argTypes[1] instanceof MaybeType)) return undefined;
                const innerType = argTypes[1].innerType;
                if (!typeEquals(innerType, argTypes[0])) return undefined;
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
            if (!(argTypes[0] instanceof MaybeType)) return undefined;
            const innerType = argTypes[0].innerType;
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
        case "some": {
            if (argTypes.length !== 1) return undefined;
            return {
                error: null,
                result: {
                    kind: "builtin",
                    referToByName: "some",
                    callerType: new FuncType(argTypes, new MaybeType(argTypes[0])),
                    rootType: new MaybeType(argTypes[0]),
                    builtinKind: "some",
                },
            };
        }
        case "toStr": {
            if (argTypes.length !== 1) return undefined;
            if (argTypes[0] === "Int" || argTypes[0] === "Num" || argTypes[0] === "Bool") {
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "toStr",
                        callerType: new FuncType(argTypes, "Str"),
                        rootType: "Str",
                        builtinKind: "toStr",
                    },
                };
            }
            return undefined;
        }
        case "toInt": {
            if (argTypes.length !== 1) return undefined;
            if (argTypes[0] === "Num" || argTypes[0] === "Bool") {
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "toInt",
                        callerType: new FuncType(argTypes, "Int"),
                        rootType: "Int",
                        builtinKind: "toInt",
                    },
                };
            }
            return undefined;
        }
        case "toNum": {
            if (argTypes.length !== 1) return undefined;
            if (argTypes[0] === "Int") {
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "toNum",
                        callerType: new FuncType(argTypes, "Num"),
                        rootType: "Num",
                        builtinKind: "toNum",
                    },
                };
            }
            return undefined;
        }
        case "toBool": {
            if (argTypes.length !== 1) return undefined;
            if (argTypes[0] === "Int" || argTypes[0] === "Num" || argTypes[0] === "Str") {
                return {
                    error: null,
                    result: {
                        kind: "builtin",
                        referToByName: "toBool",
                        callerType: new FuncType(argTypes, "Bool"),
                        rootType: "Bool",
                        builtinKind: "toBool",
                    },
                };
            }
            return undefined;
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
                                const result = genericFn.monomorphize(argTypes);
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
                                const result = genericFn.monomorphize(argTypes);
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
                        error: `cannot use variable '${name}' after it was detrans'd`,
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
        return builtinResult;
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
                    rootType: structType,
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
