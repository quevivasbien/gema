import type { JSWriter } from "../../write-js";
import { wrapArrayToIter } from "../caller-utils";
import type { Expression } from "../expression";
import { looseMatch, typeEquals } from "../type-utils";
import {
    ArrayType,
    DictType,
    FuncType,
    IterType,
    MaybeType,
    MutArrType,
    MutDictType,
    MutSetType,
    SetType,
    TupleType,
    type Type,
} from "../types";

type BuiltinResult = {
    kind: "builtin";
    returnType: Type;
    toJS: (writer: JSWriter) => void;
};

const BUILTIN_RESOLVERS: Record<
    string,
    (args: Expression[], argTypes: Type[]) => BuiltinResult | null
> = {
    collect: (args, argTypes) => {
        if (argTypes.length !== 1) return null;

        const toJS = (writer: JSWriter) => {
            writer.useBuiltin("$collect$");
            writer.write("$collect$(");
            wrapArrayToIter(writer, args[0]);
            writer.write(")");
        };

        const inner = argTypes[0];
        if (inner instanceof IterType) {
            return {
                kind: "builtin",
                returnType: new ArrayType(inner.innerType),
                toJS,
            };
        }
        if (inner instanceof ArrayType || inner instanceof MutArrType) {
            return {
                kind: "builtin",
                returnType: inner,
                toJS,
            };
        }
        if (inner === "Str") {
            return {
                kind: "builtin",
                returnType: new ArrayType("Str"),
                toJS,
            };
        }
        return null;
    },
    map: (args, argTypes) => {
        if (argTypes.length !== 2) return null;
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
                return null;
            const secondInner =
                mapSecond instanceof IterType ? mapSecond.innerType : mapSecond.innerType;
            if (secondInner !== "Int" && secondInner !== "Num") return null;
            return {
                kind: "builtin",
                returnType: new IterType(mapFirst.innerType),
                toJS: (writer) => {
                    writer.useBuiltin("$ArrayMapIterator$");
                    writer.write("new $ArrayMapIterator$(");
                    args[0].toJS(writer);
                    writer.write(", ");
                    wrapArrayToIter(writer, args[1]);
                    writer.write(")");
                },
            };
        }

        // map(func, iter)
        const mapFuncIterableToJS = (writer: JSWriter) => {
            writer.useBuiltin("$MapIterator$");
            writer.write("new $MapIterator$(");
            args[0]?.toJS(writer);
            writer.write(", ");
            wrapArrayToIter(writer, args[1]);
            writer.write(")");
        };

        if (
            mapFirst instanceof FuncType &&
            mapFirst.paramTypes.length === 1 &&
            mapSecond === "Str"
        ) {
            if (!looseMatch(mapFirst.paramTypes[0], "Str")) return null;
            return {
                kind: "builtin",
                returnType: new IterType(mapFirst.returnType),
                toJS: mapFuncIterableToJS,
            };
        }
        if (!(mapFirst instanceof FuncType) || mapFirst.paramTypes.length !== 1) return null;
        if (
            mapSecond instanceof IterType ||
            mapSecond instanceof ArrayType ||
            mapSecond instanceof MutArrType
        ) {
            const mapIterInner =
                mapSecond instanceof IterType ? mapSecond.innerType : mapSecond.innerType;
            if (!looseMatch(mapFirst.paramTypes[0], mapIterInner)) return null;
            const mapOutputType = mapFirst.returnType;
            return {
                kind: "builtin",
                returnType: new IterType(mapOutputType),
                toJS: mapFuncIterableToJS,
            };
        }

        return null;
    },
    filter: (args, argTypes) => {
        if (argTypes.length !== 2) return null;
        const [fFnType, fIterType] = argTypes;
        if (!(fFnType instanceof FuncType) || fFnType.paramTypes.length !== 1) return null;
        if (fFnType.returnType !== "Bool") return null;

        const toJS = (writer: JSWriter) => {
            writer.useBuiltin("$FilterIterator$");
            writer.write("new $FilterIterator$(");
            args[0]?.toJS(writer);
            writer.write(", ");
            wrapArrayToIter(writer, args[1]);
            writer.write(")");
        };

        if (fIterType === "Str") {
            if (!looseMatch(fFnType.paramTypes[0], "Str")) return null;
            return {
                kind: "builtin",
                returnType: new IterType("Str"),
                toJS,
            };
        }
        if (
            !(fIterType instanceof IterType) &&
            !(fIterType instanceof ArrayType) &&
            !(fIterType instanceof MutArrType)
        )
            return null;
        const fIterInner =
            fIterType instanceof IterType ? fIterType.innerType : fIterType.innerType;
        if (!looseMatch(fFnType.paramTypes[0], fIterInner)) return null;
        return {
            kind: "builtin",
            returnType: new IterType(fIterInner),
            toJS,
        };
    },
    reduce: (args, argTypes) => {
        if (argTypes.length !== 3) return null;
        const [rFnType, rInitType, rIterType] = argTypes;
        if (!(rFnType instanceof FuncType) || rFnType.paramTypes.length !== 2) return null;

        const toJS = (writer: JSWriter) => {
            writer.useBuiltin("$reduce$");
            writer.write("$reduce$(");
            args[0]?.toJS(writer);
            writer.write(", ");
            args[1]?.toJS(writer);
            writer.write(", ");
            wrapArrayToIter(writer, args[2]);
            writer.write(")");
        };

        if (rIterType === "Str") {
            if (!looseMatch(rFnType.paramTypes[0], rInitType)) return null;
            if (!looseMatch(rFnType.paramTypes[1], "Str")) return null;
            return {
                kind: "builtin",
                returnType: rInitType,
                toJS,
            };
        }
        if (
            !(rIterType instanceof IterType) &&
            !(rIterType instanceof ArrayType) &&
            !(rIterType instanceof MutArrType)
        )
            return null;
        const rIterInner =
            rIterType instanceof IterType ? rIterType.innerType : rIterType.innerType;
        if (!looseMatch(rFnType.paramTypes[0], rInitType)) return null;
        if (!looseMatch(rFnType.paramTypes[1], rIterInner)) return null;
        if (!looseMatch(rFnType.returnType, rInitType)) return null;
        return {
            kind: "builtin",
            returnType: rInitType,
            toJS,
        };
    },
    range: (args, argTypes) => {
        if (argTypes.length !== 2 && argTypes.length !== 3) return null;
        const allInt = argTypes.every((t) => t === "Int");
        const allNum = argTypes.every((t) => t === "Num");
        if (!allInt && !allNum) return null;
        const innerType = allInt ? "Int" : "Num";

        const toJS = (writer: JSWriter) => {
            if (args[0]?.type === "Num") {
                writer.useBuiltin("$RangeIterator$");
                writer.write("new $RangeIterator$(");
            } else if (args[0]?.type === "Int") {
                writer.useBuiltin("$IntRangeIterator$");
                writer.write("new $IntRangeIterator$(");
            } else {
                throw new Error(`Unexpected type ${args[0]?.type} in range iterator`);
            }
            args.forEach((arg, i) => {
                if (i > 0) writer.write(", ");
                arg.toJS(writer);
            });
            writer.write(")");
        };

        return {
            kind: "builtin",
            returnType: new IterType(innerType),
            toJS,
        };
    },
    iterate: (args, argTypes) => {
        if (argTypes.length !== 2) return null;
        const [iFnType, iStartType] = argTypes;
        if (!(iFnType instanceof FuncType) || iFnType.paramTypes.length !== 1) return null;
        if (!looseMatch(iFnType.paramTypes[0], iStartType)) return null;
        if (!looseMatch(iFnType.returnType, iStartType)) return null;

        const toJS = (writer: JSWriter) => {
            writer.useBuiltin("$IterateIterator$");
            writer.write("new $IterateIterator$(");
            args.forEach((arg, i) => {
                if (i > 0) writer.write(", ");
                arg.toJS(writer);
            });
            writer.write(")");
        };

        return {
            kind: "builtin",
            returnType: new IterType(iStartType),
            toJS,
        };
    },
    step: (args, argTypes) => {
        if (argTypes.length !== 2) return null;
        const [sStep, sIter] = argTypes;
        if (sStep !== "Int" && sStep !== "Num") return null;

        const toJS = (writer: JSWriter) => {
            writer.useBuiltin("$StepIterator$");
            if (args[0]?.type === "Num") {
                writer.write("new $StepIterator$(");
                args[0]?.toJS(writer);
                writer.write(", ");
            } else if (args[0]?.type === "Int") {
                writer.write("new $StepIterator$(Number(");
                args[0]?.toJS(writer);
                writer.write("), ");
            } else {
                throw new Error(`Got unexpected type ${args[0]?.type} in step iterator`);
            }
            wrapArrayToIter(writer, args[1]);
            writer.write(")");
        };

        if (
            sIter instanceof IterType ||
            sIter instanceof ArrayType ||
            sIter instanceof MutArrType
        ) {
            return {
                kind: "builtin",
                returnType: new IterType(sIter.innerType),
                toJS,
            };
        }
        if (sIter === "Str") {
            return {
                kind: "builtin",
                returnType: new IterType("Str"),
                toJS,
            };
        }
        return null;
    },
    last: (args, argTypes) => {
        if (argTypes.length !== 1) return null;
        const lInner = argTypes[0];

        const iterToJS = (writer: JSWriter) => {
            writer.useBuiltin("$last$");
            writer.write("$last$(");
            wrapArrayToIter(writer, args[0]);
            writer.write(")");
        };

        const arrOrStrToJS = (writer: JSWriter) => {
            writer.write("(");
            args[0].toJS(writer);
            writer.write("[");
            args[0].toJS(writer);
            writer.write(".length - 1] ?? null)");
        };

        if (lInner instanceof IterType) {
            return {
                kind: "builtin",
                returnType: new MaybeType(lInner.innerType),
                toJS: iterToJS,
            };
        }
        if (lInner instanceof ArrayType || lInner instanceof MutArrType) {
            return {
                kind: "builtin",
                returnType: new MaybeType(lInner.innerType),
                toJS: arrOrStrToJS,
            };
        }
        if (lInner === "Str") {
            return {
                kind: "builtin",
                returnType: new MaybeType("Str"),
                toJS: arrOrStrToJS,
            };
        }
        return null;
    },
    length: (args, argTypes) => {
        if (argTypes.length !== 1) return null;
        const lenInner = argTypes[0];

        const arrOrStrToJS = (writer: JSWriter) => {
            args[0].toJS(writer);
            writer.write(".length");
        };

        const iterToJS = (writer: JSWriter) => {
            writer.useBuiltin("$length$");
            writer.write("$length$(");
            wrapArrayToIter(writer, args[0]);
            writer.write(")");
        };

        if (lenInner instanceof IterType) {
            return {
                kind: "builtin",
                returnType: "Num",
                toJS: iterToJS,
            };
        }
        if (lenInner instanceof ArrayType || lenInner instanceof MutArrType) {
            return {
                kind: "builtin",
                returnType: "Num",
                toJS: arrOrStrToJS,
            };
        }
        if (lenInner === "Str") {
            return {
                kind: "builtin",
                returnType: "Num",
                toJS: arrOrStrToJS,
            };
        }
        return null;
    },
    head: (args, argTypes) => {
        if (argTypes.length !== 1) return null;
        const hInner = argTypes[0];

        const arrOrStrToJS = (writer: JSWriter) => {
            writer.write("(");
            args[0].toJS(writer);
            writer.write("[0] ?? null)");
        };

        const iterToJS = (writer: JSWriter) => {
            writer.useBuiltin("$iterGet$");
            writer.write("$iterGet$(0, ");
            args[0].toJS(writer);
            writer.write(")");
        };

        if (hInner instanceof IterType) {
            return {
                kind: "builtin",
                returnType: new MaybeType(hInner.innerType),
                toJS: iterToJS,
            };
        }
        if (hInner instanceof ArrayType || hInner instanceof MutArrType) {
            return {
                kind: "builtin",
                returnType: new MaybeType(hInner.innerType),
                toJS: arrOrStrToJS,
            };
        }
        if (hInner === "Str") {
            return {
                kind: "builtin",
                returnType: new MaybeType("Str"),
                toJS: arrOrStrToJS,
            };
        }
        return null;
    },
    take: (args, argTypes) => {
        if (argTypes.length !== 2) return null;
        if (argTypes[0] !== "Int" && argTypes[0] !== "Num") return null;
        const tInner = argTypes[1];

        const toJS = (writer: JSWriter) => {
            writer.useBuiltin("$TakeIterator$");
            writer.write("new $TakeIterator$(");
            args[0]?.toJS(writer);
            writer.write(", ");
            wrapArrayToIter(writer, args[1]);
            writer.write(")");
        };

        if (
            tInner instanceof IterType ||
            tInner instanceof ArrayType ||
            tInner instanceof MutArrType
        ) {
            return {
                kind: "builtin",
                returnType: new IterType(tInner.innerType),
                toJS,
            };
        }
        if (tInner === "Str") {
            return {
                kind: "builtin",
                returnType: new IterType("Str"),
                toJS,
            };
        }
        return null;
    },
    drop: (args, argTypes) => {
        if (argTypes.length !== 2) return null;
        if (argTypes[0] !== "Int" && argTypes[0] !== "Num") return null;
        const dInner = argTypes[1];

        const toJS = (writer: JSWriter) => {
            writer.useBuiltin("$DropIterator$");
            if (args[0]?.type === "Num") {
                writer.write("new $DropIterator$(");
                args[0]?.toJS(writer);
                writer.write(", ");
            } else if (args[0]?.type === "Int") {
                writer.write("new $DropIterator$(Number(");
                args[0]?.toJS(writer);
                writer.write("), ");
            } else {
                throw new Error(`Got unexpected type ${args[0]?.type} in drop iterator`);
            }
            wrapArrayToIter(writer, args[1]);
            writer.write(")");
        };

        if (
            dInner instanceof IterType ||
            dInner instanceof ArrayType ||
            dInner instanceof MutArrType
        ) {
            return {
                kind: "builtin",
                returnType: new IterType(dInner.innerType),
                toJS,
            };
        }
        if (dInner === "Str") {
            return {
                kind: "builtin",
                returnType: new IterType("Str"),
                toJS,
            };
        }
        return null;
    },
    takeWhile: (args, argTypes) => {
        if (argTypes.length !== 2) return null;
        const [twFnType, twIterType] = argTypes;
        if (!(twFnType instanceof FuncType) || twFnType.paramTypes.length !== 1) return null;
        if (twFnType.returnType !== "Bool") return null;

        const toJS = (writer: JSWriter) => {
            writer.useBuiltin("$TakeWhileIterator$");
            writer.write("new $TakeWhileIterator$(");
            args[0]?.toJS(writer);
            writer.write(", ");
            wrapArrayToIter(writer, args[1]);
            writer.write(")");
        };

        if (twIterType instanceof IterType) {
            if (!looseMatch(twFnType.paramTypes[0], twIterType.innerType)) return null;
            return {
                kind: "builtin",
                returnType: new IterType(twIterType.innerType),
                toJS,
            };
        }
        if (twIterType instanceof ArrayType || twIterType instanceof MutArrType) {
            if (!looseMatch(twFnType.paramTypes[0], twIterType.innerType)) return null;
            return {
                kind: "builtin",
                returnType: new IterType(twIterType.innerType),
                toJS,
            };
        }
        if (twIterType === "Str") {
            if (!looseMatch(twFnType.paramTypes[0], "Str")) return null;
            return {
                kind: "builtin",
                returnType: new IterType("Str"),
                toJS,
            };
        }
        return null;
    },
    dropWhile: (args, argTypes) => {
        if (argTypes.length !== 2) return null;
        const [dwFnType, dwIterType] = argTypes;
        if (!(dwFnType instanceof FuncType) || dwFnType.paramTypes.length !== 1) return null;
        if (dwFnType.returnType !== "Bool") return null;

        const toJS = (writer: JSWriter) => {
            writer.useBuiltin("$DropWhileIterator$");
            writer.write("new $DropWhileIterator$(");
            args[0]?.toJS(writer);
            writer.write(", ");
            wrapArrayToIter(writer, args[1]);
            writer.write(")");
        };

        if (dwIterType instanceof IterType) {
            if (!looseMatch(dwFnType.paramTypes[0], dwIterType.innerType)) return null;
            return {
                kind: "builtin",
                returnType: new IterType(dwIterType.innerType),
                toJS,
            };
        }
        if (dwIterType instanceof ArrayType || dwIterType instanceof MutArrType) {
            if (!looseMatch(dwFnType.paramTypes[0], dwIterType.innerType)) return null;
            return {
                kind: "builtin",
                returnType: new IterType(dwIterType.innerType),
                toJS,
            };
        }
        if (dwIterType === "Str") {
            if (!looseMatch(dwFnType.paramTypes[0], "Str")) return null;
            return {
                kind: "builtin",
                returnType: new IterType("Str"),
                toJS,
            };
        }
        return null;
    },
    trans: (args, argTypes) => {
        if (argTypes.length !== 1) return null;
        if (argTypes[0] instanceof ArrayType) {
            return {
                kind: "builtin",
                returnType: new MutArrType(argTypes[0].innerType),
                toJS: (writer) => {
                    writer.write("[...");
                    args[0]?.toJS(writer);
                    writer.write("]");
                },
            };
        }
        if (argTypes[0] instanceof DictType) {
            return {
                kind: "builtin",
                returnType: new MutDictType(argTypes[0].keyType, argTypes[0].valueType),
                toJS: (writer) => {
                    writer.write("new Map(");
                    args[0]?.toJS(writer);
                    writer.write(")");
                },
            };
        }
        if (argTypes[0] instanceof SetType) {
            return {
                kind: "builtin",
                returnType: new MutSetType(argTypes[0].innerType),
                toJS: (writer) => {
                    writer.write("new Set(");
                    args[0]?.toJS(writer);
                    writer.write(")");
                },
            };
        }
        return null;
    },
    unsafeTrans: (args, argTypes) => {
        if (argTypes.length !== 1) return null;
        if (argTypes[0] instanceof ArrayType) {
            return {
                kind: "builtin",
                returnType: new MutArrType(argTypes[0].innerType),
                toJS: (writer) => {
                    args[0]?.toJS(writer);
                },
            };
        }
        if (argTypes[0] instanceof DictType) {
            return {
                kind: "builtin",
                returnType: new MutDictType(argTypes[0].keyType, argTypes[0].valueType),
                toJS: (writer) => {
                    args[0]?.toJS(writer);
                },
            };
        }
        if (argTypes[0] instanceof SetType) {
            return {
                kind: "builtin",
                returnType: new MutSetType(argTypes[0].innerType),
                toJS: (writer) => {
                    args[0]?.toJS(writer);
                },
            };
        }
        return null;
    },
    detrans: (args, argTypes) => {
        if (argTypes.length !== 1) return null;
        if (argTypes[0] instanceof MutArrType) {
            return {
                kind: "builtin",
                returnType: new ArrayType(argTypes[0].innerType),
                toJS: (writer) => {
                    args[0]?.toJS(writer);
                },
            };
        }
        if (argTypes[0] instanceof MutDictType) {
            return {
                kind: "builtin",
                returnType: new DictType(argTypes[0].keyType, argTypes[0].valueType),
                toJS: (writer) => {
                    args[0]?.toJS(writer);
                },
            };
        }
        if (argTypes[0] instanceof MutSetType) {
            return {
                kind: "builtin",
                returnType: new SetType(argTypes[0].innerType),
                toJS: (writer) => {
                    args[0]?.toJS(writer);
                },
            };
        }
        return null;
    },
    push: (args, argTypes) => {
        if (argTypes.length !== 2) return null;
        if (argTypes[1] instanceof MutArrType) {
            const [valueType, mutArrType] = argTypes;
            if (!looseMatch(mutArrType.innerType, valueType)) return null;
            return {
                kind: "builtin",
                returnType: mutArrType,
                toJS: (writer) => {
                    writer.useBuiltin("$push$");
                    writer.write("$push$(");
                    args[0]?.toJS(writer);
                    writer.write(", ");
                    args[1]?.toJS(writer);
                    writer.write(")");
                },
            };
        }
        if (argTypes[1] instanceof MutSetType) {
            const [valueType, mutSetType] = argTypes;
            if (!looseMatch(mutSetType.innerType, valueType)) return null;
            return {
                kind: "builtin",
                returnType: mutSetType,
                toJS: (writer) => {
                    writer.useBuiltin("$pushMutSet$");
                    writer.write("$pushMutSet$(");
                    args[0]?.toJS(writer);
                    writer.write(", ");
                    args[1]?.toJS(writer);
                    writer.write(")");
                },
            };
        }
        return null;
    },
    put: (args, argTypes) => {
        if (argTypes.length !== 3) return null;
        if (argTypes[2] instanceof MutArrType) {
            const [valueType, indexType, mutArrType] = argTypes;
            if (indexType !== "Int" && indexType !== "Num") return null;
            if (!looseMatch(mutArrType.innerType, valueType)) return null;
            return {
                kind: "builtin",
                returnType: mutArrType,
                toJS: (writer) => {
                    writer.useBuiltin("$put$");
                    writer.write("$put$(");
                    args[0]?.toJS(writer);
                    writer.write(", ");
                    args[1]?.toJS(writer);
                    writer.write(", ");
                    args[2]?.toJS(writer);
                    writer.write(")");
                },
            };
        }
        if (argTypes[2] instanceof MutDictType) {
            const [valueType, keyType, mutDictType] = argTypes;
            if (!looseMatch(mutDictType.keyType, keyType)) return null;
            if (!looseMatch(mutDictType.valueType, valueType)) return null;
            return {
                kind: "builtin",
                returnType: mutDictType,
                toJS: (writer) => {
                    writer.useBuiltin("$putMutDict$");
                    writer.write("$putMutDict$(");
                    args[0]?.toJS(writer);
                    writer.write(", ");
                    args[1]?.toJS(writer);
                    writer.write(", ");
                    args[2]?.toJS(writer);
                    writer.write(")");
                },
            };
        }
        return null;
    },
    pop: (args, argTypes) => {
        if (argTypes.length !== 1) return null;
        if (argTypes[0] instanceof MutArrType) {
            return {
                kind: "builtin",
                returnType: argTypes[0],
                toJS: (writer) => {
                    writer.useBuiltin("$pop$");
                    writer.write("$pop$(");
                    args[0]?.toJS(writer);
                    writer.write(")");
                },
            };
        }
        return null;
    },
    remove: (args, argTypes) => {
        if (argTypes.length !== 2) return null;
        if (argTypes[1] instanceof MutDictType) {
            const [keyType, mutDictType] = argTypes;
            if (!looseMatch(mutDictType.keyType, keyType)) return null;
            return {
                kind: "builtin",
                returnType: mutDictType,
                toJS: (writer) => {
                    writer.useBuiltin("$removeMutDict$");
                    writer.write("$removeMutDict$(");
                    args[0]?.toJS(writer);
                    writer.write(", ");
                    args[1]?.toJS(writer);
                    writer.write(")");
                },
            };
        }
        if (argTypes[1] instanceof MutSetType) {
            const [valueType, mutSetType] = argTypes;
            if (!looseMatch(mutSetType.innerType, valueType)) return null;
            return {
                kind: "builtin",
                returnType: mutSetType,
                toJS: (writer) => {
                    writer.useBuiltin("$removeMutSet$");
                    writer.write("$removeMutSet$(");
                    args[0]?.toJS(writer);
                    writer.write(", ");
                    args[1]?.toJS(writer);
                    writer.write(")");
                },
            };
        }
        return null;
    },
    Dict: (args, argTypes) => {
        if (argTypes.length !== 1) return null;
        const hmArg = argTypes[0];
        if (!(hmArg instanceof ArrayType)) return null;
        if (!(hmArg.innerType instanceof TupleType)) return null;
        if (hmArg.innerType.types.length !== 2) return null;
        const [keyType, valueType] = hmArg.innerType.types;
        return {
            kind: "builtin",
            returnType: new DictType(keyType, valueType),
            toJS: (writer) => {
                writer.write("new Map(");
                args[0]?.toJS(writer);
                writer.write(")");
            },
        };
    },
    Set: (args, argTypes) => {
        if (argTypes.length !== 1) return null;
        const hsArg = argTypes[0];
        if (!(hsArg instanceof ArrayType)) return null;
        return {
            kind: "builtin",
            returnType: new SetType(hsArg.innerType),
            toJS: (writer) => {
                writer.write("new Set(");
                args[0]?.toJS(writer);
                writer.write(")");
            },
        };
    },
    contains: (args, argTypes) => {
        if (argTypes.length !== 2) return null;
        const [cValue, cContainer] = argTypes;

        const iterToJS = (writer: JSWriter) => {
            writer.useBuiltin("$contains$");
            writer.write("$contains$(");
            args[0].toJS(writer);
            writer.write(", ");
            args[1].toJS(writer);
            writer.write(")");
        };
        const arrToJS = (writer: JSWriter) => {
            args[1].toJS(writer);
            writer.write(".indexOf(");
            args[0].toJS(writer);
            writer.write(") !== -1");
        };
        const setOrMapToJS = (writer: JSWriter) => {
            args[1].toJS(writer);
            writer.write(".has(");
            args[0].toJS(writer);
            writer.write(")");
        };
        const strToJS = (writer: JSWriter) => {
            args[1].toJS(writer);
            writer.write(".includes(");
            args[0].toJS(writer);
            writer.write(")");
        };

        if (cContainer instanceof SetType || cContainer instanceof MutSetType) {
            if (cValue !== cContainer.innerType) return null;
            return {
                kind: "builtin",
                returnType: "Bool",
                toJS: setOrMapToJS,
            };
        }
        if (cContainer instanceof ArrayType || cContainer instanceof MutArrType) {
            if (cValue !== cContainer.innerType) return null;
            return {
                kind: "builtin",
                returnType: "Bool",
                toJS: arrToJS,
            };
        }
        if (cContainer instanceof IterType) {
            if (cValue !== cContainer.innerType) return null;
            return {
                kind: "builtin",
                returnType: "Bool",
                toJS: iterToJS,
            };
        }
        if (cContainer instanceof DictType || cContainer instanceof MutDictType) {
            if (cValue !== cContainer.keyType) return null;
            return {
                kind: "builtin",
                returnType: "Bool",
                toJS: setOrMapToJS,
            };
        }
        if (cContainer === "Str") {
            if (cValue !== "Str") return null;
            return {
                kind: "builtin",
                returnType: "Bool",
                toJS: strToJS,
            };
        }
        return null;
    },
    find: (args, argTypes) => {
        if (argTypes.length !== 2) return null;
        const [fValue, fContainer] = argTypes;

        const arrOrStrToJS = (writer: JSWriter) => {
            writer.write("((i) => i === -1 ? null : i)(");
            args[1]?.toJS(writer);
            writer.write(".indexOf(");
            args[0]?.toJS(writer);
            writer.write("))");
        };
        const iterToJS = (writer: JSWriter) => {
            writer.useBuiltin("$find$");
            writer.write("$find$(");
            args[0]?.toJS(writer);
            writer.write(", ");
            args[1].toJS(writer);
            writer.write(")");
        };

        if (fContainer instanceof ArrayType || fContainer instanceof MutArrType) {
            if (!typeEquals(fContainer.innerType, fValue)) return null;
            return {
                kind: "builtin",
                returnType: new MaybeType("Num"),
                toJS: arrOrStrToJS,
            };
        }
        if (fContainer instanceof IterType) {
            if (!typeEquals(fContainer.innerType, fValue)) return null;
            return {
                kind: "builtin",
                returnType: new MaybeType("Num"),
                toJS: iterToJS,
            };
        }
        if (fContainer === "Str" && fValue === "Str") {
            return {
                kind: "builtin",
                returnType: new MaybeType("Num"),
                toJS: arrOrStrToJS,
            };
        }
        return null;
    },
    split: (args, argTypes) => {
        if (argTypes.length !== 2) return null;
        if (argTypes[0] === "Str" && argTypes[1] === "Str") {
            return {
                kind: "builtin",
                returnType: new ArrayType("Str"),
                toJS: (writer) => {
                    args[1]?.toJS(writer);
                    writer.write(".split(");
                    args[0]?.toJS(writer);
                    writer.write(")");
                },
            };
        }
        return null;
    },
    replace: (args, argTypes) => {
        if (argTypes.length !== 3) return null;
        if (argTypes[0] === "Str" && argTypes[1] === "Str" && argTypes[2] === "Str") {
            return {
                kind: "builtin",
                returnType: "Str",
                toJS: (writer) => {
                    args[2]?.toJS(writer);
                    writer.write(".replaceAll(");
                    args[0]?.toJS(writer);
                    writer.write(", ");
                    args[1]?.toJS(writer);
                    writer.write(")");
                },
            };
        }
        return null;
    },
    union: (args, argTypes) => {
        if (argTypes.length !== 2) return null;
        if (
            argTypes[0] instanceof SetType &&
            argTypes[1] instanceof SetType &&
            typeEquals(argTypes[0].innerType, argTypes[1].innerType)
        ) {
            return {
                kind: "builtin",
                returnType: argTypes[0],
                toJS: (writer) => {
                    writer.write("new Set([...");
                    args[0]?.toJS(writer);
                    writer.write(", ...");
                    args[1]?.toJS(writer);
                    writer.write("])");
                },
            };
        }
        return null;
    },
    intersect: (args, argTypes) => {
        if (argTypes.length !== 2) return null;
        if (
            argTypes[0] instanceof SetType &&
            argTypes[1] instanceof SetType &&
            typeEquals(argTypes[0].innerType, argTypes[1].innerType)
        ) {
            return {
                kind: "builtin",
                returnType: argTypes[0],
                toJS: (writer) => {
                    writer.write("new Set([...");
                    args[0]?.toJS(writer);
                    writer.write("].filter(x => ");
                    args[1]?.toJS(writer);
                    writer.write(".has(x)))");
                },
            };
        }
        return null;
    },
    zip: (args, argTypes) => {
        if (argTypes.length < 2) return null;
        for (const t of argTypes) {
            if (
                !(t instanceof IterType) &&
                !(t instanceof ArrayType) &&
                !(t instanceof MutArrType) &&
                t !== "Str"
            )
                return null;
        }
        const innerTypes: Type[] = argTypes.map((t) => {
            if (t instanceof IterType) return t.innerType;
            if (t instanceof ArrayType) return t.innerType;
            if (t instanceof MutArrType) return t.innerType;
            return "Str";
        });
        const toJS = (writer: JSWriter) => {
            writer.useBuiltin("$ZipIterator$");
            writer.write("new $ZipIterator$(");
            args.forEach((arg, i) => {
                if (i > 0) writer.write(", ");
                wrapArrayToIter(writer, arg);
            });
            writer.write(")");
        };
        return {
            kind: "builtin",
            returnType: new IterType(new TupleType(innerTypes)),
            toJS,
        };
    },
    repeat: (args, argTypes) => {
        if (argTypes.length !== 2) return null;
        const [repeatCount, repeatInner] = argTypes;
        if (repeatCount !== "Int" && repeatCount !== "Num") return null;
        const toJS = (writer: JSWriter) => {
            writer.useBuiltin("$RepeatIterator$");
            if (args[0]?.type === "Num") {
                writer.write("new $RepeatIterator$(");
                args[0]?.toJS(writer);
                writer.write(", ");
            } else if (args[0]?.type === "Int") {
                writer.write("new $RepeatIterator$(Number(");
                args[0]?.toJS(writer);
                writer.write("), ");
            } else {
                throw new Error(`Got unexpected type ${args[0]?.type} in repeat iterator`);
            }
            wrapArrayToIter(writer, args[1]);
            writer.write(")");
        };
        if (
            repeatInner instanceof IterType ||
            repeatInner instanceof ArrayType ||
            repeatInner instanceof MutArrType
        ) {
            return {
                kind: "builtin",
                returnType: new IterType(repeatInner.innerType),
                toJS,
            };
        }
        if (repeatInner === "Str") {
            return {
                kind: "builtin",
                returnType: new IterType("Str"),
                toJS,
            };
        }
        return null;
    },
    repeatInner: (args, argTypes) => {
        if (argTypes.length !== 2) return null;
        const [riCount, riInner] = argTypes;
        if (riCount !== "Int" && riCount !== "Num") return null;
        const toJS = (writer: JSWriter) => {
            writer.useBuiltin("$RepeatInnerIterator$");
            if (args[0]?.type === "Num") {
                writer.write("new $RepeatInnerIterator$(");
                args[0]?.toJS(writer);
                writer.write(", ");
            } else if (args[0]?.type === "Int") {
                writer.write("new $RepeatInnerIterator$(Number(");
                args[0]?.toJS(writer);
                writer.write("), ");
            } else {
                throw new Error(`Got unexpected type ${args[0]?.type} in repeatInner iterator`);
            }
            wrapArrayToIter(writer, args[1]);
            writer.write(")");
        };
        if (
            riInner instanceof IterType ||
            riInner instanceof ArrayType ||
            riInner instanceof MutArrType
        ) {
            return {
                kind: "builtin",
                returnType: new IterType(riInner.innerType),
                toJS,
            };
        }
        if (riInner === "Str") {
            return {
                kind: "builtin",
                returnType: new IterType("Str"),
                toJS,
            };
        }
        return null;
    },
    cartesian: (args, argTypes) => {
        if (argTypes.length < 2) return null;
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
            return null;
        }
        const toJS = (writer: JSWriter) => {
            writer.useBuiltin("$CartesianIterator$");
            writer.write("new $CartesianIterator$(");
            args.forEach((arg, i) => {
                if (i > 0) writer.write(", ");
                wrapArrayToIter(writer, arg);
            });
            writer.write(")");
        };
        return {
            kind: "builtin",
            returnType: new IterType(new TupleType(innerTypes)),
            toJS,
        };
    },
    permutations: (args, argTypes) => {
        if (argTypes.length !== 1) return null;
        const permInner = argTypes[0];
        const toJS = (writer: JSWriter) => {
            writer.useBuiltin("$PermutationsIterator$");
            writer.write("new $PermutationsIterator$(");
            args[0]?.toJS(writer);
            if (
                args[0]?.type instanceof ArrayType ||
                args[0]?.type instanceof MutArrType ||
                args[0]?.type === "Str"
            ) {
                writer.write(", true)");
            } else {
                writer.write(")");
            }
        };
        if (
            permInner instanceof IterType ||
            permInner instanceof ArrayType ||
            permInner instanceof MutArrType
        ) {
            const pInner =
                permInner instanceof IterType ? permInner.innerType : permInner.innerType;
            return {
                kind: "builtin",
                returnType: new IterType(new ArrayType(pInner)),
                toJS,
            };
        }
        return null;
    },
    combinations: (args, argTypes) => {
        if (argTypes.length !== 2) return null;
        const [combN, combIter] = argTypes;
        if (combN !== "Num" && combN !== "Int") return null;
        const toJS = (writer: JSWriter) => {
            writer.useBuiltin("$CombinationsIterator$");
            if (args[0]?.type === "Num") {
                writer.write("new $CombinationsIterator$(");
                args[0]?.toJS(writer);
                writer.write(", ");
            } else if (args[0]?.type === "Int") {
                writer.write("new $CombinationsIterator$(Number(");
                args[0]?.toJS(writer);
                writer.write("), ");
            } else {
                throw new Error(`Got unexpected type ${args[0]?.type} in combinations iterator`);
            }
            args[1]?.toJS(writer);
            if (
                args[1]?.type instanceof ArrayType ||
                args[1]?.type instanceof MutArrType ||
                args[1]?.type === "Str"
            ) {
                writer.write(", true)");
            } else {
                writer.write(")");
            }
        };
        if (
            combIter instanceof IterType ||
            combIter instanceof ArrayType ||
            combIter instanceof MutArrType
        ) {
            const cInner = combIter instanceof IterType ? combIter.innerType : combIter.innerType;
            return {
                kind: "builtin",
                returnType: new IterType(new ArrayType(cInner)),
                toJS,
            };
        }
        return null;
    },
    toIter: (args, argTypes) => {
        if (argTypes.length !== 1) return null;
        const tiInner = argTypes[0];
        if (tiInner instanceof ArrayType || tiInner instanceof MutArrType) {
            return {
                kind: "builtin",
                returnType: new IterType(tiInner.innerType),
                toJS: (writer) => {
                    writer.useBuiltin("$ArrayIterator$");
                    writer.write("new $ArrayIterator$(");
                    args[0]?.toJS(writer);
                    writer.write(")");
                },
            };
        }
        if (tiInner instanceof DictType || tiInner instanceof MutDictType) {
            return {
                kind: "builtin",
                returnType: new IterType(new TupleType([tiInner.keyType, tiInner.valueType])),
                toJS: (writer) => {
                    writer.useBuiltin("$ArrayIterator$");
                    writer.write("new $ArrayIterator$([...");
                    args[0]?.toJS(writer);
                    writer.write("])");
                },
            };
        }
        if (tiInner instanceof SetType || tiInner instanceof MutSetType) {
            return {
                kind: "builtin",
                returnType: new IterType(tiInner.innerType),
                toJS: (writer) => {
                    writer.useBuiltin("$ArrayIterator$");
                    writer.write("new $ArrayIterator$([...");
                    args[0]?.toJS(writer);
                    writer.write("])");
                },
            };
        }
        if (tiInner === "Str") {
            return {
                kind: "builtin",
                returnType: new IterType("Str"),
                toJS: (writer) => {
                    writer.useBuiltin("$ArrayIterator$");
                    writer.write("new $ArrayIterator$(");
                    args[0]?.toJS(writer);
                    writer.write('.split("")');
                    writer.write(")");
                },
            };
        }
        return null;
    },
    toArr: (args, argTypes) => {
        if (argTypes.length !== 1) return null;
        const taInner = argTypes[0];
        if (taInner instanceof DictType || taInner instanceof MutDictType) {
            return {
                kind: "builtin",
                returnType: new ArrayType(new TupleType([taInner.keyType, taInner.valueType])),
                toJS: (writer) => {
                    writer.write("[...");
                    args[0]?.toJS(writer);
                    writer.write("]");
                },
            };
        }
        if (taInner instanceof SetType || taInner instanceof MutSetType) {
            return {
                kind: "builtin",
                returnType: new ArrayType(taInner.innerType),
                toJS: (writer) => {
                    writer.write("[...");
                    args[0]?.toJS(writer);
                    writer.write("]");
                },
            };
        }
        if (taInner === "Str") {
            return {
                kind: "builtin",
                returnType: new ArrayType("Str"),
                toJS: (writer) => {
                    args[0]?.toJS(writer);
                    writer.write('.split("")');
                },
            };
        }
        return null;
    },
    unwrap: (args, argTypes) => {
        if (argTypes.length < 1 || argTypes.length > 2) return null;
        if (argTypes.length === 2) {
            if (!(argTypes[1] instanceof MaybeType)) return null;
            const innerType = argTypes[1].innerType;
            if (!typeEquals(innerType, argTypes[0])) return null;
            return {
                kind: "builtin",
                returnType: innerType,
                toJS: (writer) => {
                    writer.useBuiltin("$unwrapWithFallback$");
                    writer.write("$unwrapWithFallback$(");
                    args[0].toJS(writer);
                    writer.write(", ");
                    args[1].toJS(writer);
                    writer.write(")");
                },
            };
        }
        if (!(argTypes[0] instanceof MaybeType)) return null;
        return {
            kind: "builtin",
            returnType: argTypes[0].innerType,
            toJS: (writer) => {
                writer.useBuiltin("$unwrapNoFallback$");
                writer.write("$unwrapNoFallback$(");
                args[0].toJS(writer);
                writer.write(")");
            },
        };
    },
    isnone: (args, argTypes) => {
        if (argTypes.length !== 1) return null;
        if (!(argTypes[0] instanceof MaybeType)) return null;
        return {
            kind: "builtin",
            returnType: "Bool",
            toJS: (writer) => {
                args[0]?.toJS(writer);
                writer.write(" === null");
            },
        };
    },
    some: (args, argTypes) => {
        if (argTypes.length !== 1) return null;
        return {
            kind: "builtin",
            returnType: new MaybeType(argTypes[0]),
            toJS: (writer) => {
                args[0].toJS(writer);
            },
        };
    },
    toStr: (args, argTypes) => {
        if (argTypes.length !== 1) return null;
        if (argTypes[0] === "Int" || argTypes[0] === "Num" || argTypes[0] === "Bool") {
            return {
                kind: "builtin",
                returnType: "Str",
                toJS: (writer) => {
                    writer.write("String(");
                    args[0]?.toJS(writer);
                    writer.write(")");
                },
            };
        }
        return null;
    },
    toInt: (args, argTypes) => {
        if (argTypes.length !== 1) return null;
        if (argTypes[0] === "Num" || argTypes[0] === "Bool") {
            return {
                kind: "builtin",
                returnType: "Int",
                toJS: (writer) => {
                    if (args[0]?.type === "Num") {
                        writer.write("BigInt(Math.trunc(");
                        args[0]?.toJS(writer);
                        writer.write("))");
                    } else {
                        writer.write("BigInt(");
                        args[0]?.toJS(writer);
                        writer.write(")");
                    }
                },
            };
        }
        return null;
    },
    toNum: (args, argTypes) => {
        if (argTypes.length !== 1) return null;
        if (argTypes[0] === "Int") {
            return {
                kind: "builtin",
                returnType: "Num",
                toJS: (writer) => {
                    writer.write("Number(");
                    args[0]?.toJS(writer);
                    writer.write(")");
                },
            };
        }
        return null;
    },
    toBool: (args, argTypes) => {
        if (argTypes.length !== 1) return null;
        if (argTypes[0] === "Int" || argTypes[0] === "Num" || argTypes[0] === "Str") {
            return {
                kind: "builtin",
                returnType: "Bool",
                toJS: (writer) => {
                    writer.write("Boolean(");
                    args[0]?.toJS(writer);
                    writer.write(")");
                },
            };
        }
        return null;
    },
};

export function findBuiltin(
    name: string,
    args: Expression[],
    argTypes: Type[]
): BuiltinResult | null {
    if (args.length !== argTypes.length) {
        throw new Error("Args need to match argTypes, but they have different lengths");
    }
    const resolver = BUILTIN_RESOLVERS[name];
    if (!resolver) {
        return null;
    }
    return resolver(args, argTypes);
}
