import { TokenType, type Token } from "../tokens";
import type { JSWriter } from "../write-js";
import { findCaller, resolveDirectCaller } from "./caller-resolution";
import { Expression } from "./expression";
import { AnonymousFunction } from "./functions";
import { ArrayType, FuncType, IterType, MutArrType, type Type } from "./types";

// ── Call (named function call) ──

export class Call extends Expression {
    name: string;
    args: Expression[];

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

    getAllChildren(): Expression[] {
        return this.args;
    }

    cascadeTypes(parent: Expression | null, valueUsed: boolean): void {
        super.cascadeTypes(parent, valueUsed);
        // Infer lambda param types from the calling context before the main cascade
        this.inferLambdaParams();

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
        this.type = result.returnType;
    }

    /**
     * Before the main arg cascade, infer lambda (backslash) param types by
     * searching the scope for a matching function definition.
     *
     * Strategy:
     *   1. Find all args that are AnonymousFunction with needsInference.
     *   2. Cascade non-lambda args first to get concrete types.
     *   3. Build sketch arg types (lambda positions = "Infer" sentinel).
     *   4. For user-defined functions: check for ambiguity, lookup caller,
     *      extract expected FuncType at each lambda position and fill.
     *   5. For builtins (map, filter, reduce, iterate, etc.): fallback to
     *      the old builtin-specific inference.
     */
    private inferLambdaParams(): void {
        // 1. Find all lambda args
        const lambdaPositions: Map<number, AnonymousFunction> = new Map();
        for (let i = 0; i < this.args.length; i++) {
            const arg = this.args[i];
            if (arg instanceof AnonymousFunction && arg.needsInference) {
                lambdaPositions.set(i, arg);
            }
        }
        if (lambdaPositions.size === 0) return;

        // 2. Cascade non-lambda args first
        for (let i = 0; i < this.args.length; i++) {
            if (!lambdaPositions.has(i)) {
                this.args[i].cascadeTypes(this, true);
            }
        }

        // 3. Build sketch arg types
        const sketchTypes: Type[] = this.args.map((_arg, i) =>
            lambdaPositions.has(i) ? ("Infer" as Type) : (this.args[i].type as Type)
        );

        const scope = this.getScope();
        if (!scope) return;

        // 4. Check for ambiguity and try user-defined functions first
        const lambdaParamCounts = new Map(
            [...lambdaPositions].map(([pos, anonFn]) => [pos, anonFn.params.length] as const)
        );
        const matchCount = scope.countMatchingCallers(this.name, lambdaParamCounts);
        if (matchCount > 1) {
            throw this.error(
                `ambiguous lambda type — multiple matching signatures found for '${this.name}'`
            );
        }
        if (matchCount === 1) {
            const match = scope.lookupCaller(this.name, sketchTypes, null);
            if (match) {
                const matchedParamTypes =
                    match.class === "func" || match.class === "generic"
                        ? match.type.paramTypes
                        : match.class === "struct"
                          ? match.fields.map((f) => f.type)
                          : [];
                for (const [pos, anonFn] of lambdaPositions) {
                    const expectedFT = matchedParamTypes[pos];
                    if (expectedFT instanceof FuncType) {
                        anonFn.fillParams(expectedFT.paramTypes, expectedFT.returnType, this);
                    }
                }
                return;
            }
        }

        // 5. Fallback: builtin-specific inference (for map, filter, reduce, iterate, etc.)
        // TODO: Do we still want to have a separate path for this?
        this.inferBuiltinLambdaParams(lambdaPositions);
    }

    /**
     * Fallback inference for well-known builtins that aren't in scope variables.
     */
    private inferBuiltinLambdaParams(lambdaPositions: Map<number, AnonymousFunction>): void {
        if (lambdaPositions.size !== 1) return;

        const [lambdaPos, anonFn] = lambdaPositions.entries().next().value as [
            number,
            AnonymousFunction,
        ];

        // Find the non-lambda arg that represents the iterable/start value
        const nonLambdaArgs = this.args.filter((_, i) => i !== lambdaPos);

        let expectedParamTypes: Type[] | null = null;
        let expectedReturnType: Type | null = null;

        if (this.name === "reduce" && nonLambdaArgs.length >= 2) {
            // reduce(fn, init, iter): fn params are (initType, elemType)
            const initType = nonLambdaArgs[0].type;
            const iterType = nonLambdaArgs[1].type;
            const innerType =
                iterType instanceof ArrayType ||
                iterType instanceof IterType ||
                iterType instanceof MutArrType
                    ? iterType.innerType
                    : iterType;
            if (initType && innerType) {
                expectedParamTypes = [initType, innerType];
                expectedReturnType = initType;
            }
        } else if (this.name === "iterate" && nonLambdaArgs.length >= 1) {
            // iterate(fn, start): fn param is start type, return is start type
            const startType = nonLambdaArgs[0].type;
            if (startType) {
                expectedParamTypes = [startType];
                expectedReturnType = startType;
            }
        } else if (
            ["map", "filter", "takeWhile", "dropWhile"].includes(this.name) &&
            nonLambdaArgs.length >= 1
        ) {
            // map/filter/takeWhile/dropWhile(fn, iter): fn param is iter's inner type
            const iterType = nonLambdaArgs[0].type;
            if (iterType) {
                const innerType =
                    iterType instanceof ArrayType ||
                    iterType instanceof IterType ||
                    iterType instanceof MutArrType
                        ? iterType.innerType
                        : iterType;
                expectedParamTypes = [innerType];
                // For filter, return type is always Bool; for others, leave it inferred from body
                if (this.name === "filter") {
                    expectedReturnType = "Bool";
                }
            }
        }

        if (expectedParamTypes !== null) {
            anonFn.fillParams(expectedParamTypes, expectedReturnType, this);
        }
    }

    toJS(writer: JSWriter): void {
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
            this.caller.fillParams(argTypes, undefined, this);
            this.type = this.caller.type instanceof FuncType ? this.caller.type.returnType : "Null";
            this.toJSHelper = (writer) => {
                writer.write("(");
                this.caller.toJS(writer);
                writer.write(")(");
                this.args.forEach((arg, i) => {
                    if (i > 0) writer.write(", ");
                    arg.toJS(writer);
                });
                writer.write(")");
            };
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
            argTypes,
            this.isUnsafe
        );
        if (error) {
            throw this.error(error);
        }
        if (result) {
            this.type = result.returnType;
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
