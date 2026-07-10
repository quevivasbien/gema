import { type Token } from "../tokens";
import type { JSWriter } from "../write-js";
import { extractGenericBindings, functionNameWithParamTypes } from "./caller-utils";
import { ASTError, Block, Expression, lastExprShouldReturn } from "./expression";

import { Call } from "./calls";
import { Scope, type GenericMappingInfo, type TraitAttributes } from "./scope";
import { typeEquals } from "./type-utils";
import { CustomType, EscapeType, FuncType, type GenericType, type Type } from "./types";

/**
 * A non-anonymous function definition block
 */
export class FunctionDef extends Expression {
    name: string;
    associatedType: Type | null;
    params: { name: string; type: Type }[];
    returnType: Type | null;
    body: Block;
    genericTypes: GenericType[] | null;

    fullName: string;
    scope: Scope;

    /** If generic, will store references to any needed trait definitions here,
     * set during cascadeTypes */
    traitDefs: TraitAttributes[] | null = null;

    /** Need to maintain a list of any return statements this function has,
     * so we can check that they return a value whose type matches
     * the return type of this function */
    returnStatementValues: Expression[] = [];

    constructor(
        rootToken: Token,
        name: string,
        associatedType: Type | null,
        params: { name: string; type: Type }[],
        returnType: Type | null,
        body: Expression,
        genericTypes: GenericType[] | null
    ) {
        if (!(body instanceof Block)) {
            throw new Error("function body must be a Block expression");
        }
        super(rootToken.line, rootToken.col);
        this.name = name;
        this.associatedType = associatedType;
        this.params = params;
        this.returnType = returnType;
        this.body = body;
        this.genericTypes = genericTypes;

        const baseName = associatedType ? `${associatedType.toString()}::${name}` : name;
        this.fullName = functionNameWithParamTypes(
            baseName,
            params.map((p) => p.type)
        );

        this.scope = new Scope();

        // Function declarations always have "Null" type
        this.type = "Null";
    }

    getScope(): Scope | null {
        return this.scope;
    }

    isFunctionBoundary(): boolean {
        return true;
    }

    isGeneric(): boolean {
        return this.genericTypes !== null;
    }

    getAllChildren(): Expression[] {
        return [this.body];
    }

    cascadeTypes(parent: Expression | null, valueUsed: boolean): void {
        super.cascadeTypes(parent, valueUsed);

        const enclosingScope = this.parent?.getScope();
        if (!enclosingScope) {
            throw this.error("Function definition is missing enclosing scope");
        }
        // Register this function's name in the enclosing scope so call resolution can find it.
        // We do this now instead of waiting until body has cascaded its types so that,
        // if this is a recursive function, we can find our own definition in scope,
        // and so we can access definitions of variables defined outside the function.
        // If we don't yet know the return type of the function, we will need to update this
        // scope entry later.
        const mustResolveReturnTypeLater = this.returnType === null;
        if (this.isGeneric()) {
            enclosingScope.defineVariable({
                class: "generic",
                name: this.name,
                type: new FuncType(
                    this.params.map((p) => p.type),
                    this.returnType ?? "Unknown",
                    this.associatedType
                ),
                fullName: this.fullName,
                traitImplGetter: (callerScope, argTypes, associatedType) =>
                    this.getTraitFns(callerScope, argTypes, associatedType),
            });
        } else {
            enclosingScope.defineVariable({
                class: "func",
                name: this.name,
                type: new FuncType(
                    this.params.map((p) => p.type),
                    this.returnType ?? "Unknown",
                    this.associatedType
                ),
                fullName: this.fullName,
            });
        }

        // Chain this function's scope to the enclosing scope so lookups from inside
        // the body can reach outer variables (including the function's own name for recursion).
        this.scope.parent = enclosingScope;

        // Register params in this function's scope so Variable references can find them.
        for (const param of this.params) {
            this.scope.defineVariable({
                class: "var",
                name: param.name,
                type: param.type,
                isMutable: false,
                isConsumed: false,
            });
        }
        // Chain the body scope to this function's scope so lookups from inside the body
        // can find parameters, the function's own name for recursion,
        // and other things defined outside the function.
        this.body.scope.parent = this.scope;

        // Cascade types in body
        this.body.cascadeTypes(this, true);

        if (this.isGeneric()) {
            // Need to make sure the traits we require are actually defined in the enclosing scope
            this.traitDefs = [];
            const traitNamesEncountered: string[] = [];
            for (const generic of this.genericTypes!) {
                for (const traitName of generic.traits) {
                    if (traitNamesEncountered.includes(traitName)) {
                        continue; // No need to check this again
                    }
                    const traitDef = enclosingScope.lookupTrait(traitName);
                    if (traitDef === null) {
                        throw this.error(
                            `could not find definition for required trait ${traitName}`
                        );
                    }
                    this.traitDefs.push(traitDef);
                }
            }
        }

        // Unwrap EscapeType from body type (functions ending in `return expr` have
        // an Escape-typed body, but we compare the inner value type against the return type).
        const bodyType =
            this.body.type instanceof EscapeType ? this.body.type.innerType : this.body.type;

        if (this.returnType === null && bodyType !== null) {
            this.returnType = bodyType;
        }
        if (this.returnType === null) {
            throw this.error("unable to resolve function return type from function body");
        }
        if (!typeEquals(bodyType, this.returnType)) {
            throw this.error(
                `function body should return ${this.returnType}, but found ${this.body.type}`
            );
        }

        for (const rsv of this.returnStatementValues) {
            if (!typeEquals(rsv.type, this.returnType)) {
                throw new ASTError(
                    rsv.line,
                    rsv.col,
                    `function ${this.name} with return type ${this.returnType} has a return statement that returns a value of type ${rsv.type}`
                );
            }
        }

        // If we didn't already add the return type to the function definition to the
        // enclosing scope, we need to do so now
        if (mustResolveReturnTypeLater) {
            enclosingScope.updateFuncType(
                this.fullName,
                new FuncType(
                    this.params.map((p) => p.type),
                    this.returnType,
                    this.associatedType
                )
            );
        }
    }

    getFuncType(): FuncType {
        return new FuncType(
            this.params.map((p) => p.type),
            this.returnType ?? "Unknown"
        );
    }

    getTraitFns(
        callerScope: Scope,
        argTypes: Type[],
        associatedType: Type | null
    ): GenericMappingInfo[] | null {
        if (!this.isGeneric()) {
            throw this.error(`tried to monomorphize non-generic function ${this.fullName}`);
        }
        // Start by checking that everything beside generic types matches
        if (
            this.params.length !== argTypes.length ||
            this.params.some((p, i) => !typeEquals(p.type, argTypes[i], true))
        ) {
            // Not a match
            return null;
        }
        if (!typeEquals(this.associatedType, associatedType, true)) {
            // Not a match
            return null;
        }

        // Figure out what types are being substituted for the generic types
        const bindings = new Map<string, Type>();
        for (let i = 0; i < this.params.length; i++) {
            if (!extractGenericBindings(this.params[i].type, argTypes[i], bindings)) {
                // Not a match -- trying to substitute incompatible types
                return null;
            }
        }
        if (this.associatedType !== null && associatedType !== null) {
            if (!extractGenericBindings(this.associatedType, associatedType, bindings)) {
                // Not a match
                return null;
            }
        }

        // Check in the caller scope to make sure that the bound types satisfy the required traits
        const genericMappingInfos: GenericMappingInfo[] = [];
        for (const generic of this.genericTypes!) {
            const candidateType = bindings.get(generic.name)!;
            const traitImpls: Record<string, Record<string, string>> = {};
            for (const traitName of generic.traits) {
                const traitAttrs = this.traitDefs?.find((td) => td.name === traitName);
                if (!traitAttrs) {
                    throw this.error(`missing trait attributes for trait ${traitName}`);
                }
                // Look up each required definition in the caller scope
                const fnImpls = callerScope.checkCandidateTypeSatisfiesTrait(
                    candidateType,
                    traitAttrs
                );
                if (fnImpls === null) {
                    // Not a match -- candidate type doesn't implement trait
                    return null;
                }
                traitImpls[traitName] = fnImpls;
            }
            genericMappingInfos.push({
                generic: generic.name,
                boundType: candidateType,
                traitImpls,
            });
        }

        return genericMappingInfos;
    }

    /** Walk the body subtree to check if any Return needs exception handling. */
    private needsTryCatch(): boolean {
        const check = (expr: Expression): boolean => {
            if (expr.needsExceptionForControlFlow()) return true;
            if (expr instanceof AnonymousFunction || expr instanceof FunctionDef) return false; // nested function will handle its own return
            return expr.getAllChildren().some((e) => check(e));
        };
        return this.body.expressions.some((e) => check(e));
    }

    /** Figure out if this is a recursive function that supports tail-call optimization
     * i.e., if the final expression in the function is a call to the function itself
     * Returns the last expression as a Call, or null if not a tail call
     */
    private getTailCall(): Call | null {
        const lastExpr = this.body.expressions[this.body.expressions.length - 1];
        if (!(lastExpr instanceof Call)) {
            // TODO: We might also want to look for DirectCalls, but not needed for an MVP
            return null;
        }
        // Check if the lastExpr is a call to _this_ function
        // Must match both name and type
        if (
            lastExpr.name !== this.name ||
            this.params.length !== lastExpr.args.length ||
            this.params.some((p, i) => !typeEquals(p.type, lastExpr.args[i].type))
        ) {
            return null;
        }
        return lastExpr;
    }

    toJS(writer: JSWriter): void {
        writer.write(`function ${writer.safeName(this.fullName)}(`);
        writer.write(this.params.map((p) => writer.safeName(p.name)).join(", "));

        if (this.isGeneric()) {
            // Generic functions also taking mappings for each of their generic function trait implementations
            for (const generic of this.genericTypes!) {
                for (const traitName of generic.traits) {
                    writer.write(`, $$impl${traitName}_${generic.name}`);
                }
            }
        }
        // TODO: We also need to figure out, within the function body itself, when we are calling a type-defined function, so we can pass it to the Trait dictionary instead of calling it directly.
        // Probably that should be sorted out in the findCaller log in caller-resolution.ts, combined with the scope search in scope.ts -- i.e., when we search for a function that takes a generic param, we need to match it with the function from the trait definition instead of some other function

        writer.write(") ");
        writer.beginFunction();
        const needsTry = this.needsTryCatch();
        if (needsTry) {
            writer.useBuiltin("$Return$");
            writer.write("try {");
            writer.indentIn();
            writer.newLine();
        }
        const tailCall = this.getTailCall();
        if (tailCall !== null) {
            // Tail call optimization
            // Need to create temp vars for each param, in case the updated value of one relies on the current value of others
            const tempArgNames = this.params.map((p) => {
                const name = writer.uniqueName(p.name);
                writer.declareVariable(name);
                return name;
            });
            writer.write("while (true) {");
            writer.indentIn();
            writer.newLine();
            this.body.expressions.slice(0, -1).forEach((expr) => {
                expr.toJS(writer);
                writer.write(";");
                writer.newLine();
            });
            // Instead of returning the call to self, we reassign the args of this function to those passed to the call
            for (let i = 0; i < this.params.length; i++) {
                writer.write(`${writer.safeName(tempArgNames[i])} = `);
                tailCall.args[i].toJS(writer);
                writer.write(";");
                writer.newLine();
            }
            for (let i = 0; i < this.params.length; i++) {
                writer.write(
                    `${writer.safeName(this.params[i].name)} = ${writer.safeName(tempArgNames[i])};`
                );
                writer.newLine();
            }
            writer.indentOut();
            writer.newLine();
            writer.write("}");
        } else {
            // No tail call optimization
            this.body.expressions.slice(0, -1).forEach((expr) => {
                expr.toJS(writer);
                writer.write(";");
                writer.newLine();
            });
            const lastExpr = this.body.expressions[this.body.expressions.length - 1];
            if (lastExprShouldReturn(lastExpr)) {
                writer.write("return ");
            }
            lastExpr.toJS(writer);
            writer.write(";");
        }
        if (needsTry) {
            writer.indentOut();
            writer.newLine();
            writer.write("} catch (e$$) {");
            writer.indentIn();
            writer.newLine();
            writer.write("if (e$$ instanceof $Return$) return e$$.value;");
            writer.newLine();
            writer.write("throw e$$;");
            writer.indentOut();
            writer.newLine();
            writer.write("}");
        }
        writer.endFunction();
    }
}

export class AnonymousFunction extends Expression {
    params: { name: string; type: Type }[];
    body: Block;
    returnType: Type | null;
    scope: Scope;
    /** Whether this function has unresolved (null) param types that need inference. */
    needsInference: boolean = false;
    /** Need to maintain a list of any return statements this function has,
     * so we can check that they return a value whose type matches
     * the return type of this function */
    returnStatementValues: Expression[] = [];

    /** Track whether params have been registered in scope (fillParams may do this before cascadeTypes) */
    private paramsRegistered: boolean = false;
    /** Track whether the body has been cascaded (fillParams may do this before cascadeTypes) */
    private bodyCascaded: boolean = false;

    getAllChildren(): Expression[] {
        return [this.body];
    }

    constructor(
        rootToken: Token,
        params: { name: string; type: Type }[],
        body: Expression,
        returnType: Type | null = null
    ) {
        if (!(body instanceof Block)) {
            throw new Error("function body must be a Blcok expression");
        }
        super(rootToken.line, rootToken.col);
        this.params = params;
        this.body = body;
        this.returnType = returnType;
        this.scope = new Scope();
        this.needsInference = params.some((p) => p.type === null);
    }

    /** Fill param types from an inferred signature, then cascade the body. */
    fillParams(types: Type[], parent?: Expression | null): void {
        if (!this.needsInference) return;
        for (let i = 0; i < this.params.length; i++) {
            this.params[i].type = types[i] ?? this.params[i].type;
        }
        this.needsInference = false;
        // Register inferred params in scope before cascading the body
        this.paramsRegistered = true;
        for (const param of this.params) {
            this.scope.defineVariable({
                class: "var",
                name: param.name,
                type: param.type,
                isMutable: false,
                isConsumed: false,
            });
        }
        // Chain this function's scope to the enclosing scope (use parent if given,
        // otherwise walk up from body which should have a parent from setParentPointers).
        if (parent !== undefined) {
            this.parent = parent;
        }
        if (this.parent && this.scope.parent === null) {
            this.scope.parent = this.parent.getScope();
        }
        this.body.scope.parent = this.scope;
        // Body: last expression is the return value (always consumed).
        this.body.cascadeTypes(this, true);
        this.bodyCascaded = true;
        const bodyReturnType =
            this.body.type instanceof EscapeType ? this.body.type.innerType : this.body.type;
        if (bodyReturnType === null) {
            throw this.error(`unable to resolve return type of function.`);
        }
        if (this.returnType !== null && !typeEquals(bodyReturnType, this.returnType)) {
            throw this.error(
                `anonymous function body should return ${this.returnType}, but found ${bodyReturnType}`
            );
        }
        this.type = new FuncType(
            this.params.map((p) => p.type),
            this.returnType ?? bodyReturnType
        );
    }

    cascadeTypes(parent: Expression | null, valueUsed: boolean): void {
        super.cascadeTypes(parent, valueUsed);

        // Chain this function's scope to the enclosing scope so closures can
        // capture variables from outer scopes (function params, outer vars, etc.).
        if (this.parent && this.scope.parent === null) {
            this.scope.parent = this.parent.getScope();
        }

        // Register params in scope so Variable references can find them.
        // (fillParams may already have done this, so check the flag.)
        if (!this.paramsRegistered) {
            this.paramsRegistered = true;
            for (const param of this.params) {
                if (param.type !== null) {
                    this.scope.defineVariable({
                        class: "var",
                        name: param.name,
                        type: param.type,
                        isMutable: false,
                        isConsumed: false,
                    });
                }
            }
        }
        this.body.scope.parent = this.scope;

        // If params have null types, set a placeholder FuncType and skip body cascade.
        // fillParams() must be called by the enclosing context to provide real types.
        if (this.needsInference) {
            // Use a non-concrete placeholder type so looseMatch allows the match
            const placeholder = new CustomType("__infer__");
            this.type = new FuncType(
                this.params.map(() => placeholder),
                placeholder
            );
            return;
        }
        // Body: last expression is the return value (always consumed), not the
        // function definition's own valueUsed. Block.cascadeTypes handles the
        // per-expression valueUsed propagation internally.
        // Skip body cascade if fillParams already cascaded it.
        if (!this.bodyCascaded) {
            this.body.cascadeTypes(this, true);
            this.bodyCascaded = true;
        }
        const bodyReturnType =
            this.body.type instanceof EscapeType ? this.body.type.innerType : this.body.type;
        if (bodyReturnType === null) {
            throw this.error(`unable to resolve return type of function.`);
        }
        if (this.returnType !== null && !typeEquals(bodyReturnType, this.returnType)) {
            throw this.error(
                `anonymous function body should return ${this.returnType}, but found ${bodyReturnType}`
            );
        }
        for (const rsv of this.returnStatementValues) {
            if (!typeEquals(rsv.type, this.returnType)) {
                throw new ASTError(
                    rsv.line,
                    rsv.col,
                    `anonymous function with return type ${this.returnType} has a return statement that returns a value of type ${rsv.type}`
                );
            }
        }
        this.type = new FuncType(
            this.params.map((p) => p.type),
            this.returnType ?? bodyReturnType
        );
    }

    /** Walk the body subtree to check if any Return needs exception handling. */
    private needsTryCatch(): boolean {
        const check = (expr: Expression): boolean => {
            if (expr.needsExceptionForControlFlow()) return true;
            if (expr instanceof AnonymousFunction || expr instanceof FunctionDef) return false; // nested function will handle its own return
            return expr.getAllChildren().some((e) => check(e));
        };
        return this.body.expressions.some((e) => check(e));
    }

    toJS(writer: JSWriter): void {
        writer.write(`(`);
        writer.write(this.params.map((p) => writer.safeName(p.name)).join(", "));
        writer.write(") => ");
        writer.beginFunction();
        const needsTry = this.needsTryCatch();
        if (needsTry) {
            writer.useBuiltin("$Return$");
            writer.write("try {");
            writer.indentIn();
            writer.newLine();
        }
        this.body.expressions.slice(0, -1).forEach((expr) => {
            expr.toJS(writer);
            writer.newLine();
        });
        const lastExpr = this.body.expressions[this.body.expressions.length - 1];
        if (lastExprShouldReturn(lastExpr)) {
            writer.write("return ");
        }
        lastExpr.toJS(writer);
        writer.write(";");
        if (needsTry) {
            writer.indentOut();
            writer.newLine();
            writer.write("} catch (e$$) {");
            writer.indentIn();
            writer.newLine();
            writer.write("if (e$$ instanceof $Return$) return e$$.value;");
            writer.newLine();
            writer.write("throw e$$;");
            writer.indentOut();
            writer.newLine();
            writer.write("}");
        }
        writer.endFunction();
    }
}
