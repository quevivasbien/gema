import { TokenType, type Token } from "../tokens";
import type { JSWriter } from "../write-js";
import {
    checkTraitSatisfied,
    extractGenericBindings,
    functionNameWithParamTypes,
} from "./caller-utils";
import { ASTError, Block, Expression, lastExprShouldReturn } from "./expression";

import { typeEquals } from "./type-utils";
import {
    CustomType,
    EscapeType,
    FuncType,
    GenericType,
    isBuiltinTypeName,
    substituteTypeParams,
    type Type,
} from "./types";
import { Call } from "./calls";
import { Scope, type FuncAttributes, type TraitAttributes } from "./scope";


/**
 * Recursively set sourceFile on every node in a cloned expression tree.
 * Used after monomorphization so error messages show the correct source file.
 * TODO: This should be a method on the Expression class
 */
function tagClonedTree(node: Expression, sourceFile: string): void {
    node.sourceFile = sourceFile;
    const skipKeys = new Set(["parent", "type"]);
    for (const key of Object.keys(node) as (keyof Expression)[]) {
        if (skipKeys.has(key as string)) continue;
        const val = (node as unknown as Record<string, unknown>)[key as string];
        if (val instanceof Expression) {
            tagClonedTree(val, sourceFile);
        } else if (Array.isArray(val)) {
            for (const item of val) {
                if (item instanceof Expression) {
                    tagClonedTree(item, sourceFile);
                } else if (
                    item &&
                    typeof item === "object" &&
                    "value" in (item as Record<string, unknown>)
                ) {
                    const kw = item as { value: Expression };
                    if (kw.value instanceof Expression) {
                        tagClonedTree(kw.value, sourceFile);
                    }
                } else if (
                    item &&
                    typeof item === "object" &&
                    ("condition" in (item as Record<string, unknown>) ||
                        "branch" in (item as Record<string, unknown>))
                ) {
                    const cb = item as { condition?: Expression; branch?: Expression };
                    if (cb.condition instanceof Expression) tagClonedTree(cb.condition, sourceFile);
                    if (cb.branch instanceof Expression) tagClonedTree(cb.branch, sourceFile);
                }
            }
        }
    }
}

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
    scope: Scope = new Scope();

    /** If generic, will store references to any needed trait definitions here,
     * set during cascadeTypes */
    traitDefs: TraitAttributes[] | null = null;
    
    /** If generic, will store any monomorphized versions here */
    monomorphizedVersions: FunctionDef[] = [];
    /** Set to true for FunctionDef clones created during monomorphization. */
    isMonomorphizedClone: boolean = false;
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
        genericTypes: GenericType[] | null,
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
        
        const baseName = associatedType ? `${associatedType.toString()}.${name}` : name;
        this.fullName = functionNameWithParamTypes(
            baseName,
            params.map((p) => p.type)
        );

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
        let mustResolveReturnTypeLater = this.returnType === null;
        if (!this.isMonomorphizedClone) {
            enclosingScope.defineVariable({
                class: "func",
                name: this.name,
                type: new FuncType(
                    this.params.map((p) => p.type),
                    this.returnType ?? "Unknown"
                ),
                isGeneric: this.isGeneric(),
                fullName: this.fullName,
                def: this.isGeneric() ? this : undefined,
                paramNames: this.params.map(p => p.name)
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
                        continue;  // No need to check this again
                    }
                    const traitDef = enclosingScope.lookupTrait(traitName);
                    if (traitDef === null) {
                        throw this.error(`could not find definition for required trait ${traitName}`);
                    }
                    this.traitDefs.push(traitDef);
                }
            }

            // Can stop here if dealing with a generic function
            // TODO: Is this actually necessary?
            return;
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
            enclosingScope.updateFuncType(this.fullName, new FuncType(this.params.map(p => p.type), this.returnType));
        }
    }

    monomorphize(
        argTypes: Type[],
        associatedType: Type | null,
        callerScope: Scope,
    ): { fullName: string; funcType: FuncType; returnType: Type } | null {
        if (!this.isGeneric) {
            throw this.error(`tried to monomorphize non-generic function ${this.fullName}`);
        }
        if (this.params.length !== argTypes.length) {
            throw this.error(`tried to monomorphize function ${this.fullName} with incompatible number of arguments`);
        }
        if ((this.associatedType === null) !== (associatedType === null)) {
            throw this.error(`tried to monorphize function ${this.fullName} with incompatible associated type`);
        }

        // Figure out what types are being substituted for the generic types
        const bindings = new Map<string, Type>();
         for (let i = 0; i < this.params.length; i++) {
            if (!extractGenericBindings(this.params[i].type, argTypes[i], bindings)) {
                throw this.error(`encountered error while attempting to extract generic binding for parameter ${this.params[i].name}`);
            }
        }
        if (this.associatedType !== null && associatedType !== null) {
            if (!extractGenericBindings(this.associatedType, associatedType, bindings)) {
                throw this.error(`encountered error while attempting to extract generic binding for associated type of function ${this.fullName}`);
            }
        }

        // Check in the caller scope to make sure that the bound types satisfy the required traits
        for (const generic of this.genericTypes!) {
            const candidateType = bindings.get(generic.name)!;
            for (const traitName of generic.traits) {
                const traitAttrs = this.traitDefs?.find(td => td.name === traitName);
                if (!traitAttrs) {
                    throw this.error(`missing trait attributes for trait ${traitName}`);
                }
                // Look up each required definition in the caller scope
                if (!callerScope.checkCandidateTypeSatisfiesTrait(candidateType, traitAttrs)) {
                    throw this.error(`type ${candidateType.toString()} does not satisfy trait ${traitName}`);
                }
            }
        }

        // To complete!
    }

    /**
     * Monomorphize a generic TAF using pre-computed type bindings.
     * Unlike monomorphize(), this doesn't require the type params to appear
     * in function parameters — the bindings come from template matching.
     * TODO: This is deprecated. We should use only the main monomorphize function
     */
    tafMonomorphize(
        typeParams: string[],
        bindings: Map<string, Type>
    ): { fullName: string; funcType: FuncType; returnType: Type } | null {
        if (!this.isGeneric) return null;

        // Verify all type params have bindings
        for (const tp of typeParams) {
            if (!bindings.has(tp)) return null;
        }

        const concreteParamTypes = this.params.map((p) => substituteTypeParams(p.type, bindings));
        const concreteReturnType = substituteTypeParams(this.returnType, bindings);
        const monomorphizedFullName = functionNameWithParamTypes(this.name!, concreteParamTypes);

        // Verify trait satisfaction
        for (const param of this.params) {
            if (param.type instanceof CustomType && param.type.traits.length > 0) {
                const concreteType = substituteTypeParams(param.type, bindings);
                const isConcrete =
                    !(concreteType instanceof CustomType) || isBuiltinTypeName(concreteType.name);
                if (isConcrete) {
                    for (const traitName of param.type.traits) {
                        const traitScope = this.parent?.getScope() ?? null;
                        const traitLookupWrapper =
                            traitScope !== null
                                ? ({
                                      lookup: (n: string) => traitScope.lookup(n),
                                      allVariables: () => {
                                          const variables: {
                                              class: string;
                                              name: string;
                                              fullName?: string;
                                          }[] = [];
                                          let cur: typeof traitScope | null = traitScope;
                                          while (cur) {
                                              for (const variable of cur.variables) {
                                                  variables.push(variable);
                                              }
                                              cur = cur.parent;
                                          }
                                          return variables;
                                      },
                                  } as const)
                                : undefined;
                        if (!checkTraitSatisfied(concreteType, traitName, traitLookupWrapper)) {
                            return null;
                        }
                    }
                }
            }
        }

        const clonedBody = this.body.clone(bindings) as Block;
        const clonedParams = this.params.map((p) => ({
            name: p.name,
            type: substituteTypeParams(p.type, bindings),
        }));

        const monomorphized = new FunctionDef(
            { line: this.line, col: this.col, text: this.name!, type: TokenType.Func },
            this.name!,
            clonedParams,
            concreteReturnType as Type,
            [],
            clonedBody,
            true
        );
        monomorphized.isMonomorphizedClone = true;

        monomorphized.cascadeTypes(this.parent, true);
        monomorphized.sourceFile = this.sourceFile;

        const monomorphizedBodyType =
            monomorphized.body.type instanceof EscapeType
                ? monomorphized.body.type.innerType
                : monomorphized.body.type;
        if (
            this.returnType === "Null" &&
            monomorphizedBodyType !== null &&
            monomorphizedBodyType !== "Null"
        ) {
            monomorphized.returnType = monomorphizedBodyType;
        }

        const isConcreteParam = (t: Type): boolean => {
            if (!(t instanceof CustomType)) return true;
            if (isBuiltinTypeName(t.name)) return true;
            const ps = this.parent?.getScope();
            if (ps) {
                const pl = ps.lookup(t.name);
                if (pl && pl.attrs.class === "struct") return true;
            }
            return false;
        };
        const allConcrete = clonedParams.every((p) => isConcreteParam(p.type));

        if (allConcrete) {
            this.monomorphizedVersions.push(monomorphized);
        }

        return {
            fullName: monomorphizedFullName,
            funcType: monomorphized.getFuncType(),
            returnType: monomorphized.returnType,
        };
    }

    clone(bindings?: Map<string, Type>): Expression {
        const clonedAssociatedType = (this.associatedType && bindings) ? substituteTypeParams(this.associatedType, bindings) : this.associatedType;
        const clonedParams = this.params.map((p) => ({
            name: p.name,
            type: bindings ? substituteTypeParams(p.type, bindings) : p.type,
        }));
        const clonedReturnType = bindings
            ? substituteTypeParams(this.returnType, bindings)
            : this.returnType;
        const cloned = new FunctionDef(
            { line: this.line, col: this.col, text: this.name, type: TokenType.Func },
            this.name,
            clonedAssociatedType,
            clonedParams,
            clonedReturnType,
            this.body.clone(bindings),
            this.isGeneric,
        );
        cloned.fullName = this.fullName;
        cloned.sourceFile = this.sourceFile;
        return cloned;
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
        if (this.isGeneric) {
            // Don't bother figuring this out unless we're dealing with a concrete function def
            return null;
        }
        const lastExpr = this.body.expressions[this.body.expressions.length - 1];
        if (!(lastExpr instanceof Call)) {
            // TODO: We might also want to look for DirectCalls, but not needed for an MVP
            return null;
        }
        // Check if the lastExpr is a call to _this_ function
        if (lastExpr.referToByName !== this.fullName) {
            return null;
        }
        return lastExpr;
    }

    toJS(writer: JSWriter): void {
        if (this.isGeneric) {
            for (const v of this.monomorphizedVersions) {
                v.toJS(writer);
                writer.write(";");
                writer.newLine();
            }
            return;
        }
        writer.write(`function ${writer.safeName(this.fullName)}(`);
        writer.write(this.params.map((p) => writer.safeName(p.name)).join(", "));
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
    scope: Scope = new Scope();

    getScope(): Scope | null {
        return this.scope;
    }

    isFunctionBoundary(): boolean {
        return true;
    }

    params: { name: string; type: Type }[];
    body: Block;
    returnType: Type | null;
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

    clone(bindings?: Map<string, Type>): Expression {
        const cloned = new AnonymousFunction(
            { line: this.line, col: this.col, text: "func", type: TokenType.Func },
            this.params.map((p) => ({
                name: p.name,
                type: bindings && p.type !== null ? substituteTypeParams(p.type, bindings) : p.type,
            })),
            this.body.clone(bindings),
            this.returnType && bindings
                ? (substituteTypeParams(this.returnType, bindings) as Type)
                : null
        );
        return cloned;
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
