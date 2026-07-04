import { TokenType, type Token } from "../tokens";
import type { JSWriter } from "../write-js";
import { findCaller, resolveDirectCaller } from "./caller-resolution";
import { DropValue, Expression } from "./expression";
import { Literal } from "./literals";
import { Assignment } from "./assignment";
import { Block } from "./expression";
import { FunctionDef, AnonymousFunction } from "./functions";
import { RangeIter } from "./nodes";
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

    callerType?: CallableType;

    // This will be filled in during cascadeTypes when we resolve the caller
    toJSHelper: ((writer: JSWriter) => void) | null = null;

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

        for (let i = 0; i < this.args.length; i++) {
            const arg = this.args[i];
            arg.cascadeTypes(this, true);
            if (arg.type === null) {
                throw this.error(`unable to resolve type of argument ${i + 1} in call`);
            }
        }

        const { error, result } = findCaller(this, this.name, this.args);
        if (error !== null) {
            throw this.error(error);
        }

        this.toJSHelper = result.toJS;
        this.callerType = result.callerType;
        this.type = result.kind === "variable" ? result.returnType : result.callerType.returnType;

        // Fill unresolved anonymous function params using inferred types from context
        if (this.callerType instanceof FuncType) {
            // TODO: This doesn't currently work except for builtins, and it needs to happen during the findCaller resolution, not here
            this.fillLambdaFunctionParams();
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
        // const fnDef = this.findUserFunctionDef(this.args.slice(1).map((a) => a.type as Type));
        // if (fnDef && fnDef.params.length > 0) {
        //     const firstParamType = fnDef.params[0].type;
        //     if (firstParamType instanceof FuncType && firstParamType.paramTypes.length > 0) {
        //         anonFn.fillParams(firstParamType.paramTypes, this);
        //     }
        // }
    }

    // /**
    //  * Search ancestor chain for a Function definition matching this call's name,
    //  * matching non-function args to narrow down overloads.
    //  */
    // private findUserFunctionDef(
    //     otherArgTypes: Type[]
    // ): { params: { name: string; type: Type }[]; returnType: Type } | null {
    //     let child: Expression | null = null;
    //     let parent = this.parent;
    //     while (parent) {
    //         if (parent instanceof Block) {
    //             const idx = parent.expressions.indexOf(child ?? this);
    //             const olderSiblings = parent.expressions.slice(0, idx);
    //             for (let j = olderSiblings.length - 1; j >= 0; j--) {
    //                 let sib = olderSiblings[j];
    //                 while (sib instanceof DropValue) sib = sib.child;
    //                 if (sib instanceof FunctionDef && sib.name === this.name && !sib.isGeneric) {
    //                     // Check that other arg types match (skip the function arg)
    //                     const fnParams = sib.params;
    //                     if (fnParams.length - 1 === otherArgTypes.length) {
    //                         let match = true;
    //                         for (let k = 0; k < otherArgTypes.length; k++) {
    //                             if (!typeEquals(otherArgTypes[k], fnParams[k + 1].type)) {
    //                                 match = false;
    //                                 break;
    //                             }
    //                         }
    //                         if (match) return { params: fnParams, returnType: sib.returnType };
    //                     }
    //                 }
    //             }
    //         }
    //         child = parent;
    //         parent = parent.parent;
    //     }
    //     return null;
    // }

    /**
     * Fill unresolved anonymous function (lambda) params from the call context.
     * Derives expected param types based on the builtin kind and non-function args.
     */
    private fillLambdaFunctionParams(): void {
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

    toJS(writer: JSWriter): void {
        // TODO: The goal here is to get rid of the "referToByName" system and have all the callers provide a "toJS" callback during the resolution in cascadeTypes.
        // Then this method can just call that callback.
        if (!this.toJSHelper) {
            throw new Error(
                `missing compilation helper for call to ${this.name} -- this should have been resolved during type checking`
            );
        }
        this.toJSHelper(writer);
    }
}

/**
 * A DirectCall is a call to a variable or expression that is callable without needing
 * to search through enclosing scope to find potential matching function definitions
 * and/or resolve possible matches based on the type of the arguments provided.
 */
export class DirectCall extends Expression {
    caller: Expression;
    args: Expression[];
    isUnsafe: boolean;
    toJSHelper: ((writer: JSWriter) => void) | null = null;

    constructor(caller: Expression, args: Expression[], isUnsafe: boolean = false) {
        super(caller.line, caller.col);
        this.caller = caller;
        this.args = args;
        this.isUnsafe = isUnsafe;
    }

    cascadeTypes(parent: Expression | null, valueUsed: boolean): void {
        super.cascadeTypes(parent, valueUsed);

        const argTypes = this.args.map((arg, i) => {
            arg.cascadeTypes(this, true);
            if (arg.type === null) {
                throw this.error(`unable to resolve type of argument ${i + 1} in function call`);
            }
            return arg.type;
        });

        // If the caller is an unresolved anonymous function, infer params from call args first
        if (this.caller instanceof AnonymousFunction && this.caller.needsInference) {
            // Set anon function params from call arg types, then cascade the body
            this.caller.fillParams(argTypes, this);
            this.type = this.caller.type instanceof FuncType ? this.caller.type.returnType : "Null";
            return;
        }

        this.caller.cascadeTypes(this, true);
        if (this.caller.type === null) {
            throw this.error("unable to resolve type of call");
        }
        const { error, result } = resolveDirectCaller(
            this.caller,
            this.args,
            this.caller.type,
            argTypes
        );
        if (error) {
            throw this.error(error);
        }
        if (result) {
            this.toJSHelper = result.toJS;
        }
    }

    toJS(writer: JSWriter): void {
        if (!this.toJSHelper) {
            throw new Error(
                "missing compilation helper -- this should have been resolved during type checking"
            );
        }
        this.toJSHelper(writer);
    }
}
