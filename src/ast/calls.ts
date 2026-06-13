import type { JSWriter } from "../write-js";
import { TokenType, type Token } from "../tokens";
import {
    ArrayType,
    IterType,
    MutArrType,
    TupleType,
    DictType,
    MutDictType,
    CustomType,
    FuncType,
    type Type,
    type CallableType,
    SetType,
    MutSetType,
} from "../types";
import { Expression } from "./expression";
import { Literal } from "./literals";
import { Variable, Function, AnonymousFunction, Assignment, Block } from "./nodes";
import { getStruct, isVarConsumed, markVarConsumed, findFunction } from "./registries";
import { findCaller } from "./caller";
import { paramTypesMatchArgTypes } from "./type-utils";
import { DropValue } from "./expression";

// ── Helpers ──

function findStructTypedVariable(
    _root: Expression,
    ancestors: Expression[],
    name: string
): { varName: string; structType: Type } | null {
    for (let i = ancestors.length - 1; i >= 0; i--) {
        const ancestor = ancestors[i];
        if (ancestor instanceof Function) {
            for (const param of ancestor.params) {
                if (param.name === name && param.type instanceof CustomType) {
                    const structInfo = getStruct(param.type.name);
                    if (structInfo) return { varName: name, structType: param.type };
                }
            }
        } else if (ancestor instanceof AnonymousFunction) {
            for (const param of ancestor.params) {
                if (param.name === name && param.type instanceof CustomType) {
                    const structInfo = getStruct(param.type.name);
                    if (structInfo) return { varName: name, structType: param.type };
                }
            }
        } else if (ancestor instanceof Block) {
            for (const expr of ancestor.expressions) {
                let e = expr;
                while (e instanceof DropValue) e = e.child;
                if (e instanceof Assignment && e.name === name) {
                    const varType = e.value.type;
                    if (varType instanceof CustomType) {
                        const structInfo = getStruct(varType.name);
                        if (structInfo) return { varName: name, structType: varType };
                    }
                }
            }
        }
    }
    return null;
}

function findStringTypedVariable(
    _root: Expression,
    ancestors: Expression[],
    name: string
): string | null {
    for (let i = ancestors.length - 1; i >= 0; i--) {
        const ancestor = ancestors[i];
        if (ancestor instanceof Function) {
            for (const param of ancestor.params) {
                if (param.name === name && param.type === "Str") {
                    return name;
                }
            }
        } else if (ancestor instanceof AnonymousFunction) {
            for (const param of ancestor.params) {
                if (param.name === name && param.type === "Str") {
                    return name;
                }
            }
        } else if (ancestor instanceof Block) {
            for (const expr of ancestor.expressions) {
                let e = expr;
                while (e instanceof DropValue) e = e.child;
                if (e instanceof Assignment && e.name === name) {
                    if (e.value.type === "Str") {
                        return name;
                    }
                }
            }
        }
    }
    return null;
}

// ── Call (named function call) ──

export class Call extends Expression {
    name: string;
    args: Expression[];
    keywordArgs: { name: string; value: Expression }[] = [];

    callerType?: CallableType;
    referToByName?: string;
    isStructFieldAccess: boolean = false;
    structFieldName: string = "";
    isStringIndexing: boolean = false;
    isTypeConversion: boolean = false;
    conversionJsExpr: ((arg: string) => string) | null = null;
    isBuiltin: boolean = false;
    builtinKind: string = "";

    constructor(nameToken: Token, args: Expression[]) {
        if (nameToken.type !== TokenType.Identifier) {
            throw new Error("call name must be an identifier");
        }
        super(nameToken.line, nameToken.col);
        this.name = nameToken.text;
        this.args = args;
    }

    cascadeTypes(ancestors: Expression[]): void {
        const positionalArgTypes = this.args.map((arg, i) => {
            arg.cascadeTypes([...ancestors, this]);
            if (arg.type === null) {
                throw this.error(`unable to resolve type of argument ${i + 1} in call`);
            }
            return arg.type;
        });

        const keywordInfos = this.keywordArgs.map((k) => {
            k.value.cascadeTypes([...ancestors, this]);
            if (k.value.type === null) {
                throw this.error(`unable to resolve type of keyword argument '${k.name}'`);
            }
            return { name: k.name, type: k.value.type, value: k.value };
        });

        // If keyword args exist, resolve to positional order FIRST
        if (this.keywordArgs.length > 0) {
            const totalArgs = this.args.length + keywordInfos.length;

            const structDef = getStruct(this.name);
            if (structDef) {
                const fieldNames = structDef.fields.map((f) => f.name);
                if (totalArgs !== fieldNames.length) {
                    throw this.error(
                        `struct ${this.name} constructor expects ${fieldNames.length} arguments, got ${totalArgs}`
                    );
                }
                const ordered: Expression[] = [];
                ordered.length = totalArgs;
                const usedPositions = new Set<number>();
                for (let pi = 0; pi < this.args.length; pi++) {
                    ordered[pi] = this.args[pi];
                    usedPositions.add(pi);
                }
                for (const kw of keywordInfos) {
                    const pos = fieldNames.indexOf(kw.name);
                    if (pos === -1) {
                        throw this.error(
                            `unknown field '${kw.name}' — struct ${this.name} has fields [${fieldNames.join(", ")}]`
                        );
                    }
                    if (usedPositions.has(pos)) {
                        throw this.error(
                            `argument for field '${kw.name}' was already provided positionally`
                        );
                    }
                    ordered[pos] = kw.value;
                    usedPositions.add(pos);
                }
                if (usedPositions.size !== totalArgs) {
                    throw this.error(`some arguments were not provided for struct ${this.name}`);
                }
                this.args = ordered;
                this.keywordArgs = [];
            } else {
                let prevAncestor: Expression | null = null;
                for (let ai = ancestors.length - 1; ai >= 0; ai--) {
                    const ancestor = ancestors[ai];
                    if (ancestor instanceof Block) {
                        const searchFor = prevAncestor ?? this;
                        const olderSiblings = ancestor.expressions.slice(
                            0,
                            ancestor.expressions.indexOf(searchFor)
                        );
                        for (let sj = olderSiblings.length - 1; sj >= 0; sj--) {
                            let sib = olderSiblings[sj];
                            while (sib instanceof DropValue) {
                                sib = sib.child;
                            }
                            if (
                                sib instanceof Function &&
                                sib.name === this.name &&
                                !sib.isGeneric &&
                                sib.params.length === totalArgs
                            ) {
                                const paramNames = sib.params.map((p) => p.name);
                                const allKeywordsMatch = keywordInfos.every((kw) =>
                                    paramNames.includes(kw.name)
                                );
                                if (!allKeywordsMatch) {
                                    continue;
                                }
                                const ordered: Expression[] = [];
                                ordered.length = totalArgs;
                                const usedPositions = new Set<number>();
                                for (let pi = 0; pi < this.args.length; pi++) {
                                    ordered[pi] = this.args[pi];
                                    usedPositions.add(pi);
                                }
                                for (const kw of keywordInfos) {
                                    const pos = paramNames.indexOf(kw.name);
                                    if (usedPositions.has(pos)) {
                                        throw this.error(
                                            `argument '${kw.name}' was already provided by positional argument`
                                        );
                                    }
                                    ordered[pos] = kw.value;
                                    usedPositions.add(pos);
                                }
                                if (usedPositions.size !== totalArgs) {
                                    continue;
                                }
                                this.args = ordered;
                                this.keywordArgs = [];
                                ai = -1;
                                break;
                            }
                        }
                    }
                    prevAncestor = ancestor;
                }
            }
        }

        let allArgTypes: Type[];
        if (this.keywordArgs.length === 0) {
            allArgTypes = this.args.map((arg) => arg.type as Type);
        } else {
            allArgTypes = [...positionalArgTypes, ...keywordInfos.map((k) => k.type)];
        }

        const { error, result } = findCaller(this, ancestors, this.name, allArgTypes);
        if (error !== null) {
            // Struct field access fallback: varName("fieldName")
            if (
                allArgTypes.length === 1 &&
                allArgTypes[0] === "Str" &&
                this.args[0] instanceof Literal
            ) {
                const fieldName = this.args[0].value.slice(1, -1);
                const structVar = findStructTypedVariable(this, ancestors, this.name);
                if (structVar !== null) {
                    const structInfo =
                        structVar.structType instanceof CustomType
                            ? getStruct(structVar.structType.name)
                            : undefined;
                    if (structInfo) {
                        const field = structInfo.fields.find((f) => f.name === fieldName);
                        if (field) {
                            this.type = field.type;
                            this.referToByName = structVar.varName;
                            this.callerType = new FuncType(allArgTypes, field.type);
                            this.isStructFieldAccess = true;
                            this.structFieldName = fieldName;
                            return;
                        }
                        throw this.error(
                            `struct ${structInfo.name} has no field named "${fieldName}"`
                        );
                    }
                }
            }
            // String indexing fallback: strVar(index)
            if (allArgTypes.length === 1 && allArgTypes[0] === "Int") {
                const stringVarType = findStringTypedVariable(this, ancestors, this.name);
                if (stringVarType !== null) {
                    this.type = "Str";
                    this.referToByName = this.name;
                    this.isStringIndexing = true;
                    return;
                }
            }
            throw this.error(error);
        }

        // Handle the discriminated union result kind
        switch (result.kind) {
            case "type-conversion":
                this.isTypeConversion = true;
                this.conversionJsExpr = result.jsExpr;
                break;
            case "builtin":
                this.isBuiltin = true;
                this.builtinKind = result.builtinKind;
                // Track consumed variables for mutable operations
                if (
                    this.builtinKind === "detrans" ||
                    this.builtinKind === "detransDict" ||
                    this.builtinKind === "detransSet"
                ) {
                    const detransArg = this.args[0];
                    if (detransArg instanceof Variable && detransArg.fullName) {
                        markVarConsumed(detransArg.fullName);
                    }
                }
                if (
                    this.builtinKind === "push" ||
                    this.builtinKind === "put" ||
                    this.builtinKind === "putDict" ||
                    this.builtinKind === "removeDict" ||
                    this.builtinKind === "pushSet" ||
                    this.builtinKind === "removeSet"
                ) {
                    const mutArg = this.args[0];
                    if (mutArg instanceof Variable && mutArg.fullName) {
                        if (isVarConsumed(mutArg.fullName)) {
                            throw this.error(
                                `cannot use variable '${mutArg.fullName}' after it was detrans'd`
                            );
                        }
                    }
                }
                break;
        }

        this.referToByName = result.referToByName;
        this.callerType = result.callerType;
        this.type = result.rootType;

        // Tuple literal index resolution: tup(0) → exact element type at index 0
        if (
            this.callerType instanceof TupleType &&
            this.args.length === 1 &&
            this.args[0] instanceof Literal &&
            this.args[0].type === "Int"
        ) {
            const idx = parseInt(this.args[0].value, 10);
            if (idx >= 0 && idx < this.callerType.types.length) {
                this.type = this.callerType.types[idx];
            } else {
                throw this.error(
                    `tuple index ${idx} out of bounds (length ${this.callerType.types.length})`
                );
            }
        }

        // Keyword arg resolution via trait param names
        if (
            this.keywordArgs.length > 0 &&
            this.args.length < positionalArgTypes.length + keywordInfos.length &&
            result.kind === "function" &&
            result.paramNames
        ) {
            const totalArgs = positionalArgTypes.length + keywordInfos.length;
            if (totalArgs !== result.paramNames.length) {
                throw this.error(
                    `trait function ${this.name} expects ${result.paramNames.length} arguments, got ${totalArgs}`
                );
            }
            const ordered: Expression[] = [];
            ordered.length = totalArgs;
            const usedPositions = new Set<number>();
            for (let pi = 0; pi < this.args.length; pi++) {
                ordered[pi] = this.args[pi];
                usedPositions.add(pi);
            }
            for (const kw of keywordInfos) {
                const pos = result.paramNames.indexOf(kw.name);
                if (pos === -1) {
                    throw this.error(
                        `unknown keyword argument '${kw.name}' — ${this.name} (via trait) expects parameters [${result.paramNames.join(", ")}]`
                    );
                }
                if (usedPositions.has(pos)) {
                    throw this.error(
                        `argument '${kw.name}' was already provided by positional argument`
                    );
                }
                ordered[pos] = kw.value;
                usedPositions.add(pos);
            }
            if (usedPositions.size !== totalArgs) {
                throw this.error(`not all arguments were provided for function ${this.name}`);
            }
            this.args = ordered;
            this.keywordArgs = [];
        } else if (
            this.keywordArgs.length > 0 &&
            this.args.length < positionalArgTypes.length + keywordInfos.length &&
            (result.kind === "function" || result.kind === "struct-constructor")
        ) {
            const resolvedFn = findFunction(result.referToByName);
            if (
                resolvedFn &&
                resolvedFn.params.length === positionalArgTypes.length + keywordInfos.length
            ) {
                const paramNames = resolvedFn.params.map((p) => p.name);
                const totalArgs = positionalArgTypes.length + keywordInfos.length;
                const ordered: Expression[] = [];
                ordered.length = totalArgs;
                const usedPositions = new Set<number>();
                for (let pi = 0; pi < this.args.length; pi++) {
                    ordered[pi] = this.args[pi];
                    usedPositions.add(pi);
                }
                let allMatched = true;
                for (const kw of keywordInfos) {
                    const pos = paramNames.indexOf(kw.name);
                    if (pos === -1) {
                        allMatched = false;
                        break;
                    }
                    if (usedPositions.has(pos)) {
                        allMatched = false;
                        break;
                    }
                    ordered[pos] = kw.value;
                    usedPositions.add(pos);
                }
                if (allMatched && usedPositions.size === totalArgs) {
                    this.args = ordered;
                    this.keywordArgs = [];
                }
            }
        }
    }

    clone(bindings?: Map<string, Type>): Expression {
        const cloned = new Call(
            { line: this.line, col: this.col, text: this.name, type: TokenType.Identifier },
            this.args.map((a) => a.clone(bindings))
        );
        cloned.keywordArgs = this.keywordArgs.map((k) => ({
            name: k.name,
            value: k.value.clone(bindings),
        }));
        return cloned;
    }

    toJS(writer: JSWriter): void {
        if (this.referToByName === undefined) {
            throw new Error("caller name not resolved");
        }
        if (this.isStructFieldAccess) {
            writer.write(writer.safeName(this.referToByName!));
            writer.write(`.${this.structFieldName}`);
            return;
        }
        if (this.isTypeConversion && this.conversionJsExpr) {
            const jsExpr = this.conversionJsExpr;
            const conversionStr = jsExpr("%%ARG%%");
            const parts = conversionStr.split("%%ARG%%");
            writer.write(parts[0]);
            this.args[0].toJS(writer);
            if (parts.length > 1) {
                writer.write(parts[1]);
            }
            return;
        }
        if (this.isStringIndexing) {
            writer.write(writer.safeName(this.referToByName!));
            writer.write("[");
            this.args[0].toJS(writer);
            writer.write("]");
            return;
        }
        if (this.isBuiltin) {
            const wrapArg = (index: number): void => {
                const arg = this.args[index];
                if (arg && (arg.type instanceof ArrayType || arg.type instanceof MutArrType)) {
                    writer.useBuiltin("__ARRAYITER__");
                    writer.write("__ARRAYITER__(");
                    arg.toJS(writer);
                    writer.write(")");
                } else {
                    arg?.toJS(writer);
                }
            };
            switch (this.builtinKind) {
                case "collect":
                    writer.useBuiltin("__COLLECT__");
                    writer.write("__COLLECT__(");
                    wrapArg(0);
                    writer.write(")");
                    return;
                case "map":
                    writer.useBuiltin("__MAPITER__");
                    writer.write("__MAPITER__(");
                    this.args[0]?.toJS(writer);
                    writer.write(", ");
                    wrapArg(1);
                    writer.write(")");
                    return;
                case "mapFromArray":
                    writer.useBuiltin("__ARRAYMAPITER__");
                    writer.write("__ARRAYMAPITER__(");
                    this.args[0]?.toJS(writer);
                    writer.write(", ");
                    wrapArg(1);
                    writer.write(")");
                    return;
                case "filter":
                    writer.useBuiltin("__FILTERITER__");
                    writer.write("__FILTERITER__(");
                    this.args[0]?.toJS(writer);
                    writer.write(", ");
                    wrapArg(1);
                    writer.write(")");
                    return;
                case "reduce":
                    writer.useBuiltin("__REDUCE__");
                    writer.write("__REDUCE__(");
                    this.args[0]?.toJS(writer);
                    writer.write(", ");
                    this.args[1]?.toJS(writer);
                    writer.write(", ");
                    wrapArg(2);
                    writer.write(")");
                    return;
                case "range":
                    writer.useBuiltin("__RANGEITER__");
                    writer.write("__RANGEITER__(");
                    this.args.forEach((arg, i) => {
                        if (i > 0) writer.write(", ");
                        arg.toJS(writer);
                    });
                    writer.write(")");
                    return;
                case "zip":
                    writer.useBuiltin("__ZIP__");
                    writer.write("__ZIP__(");
                    this.args.forEach((arg, i) => {
                        if (i > 0) writer.write(", ");
                        wrapArg(i);
                    });
                    writer.write(")");
                    return;
                case "iterate":
                    writer.useBuiltin("__ITERATEITER__");
                    writer.write("__ITERATEITER__(");
                    this.args.forEach((arg, i) => {
                        if (i > 0) writer.write(", ");
                        arg.toJS(writer);
                    });
                    writer.write(")");
                    return;
                case "last":
                    if (
                        this.args[0]?.type instanceof ArrayType ||
                        this.args[0]?.type instanceof MutArrType
                    ) {
                        this.args[0].toJS(writer);
                        writer.write("[");
                        this.args[0].toJS(writer);
                        writer.write(".length - 1]");
                        return;
                    }
                    writer.useBuiltin("__LAST__");
                    writer.write("__LAST__(");
                    wrapArg(0);
                    writer.write(")");
                    return;
                case "length":
                    if (
                        this.args[0]?.type instanceof ArrayType ||
                        this.args[0]?.type instanceof MutArrType
                    ) {
                        writer.write("BigInt(");
                        this.args[0].toJS(writer);
                        writer.write(".length)");
                        return;
                    }
                    writer.useBuiltin("__LENGTH__");
                    writer.write("__LENGTH__(");
                    wrapArg(0);
                    writer.write(")");
                    return;
                case "take":
                    writer.useBuiltin("__TAKEITER__");
                    writer.write("__TAKEITER__(");
                    this.args[0]?.toJS(writer);
                    writer.write(", ");
                    wrapArg(1);
                    writer.write(")");
                    return;
                case "drop":
                    writer.useBuiltin("__DROPITER__");
                    writer.write("__DROPITER__(");
                    this.args[0]?.toJS(writer);
                    writer.write(", ");
                    wrapArg(1);
                    writer.write(")");
                    return;
                case "takeWhile":
                    writer.useBuiltin("__TAKEWHILEITER__");
                    writer.write("__TAKEWHILEITER__(");
                    this.args[0]?.toJS(writer);
                    writer.write(", ");
                    wrapArg(1);
                    writer.write(")");
                    return;
                case "dropWhile":
                    writer.useBuiltin("__DROPWHILEITER__");
                    writer.write("__DROPWHILEITER__(");
                    this.args[0]?.toJS(writer);
                    writer.write(", ");
                    wrapArg(1);
                    writer.write(")");
                    return;
                case "trans":
                    writer.write("[...");
                    this.args[0]?.toJS(writer);
                    writer.write("]");
                    return;
                case "unsafeTrans":
                    this.args[0]?.toJS(writer);
                    return;
                case "detrans":
                    this.args[0]?.toJS(writer);
                    return;
                case "transDict":
                    // trans on Dict: copy entries into a new Map
                    writer.write("new Map(");
                    this.args[0]?.toJS(writer);
                    writer.write(")");
                    return;
                case "unsafeTransDict":
                    // unsafeTrans on Dict: reuse same Map reference
                    this.args[0]?.toJS(writer);
                    return;
                case "detransDict":
                    // detrans on MutDict: return the Map as-is (Map is already mutable)
                    this.args[0]?.toJS(writer);
                    return;
                case "putDict":
                    // put on MutDict: set key/value and return MutDict for chaining
                    writer.useBuiltin("__PUT_MUTDICT__");
                    writer.write("__PUT_MUTDICT__(");
                    this.args[0]?.toJS(writer);
                    writer.write(", ");
                    this.args[1]?.toJS(writer);
                    writer.write(", ");
                    this.args[2]?.toJS(writer);
                    writer.write(")");
                    return;
                case "removeDict":
                    // remove on MutDict: delete key and return MutDict for chaining
                    writer.useBuiltin("__REMOVE_MUTDICT__");
                    writer.write("__REMOVE_MUTDICT__(");
                    this.args[0]?.toJS(writer);
                    writer.write(", ");
                    this.args[1]?.toJS(writer);
                    writer.write(")");
                    return;
                case "transSet":
                    // trans on Set: copy elements into a new Set
                    writer.write("new Set(");
                    this.args[0]?.toJS(writer);
                    writer.write(")");
                    return;
                case "unsafeTransSet":
                    // unsafeTrans on Set: reuse same Set reference
                    this.args[0]?.toJS(writer);
                    return;
                case "detransSet":
                    // detrans on MutSet: return the Set as-is (Set is already mutable)
                    this.args[0]?.toJS(writer);
                    return;
                case "pushSet":
                    // push on MutSet: add element and return MutSet for chaining
                    writer.useBuiltin("__PUSH_MUTSET__");
                    writer.write("__PUSH_MUTSET__(");
                    this.args[0]?.toJS(writer);
                    writer.write(", ");
                    this.args[1]?.toJS(writer);
                    writer.write(")");
                    return;
                case "removeSet":
                    // remove on MutSet: delete element and return MutSet for chaining
                    writer.useBuiltin("__REMOVE_MUTSET__");
                    writer.write("__REMOVE_MUTSET__(");
                    this.args[0]?.toJS(writer);
                    writer.write(", ");
                    this.args[1]?.toJS(writer);
                    writer.write(")");
                    return;
                case "push":
                    writer.useBuiltin("__PUSH__");
                    writer.write("__PUSH__(");
                    this.args[0]?.toJS(writer);
                    writer.write(", ");
                    this.args[1]?.toJS(writer);
                    writer.write(")");
                    return;
                case "put":
                    writer.useBuiltin("__PUT__");
                    writer.write("__PUT__(");
                    this.args[0]?.toJS(writer);
                    writer.write(", ");
                    this.args[1]?.toJS(writer);
                    writer.write(", ");
                    this.args[2]?.toJS(writer);
                    writer.write(")");
                    return;
                case "Dict":
                    writer.write("new Map(");
                    this.args[0]?.toJS(writer);
                    writer.write(")");
                    return;
                case "Set":
                    writer.write("new Set(");
                    this.args[0]?.toJS(writer);
                    writer.write(")");
                    return;
                case "contains":
                    this.args[0]?.toJS(writer);
                    if (
                        this.args[0]?.type instanceof ArrayType ||
                        this.args[0]?.type instanceof MutArrType
                    ) {
                        writer.write(".indexOf(");
                        this.args[1]?.toJS(writer);
                        writer.write(") !== -1");
                    } else if (
                        this.args[0]?.type instanceof SetType ||
                        this.args[0]?.type instanceof MutSetType
                    ) {
                        writer.write(".has(");
                        this.args[1]?.toJS(writer);
                        writer.write(")");
                    }
                    return;
                case "union":
                    writer.write("new Set([...");
                    this.args[0]?.toJS(writer);
                    writer.write(", ...");
                    this.args[1]?.toJS(writer);
                    writer.write("])");
                    return;
                case "intersect":
                    writer.write("new Set([...");
                    this.args[0]?.toJS(writer);
                    writer.write("].filter(x => ");
                    this.args[1]?.toJS(writer);
                    writer.write(".has(x)))");
                    return;
                default:
                    throw new Error(`unknown builtin: ${this.builtinKind}`);
            }
        }
        if (this.callerType instanceof FuncType) {
            const structInfo =
                this.type instanceof CustomType ? getStruct(this.type.name) : undefined;
            if (structInfo && this.name === structInfo.name) {
                writer.write("{");
                this.args.forEach((arg, i) => {
                    if (i > 0) {
                        writer.write(", ");
                    }
                    writer.write(`${structInfo.fields[i].name}: `);
                    arg.toJS(writer);
                });
                writer.write("}");
            } else {
                writer.write(writer.safeName(this.referToByName));
                writer.write("(");
                const calledFn = findFunction(this.referToByName);
                const iterParamIndices: number[] = [];
                if (calledFn) {
                    calledFn.params.forEach((p: { type: Type; name: string }, i: number) => {
                        if (p.type instanceof IterType && i < this.args.length) {
                            const argType = this.args[i].type;
                            if (argType instanceof ArrayType) {
                                iterParamIndices.push(i);
                            }
                        }
                    });
                }
                this.args.forEach((arg, i) => {
                    if (i > 0) {
                        writer.write(", ");
                    }
                    if (iterParamIndices.includes(i)) {
                        writer.useBuiltin("__ARRAYITER__");
                        writer.write("__ARRAYITER__(");
                        arg.toJS(writer);
                        writer.write(")");
                    } else {
                        arg.toJS(writer);
                    }
                });
                writer.write(")");
            }
        } else if (this.callerType instanceof IterType) {
            writer.useBuiltin("__ITER_GET__");
            writer.write("__ITER_GET__(");
            writer.write(writer.safeName(this.referToByName));
            writer.write(", ");
            this.args.forEach((arg, i) => {
                if (i > 0) {
                    writer.write(", ");
                }
                arg.toJS(writer);
            });
            writer.write(")");
        } else if (this.callerType instanceof TupleType) {
            writer.write(writer.safeName(this.referToByName));
            this.args.forEach((arg) => {
                writer.write("[");
                arg.toJS(writer);
                writer.write("]");
            });
        } else if (this.callerType instanceof DictType || this.callerType instanceof MutDictType) {
            writer.write(writer.safeName(this.referToByName));
            writer.write(".get(");
            this.args[0]?.toJS(writer);
            writer.write(")");
        } else if (this.callerType instanceof ArrayType || this.callerType instanceof MutArrType) {
            writer.write(writer.safeName(this.referToByName));
            this.args.forEach((arg) => {
                writer.write("[");
                arg.toJS(writer);
                writer.write("]");
            });
        } else {
            throw new Error(`unknown caller type: ${this.callerType}`);
        }
    }
}

// ── DirectCall (expression-based call, e.g., anon function call) ──

export class DirectCall extends Expression {
    caller: Expression;
    args: Expression[];
    keywordArgs: { name: string; value: Expression }[] = [];

    constructor(caller: Expression, args: Expression[]) {
        super(caller.line, caller.col);
        this.caller = caller;
        this.args = args;
    }

    cascadeTypes(ancestors: Expression[]): void {
        this.caller.cascadeTypes(ancestors);
        if (this.caller.type === null) {
            throw this.error("unable to resolve type of call");
        }
        if (this.caller.type instanceof FuncType) {
            const argTypes = this.args.map((arg, i) => {
                arg.cascadeTypes([...ancestors, this]);
                if (arg.type === null) {
                    throw this.error(
                        `unable to resolve type of argument ${i + 1} in function call`
                    );
                }
                return arg.type;
            });
            if (!paramTypesMatchArgTypes(this.caller.type.paramTypes, argTypes)) {
                throw this.error(
                    `incompatible argument types in function call: expected ${this.caller.type.paramTypes}, got ${argTypes}`
                );
            }
            this.type = this.caller.type.returnType;
            return;
        }
        if (this.caller.type instanceof ArrayType || this.caller.type instanceof MutArrType) {
            const incompatible = this.caller.type.checkIndicesCompatible(
                this.args.map((arg) => arg.type as Type)
            );
            if (incompatible !== null) {
                throw this.error(incompatible);
            }
            this.type = this.caller.type.innerType;
            return;
        }
        if (this.caller.type instanceof IterType) {
            this.args.forEach((arg, i) => {
                arg.cascadeTypes([...ancestors, this]);
                if (arg.type === null) {
                    throw this.error(`unable to resolve type of argument ${i + 1} in iter access`);
                }
            });
            const incompatible = this.caller.type.checkIndicesCompatible(
                this.args.map((arg) => arg.type as Type)
            );
            if (incompatible !== null) {
                throw this.error(incompatible);
            }
            this.type = this.caller.type.innerType;
            return;
        }
        if (this.caller.type === "Str") {
            this.args.forEach((arg, i) => {
                arg.cascadeTypes([...ancestors, this]);
                if (arg.type === null) {
                    throw this.error(
                        `unable to resolve type of argument ${i + 1} in string index access`
                    );
                }
            });
            if (this.args.length !== 1) {
                throw this.error(
                    `string indexing requires exactly one argument (the index), got ${this.args.length}`
                );
            }
            if (this.args[0].type !== "Int") {
                throw this.error(`string index must be of type Int`);
            }
            this.type = "Str";
            return;
        }

        if (this.caller.type instanceof TupleType) {
            this.args.forEach((arg, i) => {
                arg.cascadeTypes([...ancestors, this]);
                if (arg.type === null) {
                    throw this.error(
                        `unable to resolve type of argument ${i + 1} in tuple index access`
                    );
                }
            });
            const incompatible = this.caller.type.checkIndicesCompatible(
                this.args.map((arg) => arg.type as Type)
            );
            if (incompatible !== null) {
                throw this.error(incompatible);
            }
            // Resolve the exact element type for literal indices
            if (
                this.args.length === 1 &&
                this.args[0].type === "Int" &&
                this.args[0] instanceof Literal &&
                typeof this.args[0].value === "bigint"
            ) {
                const idx = Number(this.args[0].value);
                if (idx < 0 || idx >= this.caller.type.types.length) {
                    throw this.error(
                        `tuple index ${idx} out of bounds (tuple has ${this.caller.type.types.length} elements)`
                    );
                }
                this.type = this.caller.type.types[idx];
            } else {
                this.type = this.caller.type.types[0] ?? "Null";
            }
            return;
        }

        if (this.caller.type instanceof DictType || this.caller.type instanceof MutDictType) {
            this.args.forEach((arg, i) => {
                arg.cascadeTypes([...ancestors, this]);
                if (arg.type === null) {
                    throw this.error(`unable to resolve type of argument ${i + 1} in dict access`);
                }
            });
            const incompatible = this.caller.type.checkIndicesCompatible(
                this.args.map((arg) => arg.type as Type)
            );
            if (incompatible !== null) {
                throw this.error(incompatible);
            }
            this.type = this.caller.type.valueType;
            return;
        }

        // Struct field access: instance("fieldName")
        if (this.caller.type instanceof CustomType) {
            const structInfo = getStruct(this.caller.type.name);
            if (structInfo) {
                if (this.args.length !== 1) {
                    throw this.error(
                        `struct field access requires exactly one argument (the field name), got ${this.args.length}`
                    );
                }
                this.args[0].cascadeTypes([...ancestors, this]);
                if (this.args[0].type === null) {
                    throw this.error("unable to resolve type of field name argument");
                }
                if (this.args[0].type !== "Str" || !(this.args[0] instanceof Literal)) {
                    throw this.error(`struct field access requires a string literal field name`);
                }
                const fieldName = this.args[0].value;
                const cleanFieldName = fieldName.startsWith('"')
                    ? fieldName.slice(1, -1)
                    : fieldName;
                const field = structInfo.fields.find((f) => f.name === cleanFieldName);
                if (!field) {
                    throw this.error(
                        `struct ${this.caller.type.name} has no field named "${cleanFieldName}"`
                    );
                }
                this.type = field.type;
                return;
            }
        }
        throw this.error(
            `cannot call non-callable object (expression of type ${this.caller.type})`
        );
    }

    clone(bindings?: Map<string, Type>): Expression {
        const cloned = new DirectCall(
            this.caller.clone(bindings),
            this.args.map((a) => a.clone(bindings))
        );
        cloned.keywordArgs = this.keywordArgs.map((k) => ({
            name: k.name,
            value: k.value.clone(bindings),
        }));
        return cloned;
    }

    toJS(writer: JSWriter): void {
        if (this.caller.type === "Str") {
            this.caller.toJS(writer);
            writer.write("[");
            this.args[0].toJS(writer);
            writer.write("]");
        } else if (this.caller.type instanceof CustomType && getStruct(this.caller.type.name)) {
            const fieldName =
                this.args[0] instanceof Literal ? this.args[0].value.slice(1, -1) : "";
            writer.write("(");
            this.caller.toJS(writer);
            writer.write(`).${fieldName}`);
        } else if (this.caller.type instanceof IterType) {
            writer.useBuiltin("__ITER_GET__");
            writer.write("__ITER_GET__(");
            this.caller.toJS(writer);
            writer.write(", ");
            this.args.forEach((arg, i) => {
                if (i > 0) {
                    writer.write(", ");
                }
                arg.toJS(writer);
            });
            writer.write(")");
        } else {
            writer.write("(");
            this.caller.toJS(writer);
            writer.write(")");
            if (this.caller.type instanceof FuncType) {
                writer.write("(");
                this.args.forEach((arg, i) => {
                    if (i > 0) {
                        writer.write(", ");
                    }
                    arg.toJS(writer);
                });
                writer.write(")");
            } else if (
                this.caller.type instanceof ArrayType ||
                this.caller.type instanceof MutArrType
            ) {
                this.args.forEach((arg) => {
                    writer.write("[");
                    arg.toJS(writer);
                    writer.write("]");
                });
            } else if (this.caller.type instanceof TupleType) {
                this.args.forEach((arg) => {
                    writer.write("[");
                    arg.toJS(writer);
                    writer.write("]");
                });
            } else if (
                this.caller.type instanceof DictType ||
                this.caller.type instanceof MutDictType
            ) {
                writer.write(".get(");
                this.args[0]?.toJS(writer);
                writer.write(")");
            } else {
                throw new Error(`unknown caller type: ${this.caller.type}`);
            }
        }
    }
}
