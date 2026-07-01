import { TokenType, type Token } from "../tokens";
import type { JSWriter } from "../write-js";
import { findCaller } from "./caller-resolution";
import { DropValue, Expression } from "./expression";
import { Literal } from "./literals";
import { Assignment } from "./assignment";
import { Block } from "./expression";
import { AnonymousFunction, FunctionDef, RangeIter } from "./nodes";
import { typeEquals, paramTypesMatchArgTypes } from "./type-utils";
import {
    ArrayType,
    CustomType,
    DictType,
    FuncType,
    IterType,
    MaybeType,
    MutArrType,
    MutDictType,
    TupleType,
    type CallableType,
    type Type,
} from "./types";

// ── Helpers ──

/** Walk up parent chain to find a variable of struct type by name. */
function findStructTypedVariable(
    startNode: Expression,
    name: string
): { varName: string; structType: Type } | null {
    let node: Expression | null = startNode.parent;
    while (node) {
        if (node instanceof FunctionDef || node instanceof AnonymousFunction) {
            for (const param of node.params) {
                if (param.name === name && param.type instanceof CustomType) {
                    // Assume any CustomType could be a struct (scope will confirm during cascadeTypes)
                    return { varName: name, structType: param.type };
                }
            }
        } else if (node instanceof Block) {
            for (const expr of node.expressions) {
                let e = expr;
                while (e instanceof DropValue) e = e.child;
                if (e instanceof Assignment && e.name === name) {
                    const varType = e.value.type;
                    if (varType instanceof CustomType) {
                        return { varName: name, structType: varType };
                    }
                }
            }
        }
        node = node.parent;
    }
    return null;
}

/** Walk up parent chain to find a variable of string type by name. */
function findStringTypedVariable(startNode: Expression, name: string): string | null {
    let node: Expression | null = startNode.parent;
    while (node) {
        if (node instanceof FunctionDef || node instanceof AnonymousFunction) {
            for (const param of node.params) {
                if (param.name === name && param.type === "Str") {
                    return name;
                }
            }
        } else if (node instanceof Block) {
            for (const expr of node.expressions) {
                let e = expr;
                while (e instanceof DropValue) e = e.child;
                if (e instanceof Assignment && e.name === name) {
                    if (e.value.type === "Str") {
                        return name;
                    }
                }
            }
        }
        node = node.parent;
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
    isBuiltin: boolean = false;
    isStructFieldAccess: boolean = false;
    structFieldName: string = "";
    isStructConstructor: boolean = false;
    isStringIndexing: boolean = false;

    // This will be filled in during cascadeTypes when we resolve the caller
    toJSHelper: ((writer: JSWriter, args: Expression[]) => void) | null = null;

    constructor(nameToken: Token, args: Expression[]) {
        if (nameToken.type !== TokenType.Identifier) {
            throw new Error("call name must be an identifier");
        }
        super(nameToken.line, nameToken.col);
        this.name = nameToken.text;
        this.args = args;
    }

    cascadeTypes(parent: Expression | null, valueUsed: boolean): void {
        super.cascadeTypes(parent, valueUsed);
        // Pre-fill unresolved anonymous function params so findBuiltin can match them
        this.prefillLambdaParams();

        const positionalArgTypes = this.args.map((arg, i) => {
            arg.cascadeTypes(this, true);
            if (arg.type === null) {
                throw this.error(`unable to resolve type of argument ${i + 1} in call`);
            }
            return arg.type;
        });

        const keywordInfos = this.keywordArgs.map((k) => {
            k.value.cascadeTypes(this, true);
            if (k.value.type === null) {
                throw this.error(`unable to resolve type of keyword argument '${k.name}'`);
            }
            return { name: k.name, type: k.value.type, value: k.value };
        });

        const callScope = this.getScope();

        // If keyword args exist, resolve to positional order FIRST
        if (this.keywordArgs.length > 0) {
            const totalArgs = this.args.length + keywordInfos.length;

            // Resolve struct from scope, falling back to global registry
            let structDef:
                | { name: string; fields: { name: string; type: Type; mutable: boolean }[] }
                | undefined;
            if (callScope) {
                const lookup = callScope.lookup(this.name);
                if (lookup && lookup.attrs.class === "struct") {
                    structDef = { name: lookup.attrs.name, fields: lookup.attrs.fields };
                }
            }
            if (!structDef) {
                // struct not found in scope — not a struct constructor
            }
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
                // Search enclosing Blocks via parent pointers for a Function definition
                // that matches this call's name and can resolve keyword arguments.
                let child: Expression | null = null;
                let parent = this.parent;
                outer: while (parent) {
                    if (parent instanceof Block) {
                        const idx = parent.expressions.indexOf(child ?? this);
                        const olderSiblings = parent.expressions.slice(0, idx);
                        for (let sj = olderSiblings.length - 1; sj >= 0; sj--) {
                            let sib = olderSiblings[sj];
                            while (sib instanceof DropValue) {
                                sib = sib.child;
                            }
                            if (
                                sib instanceof FunctionDef &&
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
                                break outer;
                            }
                        }
                    }
                    child = parent;
                    parent = parent.parent;
                }
            }
        }

        let allArgTypes: Type[];
        if (this.keywordArgs.length === 0) {
            allArgTypes = this.args.map((arg) => arg.type as Type);
        } else {
            allArgTypes = [...positionalArgTypes, ...keywordInfos.map((k) => k.type)];
        }

        const { error, result } = findCaller(this, this.parent, this.name, allArgTypes);
        if (error !== null) {
            // Struct field access fallback: varName("fieldName")
            if (
                allArgTypes.length === 1 &&
                allArgTypes[0] === "Str" &&
                this.args[0] instanceof Literal
            ) {
                const fieldName = this.args[0].value.slice(1, -1);
                const structVar = findStructTypedVariable(this, this.name);
                if (structVar !== null) {
                    const structInfo =
                        structVar.structType instanceof CustomType
                            ? (() => {
                                  if (callScope) {
                                      const svLookup = callScope.lookup(structVar.structType.name);
                                      if (svLookup && svLookup.attrs.class === "struct") {
                                          return {
                                              name: svLookup.attrs.name,
                                              fields: svLookup.attrs.fields,
                                          };
                                      }
                                  }
                                  return undefined;
                              })()
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
            // TODO: What is this doing here? Why is string indexed access not handled with array indexed access?
            // String indexing fallback: strVar(index)
            if (
                allArgTypes.length === 1 &&
                (allArgTypes[0] === "Int" || allArgTypes[0] === "Num")
            ) {
                const stringVarType = findStringTypedVariable(this, this.name);
                if (stringVarType !== null) {
                    this.type = new MaybeType("Str");
                    this.referToByName = this.name;
                    this.isStringIndexing = true;
                    return;
                }
            }
            // String slicing fallback: strVar(a..b), strVar(..b), strVar(a..), strVar(..)
            if (
                allArgTypes.length === 1 &&
                allArgTypes[0] instanceof IterType &&
                (allArgTypes[0].innerType === "Int" || allArgTypes[0].innerType === "Num") &&
                this.args[0] instanceof RangeIter &&
                findStringTypedVariable(this, this.name) !== null
            ) {
                this.callerType = new FuncType(allArgTypes, "Str");
                this.type = "Str";
                this.referToByName = this.name;
                this.args[0].cascadeTypes(this, true);
                return;
            }
            throw this.error(error);
        }

        // Handle the discriminated union result kind
        switch (result.kind) {
            case "builtin":
                this.isBuiltin = true;
                this.toJSHelper = result.toJS;
                break;
        }

        this.referToByName = result.referToByName;
        this.callerType = result.callerType;
        this.type = result.kind === "variable" ? result.rootType : result.callerType.returnType;
        this.isStructConstructor = result.kind === "struct-constructor";

        // Fill unresolved anonymous function params using inferred types from context
        if (this.callerType instanceof FuncType) {
            // TODO: This doesn't currently work except for builtins
            this.fillAnonFunctionParams();
        }

        // Tuple literal index resolution: tup(0) → exact element type at index 0
        if (
            this.callerType instanceof TupleType &&
            this.args.length === 1 &&
            this.args[0] instanceof Literal &&
            (this.args[0].type === "Int" || this.args[0].type === "Num")
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
            this.args.length < positionalArgTypes.length + keywordInfos.length
        ) {
            // Use paramNames from the CallerResult if available (set by trait dispatch / direct match).
            const paramNames = (result as { paramNames?: string[] }).paramNames;
            if (paramNames && paramNames.length > 0) {
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
        } else {
            // No paramNames available — keyword args can't be resolved without function info.
            // This will be caught as a compile error by findCaller.
        }
    }

    /**
     * Before the main cascade, pre-fill lambda params for known builtins by
     * cascading the non-function args first to get their types.
     */
    private prefillLambdaParams(): void {
        // Find the anonymous function arg and the iterable arg
        // Normal call: map(fn, iter) → fn at 0, iter at 1
        // Pipe call: iter | map(fn) → iter at 0, fn at 1
        let anonFn: AnonymousFunction | null = null;
        let iterExpr: Expression | null = null;

        if (this.args[0] instanceof AnonymousFunction && this.args[0].needsInference) {
            anonFn = this.args[0];
            iterExpr = this.args.length >= 2 ? this.args[1] : null;
        } else if (
            this.args.length >= 2 &&
            this.args[1] instanceof AnonymousFunction &&
            this.args[1].needsInference
        ) {
            anonFn = this.args[1];
            iterExpr = this.args[0];
        }

        if (!anonFn) return;

        // Cascade the non-function args (everything except the anon function) first
        for (let i = 0; i < this.args.length; i++) {
            if (this.args[i] !== anonFn) {
                this.args[i].cascadeTypes(this, true);
            }
        }

        // Determine expected param types from the resolved args
        let expectedParamTypes: Type[] | null = null;

        if (this.name === "reduce" && iterExpr && this.args.length >= 3) {
            // reduce(fn, init, iter): fn params are (initType, elemType)
            const nonFnArgs = this.args.filter((a) => a !== anonFn);
            if (nonFnArgs.length >= 2 && nonFnArgs[0].type && nonFnArgs[1].type) {
                const iterType = nonFnArgs[1].type;
                const innerType =
                    iterType instanceof ArrayType ||
                    iterType instanceof IterType ||
                    iterType instanceof MutArrType
                        ? iterType.innerType
                        : iterType;
                expectedParamTypes = [nonFnArgs[0].type, innerType];
            }
        } else if (this.name === "iterate" && iterExpr && iterExpr.type) {
            expectedParamTypes = [iterExpr.type];
        } else if (
            ["map", "filter", "takeWhile", "dropWhile"].includes(this.name) &&
            iterExpr &&
            iterExpr.type
        ) {
            const iterType = iterExpr.type;
            const innerType =
                iterType instanceof ArrayType ||
                iterType instanceof IterType ||
                iterType instanceof MutArrType
                    ? iterType.innerType
                    : iterType;
            expectedParamTypes = [innerType];
        }

        if (expectedParamTypes !== null) {
            anonFn.fillParams(expectedParamTypes, this);
            return;
        }

        // Fallback: try to find a user-defined function by name in ancestor chain
        // and extract the expected function param type from its first parameter.
        const fnDef = this.findUserFunctionDef(this.args.slice(1).map((a) => a.type as Type));
        if (fnDef && fnDef.params.length > 0) {
            const firstParamType = fnDef.params[0].type;
            if (firstParamType instanceof FuncType && firstParamType.paramTypes.length > 0) {
                anonFn.fillParams(firstParamType.paramTypes, this);
            }
        }
    }

    /**
     * Search ancestor chain for a Function definition matching this call's name,
     * matching non-function args to narrow down overloads.
     */
    private findUserFunctionDef(
        otherArgTypes: Type[]
    ): { params: { name: string; type: Type }[]; returnType: Type } | null {
        let child: Expression | null = null;
        let parent = this.parent;
        while (parent) {
            if (parent instanceof Block) {
                const idx = parent.expressions.indexOf(child ?? this);
                const olderSiblings = parent.expressions.slice(0, idx);
                for (let j = olderSiblings.length - 1; j >= 0; j--) {
                    let sib = olderSiblings[j];
                    while (sib instanceof DropValue) sib = sib.child;
                    if (sib instanceof FunctionDef && sib.name === this.name && !sib.isGeneric) {
                        // Check that other arg types match (skip the function arg)
                        const fnParams = sib.params;
                        if (fnParams.length - 1 === otherArgTypes.length) {
                            let match = true;
                            for (let k = 0; k < otherArgTypes.length; k++) {
                                if (!typeEquals(otherArgTypes[k], fnParams[k + 1].type)) {
                                    match = false;
                                    break;
                                }
                            }
                            if (match) return { params: fnParams, returnType: sib.returnType };
                        }
                    }
                }
            }
            child = parent;
            parent = parent.parent;
        }
        return null;
    }

    /**
     * Fill unresolved anonymous function (lambda) params from the call context.
     * Derives expected param types based on the builtin kind and non-function args.
     */
    private fillAnonFunctionParams(): void {
        const anonFn = this.args[0];
        if (!(anonFn instanceof AnonymousFunction) || !anonFn.needsInference) return;

        // TODO: I intentionally commented this out, because I want to rework how this process works so that we attempt to resolve param types for any function call, not just builtin types

        // A lot of this is also just to deal with use-after-detrans errors, but I am intending to also get rid of that, too

        // let expectedParamTypes: Type[] | null = null;

        // // Determine expected param types from the builtin's semantics and other args
        // switch (this.builtinKind) {
        //     case "map":
        //     case "filter":
        //     case "takeWhile":
        //     case "dropWhile":
        //     case "mapFromArray": {
        //         // fn(param: innerType): ?
        //         if (this.args.length >= 2 && this.args[1].type) {
        //             const iterType = this.args[1].type;
        //             const innerType =
        //                 iterType instanceof ArrayType ||
        //                 iterType instanceof IterType ||
        //                 iterType instanceof MutArrType
        //                     ? iterType.innerType
        //                     : iterType;
        //             expectedParamTypes = [innerType];
        //         }
        //         break;
        //     }
        //     case "reduce": {
        //         // fn(acc: initType, elem: innerType): ?
        //         if (this.args.length >= 3 && this.args[2].type && this.args[1].type) {
        //             const iterType = this.args[2].type;
        //             const innerType =
        //                 iterType instanceof ArrayType ||
        //                 iterType instanceof IterType ||
        //                 iterType instanceof MutArrType
        //                     ? iterType.innerType
        //                     : iterType;
        //             expectedParamTypes = [this.args[1].type, innerType];
        //         }
        //         break;
        //     }
        //     case "iterate": {
        //         // fn(param: startType): startType
        //         if (this.args.length >= 2 && this.args[1].type) {
        //             expectedParamTypes = [this.args[1].type];
        //         }
        //         break;
        //     }
        // }

        // if (expectedParamTypes !== null) {
        //     anonFn.fillParams(expectedParamTypes, this);
        //     // Re-resolve the call with the now-resolved function type
        //     const resolvedArgTypes = this.args.map((arg) => arg.type as Type);
        //     const { error, result } = findCaller(this, this.parent, this.name, resolvedArgTypes);
        //     if (error === null) {
        //         this.callerType = result.callerType;
        //         this.type = result.rootType;
        //         this.referToByName = result.referToByName;
        //         this.isStructConstructor = result.kind === "struct-constructor";

        //         if (result.kind === "builtin") {
        //             this.isBuiltin = true;
        //             this.builtinKind = result.builtinKind;
        //         }
        //         // Re-check consumed vars with resolved result
        //         if (
        //             this.builtinKind === "detrans" ||
        //             this.builtinKind === "detransDict" ||
        //             this.builtinKind === "detransSet"
        //         ) {
        //             const detransArg = this.args[0];
        //             if (detransArg instanceof Variable && detransArg.fullName) {
        //                 const callScope = this.getScope();
        //                 if (callScope === null) {
        //                     // This should be impossible
        //                     throw new Error(
        //                         `Tried to mark a variable as consumed in a place with no enclosing scope.`
        //                     );
        //                 }
        //                 callScope.markVarConsumed(detransArg.fullName);
        //             }
        //         }
        //         if (
        //             this.builtinKind === "push" ||
        //             this.builtinKind === "put" ||
        //             this.builtinKind === "putDict" ||
        //             this.builtinKind === "removeDict" ||
        //             this.builtinKind === "pushSet" ||
        //             this.builtinKind === "removeSet"
        //         ) {
        //             const mutArg = this.args[0];
        //             if (mutArg instanceof Variable && mutArg.fullName) {
        //                 if (this.getScope()?.isVarConsumed(mutArg.fullName)) {
        //                     throw this.error(
        //                         `cannot use variable '${mutArg.fullName}' after it was detrans'd`
        //                     );
        //                 }
        //             }
        //         }
        //     }
        // }
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
        if (this.isStringIndexing) {
            writer.write(writer.safeName(this.referToByName!));
            writer.write("[");
            this.args[0].toJS(writer);
            writer.write("]");
            return;
        }
        // String slicing via variable: strVar(a..b)
        if (this.type === "Str" && this.args[0] instanceof RangeIter) {
            const range = this.args[0];
            writer.write(writer.safeName(this.referToByName!));
            writer.write(".slice(");
            if (range.start !== null) {
                writer.write("Number(");
                range.start.toJS(writer);
                writer.write(")");
            } else {
                writer.write("0");
            }
            if (range.end !== null) {
                writer.write(", Number(");
                range.end.toJS(writer);
                writer.write(") + 1");
            }
            writer.write(")");
            return;
        }
        if (this.isBuiltin) {
            this.toJSHelper?.(writer, this.args);
            return;
        }
        if (this.callerType instanceof FuncType) {
            if (this.isStructConstructor) {
                // Resolve struct fields from scope
                let structFields: { name: string; type: Type; mutable: boolean }[] = [];
                const callScope = this.getScope();
                if (callScope) {
                    const lookup = callScope.lookup(this.name);
                    if (lookup && lookup.attrs.class === "struct") {
                        structFields = lookup.attrs.fields;
                    }
                }
                const safeNames = structFields.map((f) => writer.safeName(f.name));
                writer.write("{");
                this.args.forEach((arg, i) => {
                    if (i > 0) {
                        writer.write(", ");
                    }
                    writer.write(`${safeNames[i]}: `);
                    arg.toJS(writer);
                });
                writer.write("}");
            } else {
                writer.write(writer.safeName(this.referToByName));
                writer.write("(");
                this.args.forEach((arg, i) => {
                    if (i > 0) {
                        writer.write(", ");
                    }
                    // Auto-convert Arg to Iter when the function expects Iter but gets Arg
                    if (
                        this.callerType instanceof FuncType &&
                        this.callerType.paramTypes[i] instanceof IterType &&
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
            }
        } else if (this.callerType instanceof IterType) {
            writer.useBuiltin("$iterGet$");
            writer.write("$iterGet$(");
            if (this.args.length !== 1) {
                throw new Error("iterator indexed access does not have exactly 1 index");
            }
            if (this.args[0].type === "Num") {
                this.args[0].toJS(writer);
                writer.write(", ");
            } else if (this.args[0].type === "Int") {
                writer.write("Number(");
                this.args[0].toJS(writer);
                writer.write("), ");
            }
            writer.write(writer.safeName(this.referToByName));
            writer.write(")");
        } else if (this.callerType instanceof TupleType) {
            writer.write(writer.safeName(this.referToByName));
            this.args.forEach((arg) => {
                writer.write("[");
                arg.toJS(writer);
                writer.write("]");
            });
        } else if (this.callerType instanceof DictType || this.callerType instanceof MutDictType) {
            writer.write("(");
            writer.write(writer.safeName(this.referToByName));
            writer.write(".get(");
            this.args[0]?.toJS(writer);
            writer.write(") ?? null)");
        } else if (this.callerType instanceof ArrayType || this.callerType instanceof MutArrType) {
            // TODO: Why is string indexed access not also handled here?
            if (this.args.length !== 1) {
                throw new Error("array indexed access does not have exactly 1 index");
            }
            if (this.args[0] instanceof RangeIter) {
                // Array slicing with range: arr(a..b) → arr.slice(a, b+1)
                writer.write(writer.safeName(this.referToByName));
                const range = this.args[0];
                const isIntRange = range.innerType === "Int";
                if (range.end !== null) {
                    // a..b: arr.slice(Number(a), Number(b) + 1)
                    if (isIntRange) {
                        writer.write(".slice(Number(");
                        range.start.toJS(writer);
                        writer.write("), Number(");
                        range.end.toJS(writer);
                        writer.write(") + 1)");
                    } else {
                        writer.write(".slice(");
                        range.start.toJS(writer);
                        writer.write(", ");
                        range.end.toJS(writer);
                        writer.write(" + 1)");
                    }
                } else {
                    // a..: arr.slice(Number(a))
                    if (isIntRange) {
                        writer.write(".slice(Number(");
                        range.start.toJS(writer);
                        writer.write("))");
                    } else {
                        writer.write(".slice(");
                        range.start.toJS(writer);
                        writer.write(")");
                    }
                }
            } else {
                writer.write("(");
                writer.write(writer.safeName(this.referToByName));
                writer.write("[");
                this.args[0].toJS(writer);
                writer.write("] ?? null)");
            }
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
    callerType?: CallableType;
    isUnsafe: boolean = false;

    constructor(caller: Expression, args: Expression[]) {
        super(caller.line, caller.col);
        this.caller = caller;
        this.args = args;
    }

    cascadeTypes(parent: Expression | null, valueUsed: boolean): void {
        super.cascadeTypes(parent, valueUsed);
        // If the caller is an unresolved anonymous function, infer params from call args first
        if (this.caller instanceof AnonymousFunction && this.caller.needsInference) {
            const argTypes = this.args.map((arg, i) => {
                arg.cascadeTypes(this, true);
                if (arg.type === null) {
                    throw this.error(
                        `unable to resolve type of argument ${i + 1} in function call`
                    );
                }
                return arg.type;
            });
            // Set anon function params from call arg types, then cascade the body
            this.caller.fillParams(argTypes, this);
            this.callerType = this.caller.type as CallableType;
            this.type = this.callerType instanceof FuncType ? this.callerType.returnType : "Null";
            return;
        }

        this.caller.cascadeTypes(this, true);
        if (this.caller.type === null) {
            throw this.error("unable to resolve type of call");
        }
        if (this.caller.type instanceof FuncType) {
            const argTypes = this.args.map((arg, i) => {
                arg.cascadeTypes(this, true);
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
            // Array slicing with range: arr(a..b) returns an array, not an element
            if (this.args.length !== 1) {
                throw this.error("array access must have exactly 1 index");
            }
            this.args[0].cascadeTypes(this, true);
            if (this.args[0].type === null) {
                throw this.error("unable to resolve type of index in array access");
            }
            if (this.args[0] instanceof RangeIter) {
                this.type = this.caller.type;
                return;
            }
            const incompatible = this.caller.type.checkIndicesCompatible(
                this.args.map((arg) => arg.type as Type)
            );
            if (incompatible !== null) {
                throw this.error(incompatible);
            }
            this.type = this.isUnsafe
                ? this.caller.type.innerType
                : new MaybeType(this.caller.type.innerType);
            return;
        }
        if (this.caller.type instanceof IterType) {
            this.args.forEach((arg, i) => {
                arg.cascadeTypes(this, true);
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
            this.type = this.isUnsafe
                ? this.caller.type.innerType
                : new MaybeType(this.caller.type.innerType);
            return;
        }
        if (this.caller.type === "Str") {
            // String slicing with range: str(a..b) returns a substring
            if (this.args.length === 1 && this.args[0] instanceof RangeIter) {
                this.args[0].cascadeTypes(this, true);
                this.type = "Str";
                return;
            }
            if (this.args.length !== 1) {
                throw this.error(
                    `string indexing requires exactly one argument (the index), got ${this.args.length}`
                );
            }
            this.args.forEach((arg, i) => {
                arg.cascadeTypes(this, true);
                if (arg.type === null) {
                    throw this.error(
                        `unable to resolve type of argument ${i + 1} in string index access`
                    );
                }
            });
            if (this.args[0].type !== "Int" && this.args[0].type !== "Num") {
                throw this.error(`string index must be of type Int or Num`);
            }
            this.type = this.isUnsafe ? "Str" : new MaybeType("Str");
            return;
        }

        if (this.caller.type instanceof TupleType) {
            this.args.forEach((arg, i) => {
                arg.cascadeTypes(this, true);
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
                (this.args[0].type === "Int" || this.args[0].type === "Num") &&
                this.args[0] instanceof Literal
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
                arg.cascadeTypes(this, true);
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
            this.type = this.isUnsafe
                ? this.caller.type.valueType
                : new MaybeType(this.caller.type.valueType);
            return;
        }

        // Struct field access: instance("fieldName")
        if (this.caller.type instanceof CustomType) {
            const structScope = this.getScope();
            let structInfo:
                | { name: string; fields: { name: string; type: Type; mutable: boolean }[] }
                | undefined;
            if (structScope) {
                const lookup = structScope.lookup(this.caller.type.name);
                if (lookup && lookup.attrs.class === "struct") {
                    structInfo = { name: lookup.attrs.name, fields: lookup.attrs.fields };
                }
            }
            if (structInfo) {
                if (this.args.length !== 1) {
                    throw this.error(
                        `struct field access requires exactly one argument (the field name), got ${this.args.length}`
                    );
                }
                this.args[0].cascadeTypes(this, true);
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
        if (this.caller.type instanceof CustomType) {
            // Resolve struct from scope, falling back to global registry
            const structScope = this.getScope();
            let isStruct = false;
            if (structScope) {
                const lookup = structScope.lookup(this.caller.type.name);
                if (lookup && lookup.attrs.class === "struct") isStruct = true;
            }
            if (isStruct) {
                const fieldName =
                    this.args[0] instanceof Literal ? this.args[0].value.slice(1, -1) : "";
                writer.write("(");
                this.caller.toJS(writer);
                writer.write(`).${fieldName}`);
            }
        } else if (this.caller.type instanceof IterType) {
            writer.useBuiltin("$iterGet$");
            writer.write("$iterGet$(");
            if (this.args.length !== 1) {
                throw new Error("iterator indexed access does not have exactly 1 index");
            }
            if (this.args[0].type === "Num") {
                this.args[0].toJS(writer);
                writer.write(", ");
            } else if (this.args[0].type === "Int") {
                writer.write("Number(");
                this.args[0].toJS(writer);
                writer.write("), ");
            }
            this.caller.toJS(writer);
            writer.write(")");
        } else {
            writer.write("((");
            this.caller.toJS(writer);
            writer.write(")");
            if (this.caller.type instanceof FuncType) {
                writer.write("(");
                this.args.forEach((arg, i) => {
                    if (i > 0) {
                        writer.write(", ");
                    }
                    // Auto-convert Arr to Iter when function expects Iter
                    if (
                        this.caller.type instanceof FuncType &&
                        this.caller.type.paramTypes[i] instanceof IterType &&
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
            } else if (
                this.caller.type instanceof ArrayType ||
                this.caller.type instanceof MutArrType ||
                this.caller.type === "Str"
            ) {
                if (this.args.length !== 1) {
                    throw new Error(
                        `indexed access of a value of type ${this.caller.type} does not have exactly 1 index`
                    );
                }
                if (this.args[0] instanceof RangeIter) {
                    const range = this.args[0];
                    if (range.start !== null && range.end !== null) {
                        writer.write(".slice(Number(");
                        range.start.toJS(writer);
                        writer.write("), Number(");
                        range.end.toJS(writer);
                        writer.write(") + 1)");
                    } else if (range.start !== null && range.end === null) {
                        writer.write(".slice(Number(");
                        range.start.toJS(writer);
                        writer.write("))");
                    } else if (range.start === null && range.end !== null) {
                        writer.write(".slice(0, Number(");
                        range.end.toJS(writer);
                        writer.write(") + 1)");
                    } else {
                        writer.write(".slice()");
                    }
                } else {
                    writer.write("[");
                    this.args[0].toJS(writer);
                    writer.write("] ?? null");
                }
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
                writer.write(") ?? null");
            } else {
                throw new Error(`unknown caller type: ${this.caller.type}`);
            }
            writer.write(")");
        }
    }
}
