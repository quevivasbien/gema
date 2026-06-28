import { TokenType, type Token } from "../tokens";
import type { JSWriter } from "../write-js";
import { findCaller } from "./caller";
import { DropValue, Expression } from "./expression";
import { Literal } from "./literals";
import { Assignment } from "./assignment";
import { Block } from "./expression";
import { AnonymousFunction, FunctionDef, RangeIter, Variable } from "./nodes";
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
    MutSetType,
    SetType,
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
    isStructFieldAccess: boolean = false;
    structFieldName: string = "";
    isStructConstructor: boolean = false;
    isStringIndexing: boolean = false;
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
                this.builtinKind = result.builtinKind;
                // Track consumed variables for mutable operations
                if (
                    this.builtinKind === "detrans" ||
                    this.builtinKind === "detransDict" ||
                    this.builtinKind === "detransSet"
                ) {
                    const detransArg = this.args[0];
                    if (detransArg instanceof Variable && detransArg.fullName) {
                        if (callScope === null) {
                            // This should be impossible
                            throw new Error(
                                `Tried to mark a variable as consumed in a place with no enclosing scope.`
                            );
                        }
                        callScope.markVarConsumed(detransArg.fullName);
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
                        if (callScope?.isVarConsumed(mutArg.fullName)) {
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
        this.isStructConstructor = result.kind === "struct-constructor";

        // Fill unresolved anonymous function params using inferred types from context
        if (this.callerType instanceof FuncType && this.isBuiltin) {
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

        let expectedParamTypes: Type[] | null = null;

        // Determine expected param types from the builtin's semantics and other args
        switch (this.builtinKind) {
            case "map":
            case "filter":
            case "takeWhile":
            case "dropWhile":
            case "mapFromArray": {
                // fn(param: innerType): ?
                if (this.args.length >= 2 && this.args[1].type) {
                    const iterType = this.args[1].type;
                    const innerType =
                        iterType instanceof ArrayType ||
                        iterType instanceof IterType ||
                        iterType instanceof MutArrType
                            ? iterType.innerType
                            : iterType;
                    expectedParamTypes = [innerType];
                }
                break;
            }
            case "reduce": {
                // fn(acc: initType, elem: innerType): ?
                if (this.args.length >= 3 && this.args[2].type && this.args[1].type) {
                    const iterType = this.args[2].type;
                    const innerType =
                        iterType instanceof ArrayType ||
                        iterType instanceof IterType ||
                        iterType instanceof MutArrType
                            ? iterType.innerType
                            : iterType;
                    expectedParamTypes = [this.args[1].type, innerType];
                }
                break;
            }
            case "iterate": {
                // fn(param: startType): startType
                if (this.args.length >= 2 && this.args[1].type) {
                    expectedParamTypes = [this.args[1].type];
                }
                break;
            }
        }

        if (expectedParamTypes !== null) {
            anonFn.fillParams(expectedParamTypes, this);
            // Re-resolve the call with the now-resolved function type
            const resolvedArgTypes = this.args.map((arg) => arg.type as Type);
            const { error, result } = findCaller(this, this.parent, this.name, resolvedArgTypes);
            if (error === null) {
                this.callerType = result.callerType;
                this.type = result.rootType;
                this.referToByName = result.referToByName;
                this.isStructConstructor = result.kind === "struct-constructor";

                if (result.kind === "builtin") {
                    this.isBuiltin = true;
                    this.builtinKind = result.builtinKind;
                }
                // Re-check consumed vars with resolved result
                if (
                    this.builtinKind === "detrans" ||
                    this.builtinKind === "detransDict" ||
                    this.builtinKind === "detransSet"
                ) {
                    const detransArg = this.args[0];
                    if (detransArg instanceof Variable && detransArg.fullName) {
                        const callScope = this.getScope();
                        if (callScope === null) {
                            // This should be impossible
                            throw new Error(
                                `Tried to mark a variable as consumed in a place with no enclosing scope.`
                            );
                        }
                        callScope.markVarConsumed(detransArg.fullName);
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
                        if (this.getScope()?.isVarConsumed(mutArg.fullName)) {
                            throw this.error(
                                `cannot use variable '${mutArg.fullName}' after it was detrans'd`
                            );
                        }
                    }
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
            // Helper to convert arrays to iterators if we use them where an iterator is expected
            const wrapArrayToIter = (index: number): void => {
                const arg = this.args[index];
                if (arg && (arg.type instanceof ArrayType || arg.type instanceof MutArrType)) {
                    writer.useBuiltin("$ArrayIterator$");
                    writer.write("new $ArrayIterator$(");
                    arg.toJS(writer);
                    writer.write(")");
                } else if (arg && arg.type === "Str") {
                    // Convert string to array iterator by splitting into characters
                    writer.useBuiltin("$ArrayIterator$");
                    writer.write("new $ArrayIterator$(");
                    arg.toJS(writer);
                    writer.write('.split(""))');
                } else {
                    arg?.toJS(writer);
                }
            };
            switch (this.builtinKind) {
                case "collect":
                    writer.useBuiltin("$collect$");
                    writer.write("$collect$(");
                    wrapArrayToIter(0);
                    writer.write(")");
                    return;
                case "map":
                    writer.useBuiltin("$MapIterator$");
                    writer.write("new $MapIterator$(");
                    this.args[0]?.toJS(writer);
                    writer.write(", ");
                    wrapArrayToIter(1);
                    writer.write(")");
                    return;
                case "mapFromArray":
                    writer.useBuiltin("$ArrayMapIterator$");
                    writer.write("new $ArrayMapIterator$(");
                    this.args[0]?.toJS(writer);
                    writer.write(", ");
                    wrapArrayToIter(1);
                    writer.write(")");
                    return;
                case "filter":
                    writer.useBuiltin("$FilterIterator$");
                    writer.write("new $FilterIterator$(");
                    this.args[0]?.toJS(writer);
                    writer.write(", ");
                    wrapArrayToIter(1);
                    writer.write(")");
                    return;
                case "reduce":
                    writer.useBuiltin("$reduce$");
                    writer.write("$reduce$(");
                    this.args[0]?.toJS(writer);
                    writer.write(", ");
                    this.args[1]?.toJS(writer);
                    writer.write(", ");
                    wrapArrayToIter(2);
                    writer.write(")");
                    return;
                case "range":
                    if (this.args[0]?.type === "Num") {
                        writer.useBuiltin("$RangeIterator$");
                        writer.write("new $RangeIterator$(");
                    } else if (this.args[0]?.type === "Int") {
                        writer.useBuiltin("$IntRangeIterator$");
                        writer.write("new $IntRangeIterator$(");
                    } else {
                        throw new Error(`Unexpected type ${this.args[0]?.type} in range iterator`);
                    }
                    this.args.forEach((arg, i) => {
                        if (i > 0) writer.write(", ");
                        arg.toJS(writer);
                    });
                    writer.write(")");
                    return;
                case "zip":
                    writer.useBuiltin("$ZipIterator$");
                    writer.write("new $ZipIterator$(");
                    this.args.forEach((arg, i) => {
                        if (i > 0) writer.write(", ");
                        wrapArrayToIter(i);
                    });
                    writer.write(")");
                    return;
                case "repeat":
                    writer.useBuiltin("$RepeatIterator$");
                    if (this.args[0]?.type === "Num") {
                        writer.write("new $RepeatIterator$(");
                        this.args[0]?.toJS(writer);
                        writer.write(", ");
                    } else if (this.args[0]?.type === "Int") {
                        writer.write("new $RepeatIterator$(Number(");
                        this.args[0]?.toJS(writer);
                        writer.write("), ");
                    } else {
                        throw new Error(
                            `Got unexpected type ${this.args[0]?.type} in repeat iterator`
                        );
                    }
                    wrapArrayToIter(1);
                    writer.write(")");
                    return;
                case "repeatInner":
                    writer.useBuiltin("$RepeatInnerIterator$");
                    if (this.args[0]?.type === "Num") {
                        writer.write("new $RepeatInnerIterator$(");
                        this.args[0]?.toJS(writer);
                        writer.write(", ");
                    } else if (this.args[0]?.type === "Int") {
                        writer.write("new $RepeatInnerIterator$(Number(");
                        this.args[0]?.toJS(writer);
                        writer.write("), ");
                    } else {
                        throw new Error(
                            `Got unexpected type ${this.args[0]?.type} in repeatInner iterator`
                        );
                    }
                    wrapArrayToIter(1);
                    writer.write(")");
                    return;
                case "cartesian":
                    writer.useBuiltin("$CartesianIterator$");
                    writer.write("new $CartesianIterator$(");
                    this.args.forEach((arg, i) => {
                        if (i > 0) writer.write(", ");
                        wrapArrayToIter(i);
                    });
                    writer.write(")");
                    return;
                case "permutations":
                    writer.useBuiltin("$PermutationsIterator$");
                    writer.write("new $PermutationsIterator$(");
                    // $PermutationsIterator$ behaves differently if you give it an array or string
                    this.args[0]?.toJS(writer);
                    if (
                        this.args[0]?.type instanceof ArrayType ||
                        this.args[0]?.type instanceof MutArrType ||
                        this.args[0]?.type == "Str"
                    ) {
                        writer.write(", true)"); // Second param in constructor is true if arg is Arr or Str
                    } else {
                        writer.write(")");
                    }
                    return;
                case "combinations":
                    writer.useBuiltin("$CombinationsIterator$");
                    if (this.args[0]?.type === "Num") {
                        writer.write("new $CombinationsIterator$(");
                        this.args[0]?.toJS(writer);
                        writer.write(", ");
                    } else if (this.args[0]?.type === "Int") {
                        writer.write("new $CombinationsIterator$(Number(");
                        this.args[0]?.toJS(writer);
                        writer.write("), ");
                    } else {
                        throw new Error(
                            `Got unexpected type ${this.args[0]?.type} in combinations iterator`
                        );
                    }
                    this.args[1]?.toJS(writer);
                    if (
                        this.args[1]?.type instanceof ArrayType ||
                        this.args[1]?.type instanceof MutArrType ||
                        this.args[1]?.type == "Str"
                    ) {
                        writer.write(", true)"); // Third param in constructor is true if arg is Arr or Str
                    } else {
                        writer.write(")");
                    }
                    return;
                case "toIter":
                    if (
                        this.args[0]?.type instanceof ArrayType ||
                        this.args[0]?.type instanceof MutArrType
                    ) {
                        writer.useBuiltin("$ArrayIterator$");
                        writer.write("new $ArrayIterator$(");
                        this.args[0]?.toJS(writer);
                        writer.write(")");
                    } else if (
                        this.args[0]?.type instanceof DictType ||
                        this.args[0]?.type instanceof MutDictType ||
                        this.args[0]?.type instanceof SetType ||
                        this.args[0]?.type instanceof MutSetType
                    ) {
                        writer.useBuiltin("$ArrayIterator$");
                        writer.write("new $ArrayIterator$([...");
                        this.args[0]?.toJS(writer);
                        writer.write("])");
                    } else if (this.args[0]?.type === "Str") {
                        writer.useBuiltin("$ArrayIterator$");
                        writer.write("new $ArrayIterator$(");
                        this.args[0]?.toJS(writer);
                        writer.write('.split("")');
                        writer.write(")");
                    }
                    return;
                case "toArr":
                    if (
                        this.args[0]?.type instanceof DictType ||
                        this.args[0]?.type instanceof MutDictType
                    ) {
                        // JS Map is natively iterable via .entries()
                        writer.write("[...");
                        this.args[0]?.toJS(writer);
                        writer.write("]");
                    } else if (
                        this.args[0]?.type instanceof SetType ||
                        this.args[0]?.type instanceof MutSetType
                    ) {
                        // JS Set is natively iterable via .values()
                        writer.write("[...");
                        this.args[0]?.toJS(writer);
                        writer.write("]");
                    } else if (this.args[0]?.type === "Str") {
                        this.args[0]?.toJS(writer);
                        writer.write('.split("")');
                    }
                    return;
                case "step":
                    writer.useBuiltin("$StepIterator$");
                    if (this.args[0]?.type === "Num") {
                        writer.write("new $StepIterator$(");
                        this.args[0]?.toJS(writer);
                        writer.write(", ");
                    } else if (this.args[0]?.type === "Int") {
                        writer.write("new $StepIterator$(Number(");
                        this.args[0]?.toJS(writer);
                        writer.write("), ");
                    } else {
                        throw new Error(
                            `Got unexpected type ${this.args[0]?.type} in step iterator`
                        );
                    }
                    wrapArrayToIter(1);
                    writer.write(")");
                    return;
                case "iterate":
                    writer.useBuiltin("$IterateIterator$");
                    writer.write("new $IterateIterator$(");
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
                    if (this.args[0]?.type === "Str") {
                        writer.write("((s) => s.length > 0 ? s[s.length - 1] : undefined)(");
                        this.args[0].toJS(writer);
                        writer.write(")");
                        return;
                    }
                    writer.useBuiltin("$last$");
                    writer.write("$last$(");
                    wrapArrayToIter(0);
                    writer.write(")");
                    return;
                case "length":
                    if (
                        this.args[0]?.type instanceof ArrayType ||
                        this.args[0]?.type instanceof MutArrType
                    ) {
                        this.args[0].toJS(writer);
                        writer.write(".length");
                        return;
                    }
                    if (this.args[0]?.type === "Str") {
                        this.args[0].toJS(writer);
                        writer.write(".length");
                        return;
                    }
                    writer.useBuiltin("$length$");
                    writer.write("$length$(");
                    wrapArrayToIter(0);
                    writer.write(")");
                    return;
                case "take":
                    writer.useBuiltin("$TakeIterator$");
                    writer.write("new $TakeIterator$(");
                    this.args[0]?.toJS(writer);
                    writer.write(", ");
                    wrapArrayToIter(1);
                    writer.write(")");
                    return;
                case "drop":
                    writer.useBuiltin("$DropIterator$");
                    if (this.args[0]?.type === "Num") {
                        writer.write("new $DropIterator$(");
                        this.args[0]?.toJS(writer);
                        writer.write(", ");
                    } else if (this.args[0]?.type === "Int") {
                        writer.write("new $DropIterator$(Number(");
                        this.args[0]?.toJS(writer);
                        writer.write("), ");
                    } else {
                        throw new Error(
                            `Got unexpected type ${this.args[0]?.type} in drop iterator`
                        );
                    }
                    wrapArrayToIter(1);
                    writer.write(")");
                    return;
                case "takeWhile":
                    writer.useBuiltin("$TakeWhileIterator$");
                    writer.write("new $TakeWhileIterator$(");
                    this.args[0]?.toJS(writer);
                    writer.write(", ");
                    wrapArrayToIter(1);
                    writer.write(")");
                    return;
                case "dropWhile":
                    writer.useBuiltin("$DropWhileIterator$");
                    writer.write("new $DropWhileIterator$(");
                    this.args[0]?.toJS(writer);
                    writer.write(", ");
                    wrapArrayToIter(1);
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
                    writer.useBuiltin("$putMutDict$");
                    writer.write("$putMutDict$(");
                    this.args[0]?.toJS(writer);
                    writer.write(", ");
                    this.args[1]?.toJS(writer);
                    writer.write(", ");
                    this.args[2]?.toJS(writer);
                    writer.write(")");
                    return;
                case "removeDict":
                    // remove on MutDict: delete key and return MutDict for chaining
                    writer.useBuiltin("$removeMutDict$");
                    writer.write("$removeMutDict$(");
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
                    writer.useBuiltin("$pushMutSet$");
                    writer.write("$pushMutSet$(");
                    this.args[0]?.toJS(writer);
                    writer.write(", ");
                    this.args[1]?.toJS(writer);
                    writer.write(")");
                    return;
                case "removeSet":
                    // remove on MutSet: delete element and return MutSet for chaining
                    writer.useBuiltin("$removeMutSet$");
                    writer.write("$removeMutSet$(");
                    this.args[0]?.toJS(writer);
                    writer.write(", ");
                    this.args[1]?.toJS(writer);
                    writer.write(")");
                    return;
                case "push":
                    writer.useBuiltin("$push$");
                    writer.write("$push$(");
                    this.args[0]?.toJS(writer);
                    writer.write(", ");
                    this.args[1]?.toJS(writer);
                    writer.write(")");
                    return;
                case "put":
                    writer.useBuiltin("$put$");
                    writer.write("$put$(");
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
                case "unwrap":
                    if (this.args.length === 1) {
                        writer.useBuiltin("$unwrapNoFallback$");
                        writer.write("$unwrapNoFallback$(");
                        this.args[0].toJS(writer);
                        writer.write(")");
                    } else {
                        writer.useBuiltin("$unwrapWithFallback$");
                        writer.write("$unwrapWithFallback$(");
                        this.args[0].toJS(writer);
                        writer.write(", ");
                        this.args[1].toJS(writer);
                        writer.write(")");
                    }
                    return;
                case "isnone":
                    this.args[0]?.toJS(writer);
                    writer.write(" === undefined");
                    return;
                case "some":
                    // `some` is a pure type-system construct; at runtime it's a no-op
                    this.args[0].toJS(writer);
                    return;
                case "contains":
                    const cVal = this.args[0];
                    const cIter = this.args[1];
                    if (cIter.type instanceof ArrayType || cIter.type instanceof MutArrType) {
                        cIter.toJS(writer);
                        writer.write(".indexOf(");
                        cVal.toJS(writer);
                        writer.write(") !== -1");
                    } else if (
                        cIter.type instanceof SetType ||
                        cIter.type instanceof MutSetType ||
                        cIter.type instanceof DictType ||
                        cIter.type instanceof MutDictType
                    ) {
                        cIter.toJS(writer);
                        writer.write(".has(");
                        cVal.toJS(writer);
                        writer.write(")");
                    } else if (cIter.type === "Str") {
                        cIter.toJS(writer);
                        writer.write(".includes(");
                        cVal.toJS(writer);
                        writer.write(")");
                    } else if (cIter.type instanceof IterType) {
                        writer.useBuiltin("$contains$");
                        writer.write("$contains$(");
                        cVal.toJS(writer);
                        writer.write(", ");
                        cIter.toJS(writer);
                        writer.write(")");
                    }
                    return;
                case "find":
                    if (
                        this.args[1]?.type instanceof ArrayType ||
                        this.args[1]?.type instanceof MutArrType ||
                        this.args[1]?.type === "Str"
                    ) {
                        writer.write("((i) => i === -1 ? undefined : i)(");
                        this.args[1]?.toJS(writer);
                        writer.write(".indexOf(");
                        this.args[0]?.toJS(writer);
                        writer.write("))");
                    } else if (this.args[1]?.type instanceof IterType) {
                        writer.useBuiltin("$find$");
                        writer.write("$find$(");
                        this.args[0]?.toJS(writer);
                        writer.write(", ");
                        this.args[1].toJS(writer);
                        writer.write(")");
                    }
                    return;
                case "split":
                    this.args[1]?.toJS(writer);
                    writer.write(".split(");
                    this.args[0]?.toJS(writer);
                    writer.write(")");
                    return;
                case "replace":
                    this.args[2]?.toJS(writer);
                    writer.write(".replaceAll(");
                    this.args[0]?.toJS(writer);
                    writer.write(", ");
                    this.args[1]?.toJS(writer);
                    writer.write(")");
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
                case "toStr":
                    writer.write("String(");
                    this.args[0]?.toJS(writer);
                    writer.write(")");
                    return;
                case "toInt":
                    if (this.args[0]?.type === "Num") {
                        writer.write("BigInt(Math.trunc(");
                        this.args[0]?.toJS(writer);
                        writer.write("))");
                    } else {
                        writer.write("BigInt(");
                        this.args[0]?.toJS(writer);
                        writer.write(")");
                    }
                    return;
                case "toNum":
                    writer.write("Number(");
                    this.args[0]?.toJS(writer);
                    writer.write(")");
                    return;
                case "toBool":
                    writer.write("Boolean(");
                    this.args[0]?.toJS(writer);
                    writer.write(")");
                    return;
                default:
                    throw new Error(`unknown builtin: ${this.builtinKind}`);
            }
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
            writer.write(writer.safeName(this.referToByName));
            writer.write(".get(");
            this.args[0]?.toJS(writer);
            writer.write(")");
        } else if (this.callerType instanceof ArrayType || this.callerType instanceof MutArrType) {
            writer.write(writer.safeName(this.referToByName));
            if (this.args.length === 1 && this.args[0] instanceof RangeIter) {
                // Array slicing with range: arr(a..b) → arr.slice(a, b+1)
                const range = this.args[0];
                const isIntRange = range.innerType === "Int";
                if (range.start !== null && range.end !== null) {
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
                } else if (range.start !== null && range.end === null) {
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
                } else if (range.start === null && range.end !== null) {
                    // ..b: arr.slice(0, Number(b) + 1)
                    if (isIntRange) {
                        writer.write(".slice(0, Number(");
                        range.end.toJS(writer);
                        writer.write(") + 1)");
                    } else {
                        writer.write(".slice(0, ");
                        range.end.toJS(writer);
                        writer.write(" + 1)");
                    }
                } else {
                    throw new Error("Both start and end of range iterator were null");
                }
            } else {
                this.args.forEach((arg) => {
                    writer.write("[");
                    arg.toJS(writer);
                    writer.write("]");
                });
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
            if (this.args.length === 1 && this.args[0] instanceof RangeIter) {
                this.args[0].cascadeTypes(this, true);
                this.type = this.caller.type;
                return;
            }
            // Cascade args first so their types are resolved before checking compatibility
            this.args.forEach((arg, i) => {
                arg.cascadeTypes(this, true);
                if (arg.type === null) {
                    throw this.error(`unable to resolve type of argument ${i + 1} in array access`);
                }
            });
            const incompatible = this.caller.type.checkIndicesCompatible(
                this.args.map((arg) => arg.type as Type)
            );
            if (incompatible !== null) {
                throw this.error(incompatible);
            }
            // Resolve the inner type through the number of provided indices
            // (partial indexing returns a sub-array)
            let resolvedType: Type = this.caller.type;
            for (let d = 0; d < this.args.length; d++) {
                if (resolvedType instanceof ArrayType) {
                    resolvedType = resolvedType.innerType;
                } else if (resolvedType instanceof MutArrType) {
                    resolvedType = resolvedType.innerType;
                } else {
                    break;
                }
            }
            this.type = this.isUnsafe ? resolvedType : new MaybeType(resolvedType);
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
            this.args.forEach((arg, i) => {
                arg.cascadeTypes(this, true);
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
        if (this.caller.type === "Str") {
            if (this.args.length === 1 && this.args[0] instanceof RangeIter) {
                // String slicing with a..b, a.., ..b, ..
                const range = this.args[0] as RangeIter;
                this.caller.toJS(writer);
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
            } else if (this.isUnsafe) {
                this.caller.toJS(writer);
                writer.write("[");
                this.args[0].toJS(writer);
                writer.write("]");
            } else {
                // Maybe-wrapped string index: str[i] returns undefined if out of bounds
                writer.write("((s, i) => i >= 0 && i < s.length ? s[i] : undefined)(");
                this.caller.toJS(writer);
                writer.write(", ");
                this.args[0].toJS(writer);
                writer.write(")");
            }
        } else if (this.caller.type instanceof CustomType) {
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
            writer.write("(");
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
                this.caller.type instanceof MutArrType
            ) {
                if (this.args.length === 1 && this.args[0] instanceof RangeIter) {
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
                    this.args.forEach((arg) => {
                        writer.write("[");
                        arg.toJS(writer);
                        writer.write("]");
                    });
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
                writer.write(")");
            } else {
                throw new Error(`unknown caller type: ${this.caller.type}`);
            }
        }
    }
}
