import { TokenType, type Token } from "../tokens";
import type { JSWriter } from "../write-js";
import {
    checkTraitSatisfied,
    extractBindingsFromParams,
    functionNameWithParamTypes,
} from "./caller-utils";
import { Assignment } from "./assignment";
import { ASTError, Block, Expression, lastExprShouldReturn } from "./expression";
import type { EnumDef } from "./enums";
import type { StructDef } from "./structs";

import { collectTraitsForTypeParam, typeEquals } from "./type-utils";
import {
    ArrayType,
    collectCustomTypeNames,
    CustomType,
    EnumType,
    EscapeType,
    FuncType,
    isBuiltinTypeName,
    IterType,
    MaybeType,
    MutArrType,
    substituteTypeParams,
    TemplateTypes,
    TupleType,
    type Type,
} from "./types";
import { Call } from "./calls";
import { Scope } from "./scope";

/**
 * Use directive: contains the parsed AST of the imported module.
 * During cascadeTypes, the module block is cascaded in isolation (parent = null)
 * and the exported symbols are injected into the enclosing scope.
 */
export class UseModule extends Expression {
    /** The parsed top-level block of the imported module. */
    moduleBlock: Block;

    constructor(
        rootToken: Token,
        public path: string,
        moduleBlock: Block,
        public symbols?: string[]
    ) {
        super(rootToken.line, rootToken.col);
        this.type = "Null";
        this.moduleBlock = moduleBlock;
    }

    getAllChildren(): Expression[] {
        return [this.moduleBlock];
    }

    cascadeTypes(parent: Expression | null, valueUsed: boolean): void {
        super.cascadeTypes(parent, valueUsed);

        // Cascade the module block in isolation (pass null parent so imports can't
        // reach into the importing module's scope).
        this.moduleBlock.scope.parent = null;
        this.moduleBlock.cascadeTypes(null, false);

        // After cascading the module, inject the exported symbols into the
        // enclosing scope so expressions in the importing module can use them.
        const enclosingScope = this.parent?.getScope();
        if (!enclosingScope) return;

        if (this.symbols && this.symbols.length > 0) {
            // Selective import: only inject the requested symbols
            for (const symName of this.symbols) {
                const moduleLookup = this.moduleBlock.scope.lookup(symName);
                if (!moduleLookup) {
                    throw this.error(
                        `module '${this.path}' does not export a symbol named '${symName}'`
                    );
                }
                enclosingScope.defineVariable(moduleLookup.attrs, true);
            }
        } else {
            // Bare import: inject all top-level definitions from the module scope
            for (const v of this.moduleBlock.scope.variables) {
                enclosingScope.defineVariable(v, true);
            }
        }
    }

    toJS(writer: JSWriter): void {
        // Emit the module's expressions inline in the current scope (not wrapped
        // in a nested block) so that function declarations and variables are
        // accessible to the importing module's code.
        const exprs = this.moduleBlock.expressions;
        for (let i = 0; i < exprs.length; i++) {
            exprs[i].toJS(writer);
            if (i < exprs.length - 1 || writer.isInsideIIFE()) {
                writer.write(";");
            }
            writer.newLine();
        }
    }

    clone(bindings?: Map<string, Type>): Expression {
        return new UseModule(
            { line: this.line, col: this.col, text: "use", type: TokenType.Use },
            this.path,
            this.moduleBlock.clone(bindings) as Block,
            this.symbols ? [...this.symbols] : undefined
        );
    }
}

// ── JS Import Symbol ──

/** A symbol imported from a JS module with its declared type annotation. */
export interface JSImportSymbol {
    name: string;
    typeAnnotation: Type;
}

/**
 * Use directive for importing symbols from a JavaScript module.
 * Unlike UseModule (which parses a .gema file), this trusts the user-provided
 * type annotations without verification — it is an "unsafe" operation.
 *
 * During cascadeTypes, the imported symbols are registered in the enclosing scope
 * and the import is recorded on the top-level Block for codegen.
 * During codegen, the JSWriter emits ES module import statements at the top level.
 */
export class UseJSModule extends Expression {
    constructor(
        rootToken: Token,
        public path: string,
        public imports: JSImportSymbol[]
    ) {
        super(rootToken.line, rootToken.col);
        this.type = "Null";
    }

    getAllChildren(): Expression[] {
        return [];
    }

    cascadeTypes(parent: Expression | null, valueUsed: boolean): void {
        super.cascadeTypes(parent, valueUsed);

        // Find the top-level Block to register JS imports
        // (Start from parent — UseJSModule itself is never a Block)
        let topBlock: Block | null = null;
        let ancestor: Expression | null = this.parent;
        while (ancestor) {
            if (ancestor instanceof Block) {
                topBlock = ancestor;
            }
            ancestor = ancestor.parent;
        }

        if (topBlock) {
            // Check for duplicate symbol names across all JS imports
            for (const imp of this.imports) {
                for (const [existingPath, existingNames] of topBlock.jsImports) {
                    if (existingNames.includes(imp.name)) {
                        throw this.error(
                            `Duplicate JS import: symbol '${imp.name}' is already imported from '${existingPath}'`
                        );
                    }
                }
            }
            topBlock.addJSImport(
                this.path,
                this.imports.map((i) => i.name)
            );
        }

        // Register imported symbols in the enclosing scope
        const enclosingScope = this.parent?.getScope();
        if (!enclosingScope) return;

        for (const imp of this.imports) {
            enclosingScope.defineVariable(
                {
                    class: "var",
                    name: imp.name,
                    type: imp.typeAnnotation,
                    isMutable: false,
                    isConsumed: false,
                },
                true
            );
        }
    }

    toJS(_writer: JSWriter): void {
        // JS imports are emitted at the top level by the JSWriter.
        // This node produces no inline code.
    }

    clone(_bindings?: Map<string, Type>): Expression {
        return new UseJSModule(
            { line: this.line, col: this.col, text: "use", type: TokenType.Use },
            this.path,
            this.imports.map((i) => ({
                name: i.name,
                typeAnnotation: i.typeAnnotation,
            }))
        );
    }
}

/**
 * Range literal created by the `..` syntax.
 * `a..b` → start=a, end=b (inclusive)
 * `..b`  → start=null, end=b (from 0 to b)
 * `a..`  → start=a, end=null (from a to infinity)
 * `..`   → start=null, end=null (from 0 to infinity)
 */
export class RangeIter extends Expression {
    start: Expression;
    end: Expression | null;
    step: Expression | null;
    innerType: "Num" | "Int" | null = null;

    constructor(
        startToken: Token,
        start: Expression,
        end: Expression | null,
        step: Expression | null
    ) {
        super(startToken.line, startToken.col);
        this.start = start;
        this.end = end;
        this.step = step;
    }

    cascadeTypes(parent: Expression | null, valueUsed: boolean): void {
        super.cascadeTypes(parent, valueUsed);

        this.start.cascadeTypes(this, true);
        if (this.start.type !== "Int" && this.start.type !== "Num") {
            throw this.error(`range start must be Int or Num, got ${this.start.type}`);
        }
        this.innerType = this.start.type;

        if (this.end !== null) {
            this.end.cascadeTypes(this, true);
            if (this.end.type !== this.innerType) {
                throw this.error(
                    `range end type ${this.end.type} does not match range start type ${this.innerType}`
                );
            }
        }
        if (this.step !== null) {
            this.step.cascadeTypes(this, true);
            if (this.step.type !== this.innerType) {
                throw this.error(
                    `range step type ${this.step.type} does not match range value type ${this.innerType}`
                );
            }
        }

        this.type = new IterType(this.innerType);
    }

    clone(bindings?: Map<string, Type>): Expression {
        return new RangeIter(
            { line: this.line, col: this.col, text: "..", type: TokenType.DotDot },
            this.start.clone(bindings),
            this.end ? this.end.clone(bindings) : null,
            this.step ? this.step.clone(bindings) : null
        );
    }

    toJS(writer: JSWriter): void {
        if (this.innerType === "Int") {
            writer.useBuiltin("$IntRangeIterator$");
            writer.write("new $IntRangeIterator$(");
        } else {
            writer.useBuiltin("$RangeIterator$");
            writer.write("new $RangeIterator$(");
        }
        this.start.toJS(writer);
        writer.write(", ");
        if (this.end !== null) {
            this.end.toJS(writer);
        } else {
            writer.write("undefined");
        }
        if (this.step !== null) {
            writer.write(", ");
            this.step.toJS(writer);
        }
        writer.write(")");
    }
}

export class TupleLit extends Expression {
    elements: Expression[];

    constructor(startToken: Token, elements: Expression[]) {
        super(startToken.line, startToken.col);
        if (elements.length === 0) {
            throw new Error("tuple must not be empty");
        }
        this.elements = elements;
    }

    cascadeTypes(parent: Expression | null, valueUsed: boolean): void {
        super.cascadeTypes(parent, valueUsed);
        const types: Type[] = [];
        for (let i = 0; i < this.elements.length; i++) {
            this.elements[i].cascadeTypes(this, true);
            if (this.elements[i].type === null) {
                throw this.error(`unable to resolve type of tuple element ${i + 1}`);
            }
            types.push(this.elements[i].type!);
        }
        this.type = new TupleType(types);
    }

    clone(bindings?: Map<string, Type>): Expression {
        return new TupleLit(
            { line: this.line, col: this.col, text: "(", type: TokenType.LParen },
            this.elements.map((e) => e.clone(bindings))
        );
    }

    toJS(writer: JSWriter): void {
        writer.write("[");
        this.elements.forEach((elem, i) => {
            if (i > 0) writer.write(", ");
            elem.toJS(writer);
        });
        writer.write("]");
    }
}

export class Variable extends Expression {
    name: string;
    templateTypes: TemplateTypes;

    fullName?: string;

    constructor(token: Token, templateTypes: TemplateTypes) {
        super(token.line, token.col);
        this.name = token.text;
        this.templateTypes = templateTypes;
    }

    getTemplateTypes(): TemplateTypes | null {
        return this.templateTypes;
    }

    toString(): string {
        if (!this.templateTypes.empty()) {
            return `${this.name}${this.templateTypes}`;
        }
        return this.name;
    }

    /** Walk up the parent chain through enclosing Blocks, scanning older sibling
     *  expressions in each one. Stops when the callback returns true (found). */
    private walkEnclosingBlocks(callback: (siblings: Expression[]) => boolean): boolean {
        let child: Expression | null = null;
        let parent = this.parent;
        while (parent) {
            const siblingExprs = parent instanceof Block ? parent.expressions : null;
            if (siblingExprs !== null) {
                const idx = siblingExprs.indexOf(child ?? this);
                const olderSiblings = siblingExprs.slice(0, idx);
                if (callback(olderSiblings)) return true;
            }
            child = parent;
            parent = parent.parent;
        }
        return false;
    }

    setTypeWithTemplateTypes(): void {
        this.fullName = functionNameWithParamTypes(this.name, this.templateTypes?.types ?? []);

        // Check scope first — search for a function entry by fullName
        const scope = this.getScope();
        if (scope) {
            for (const v of scope.variables) {
                if (v.class === "func" && v.fullName === this.fullName && !v.isGeneric) {
                    // Non-generic or already-monomorphized function found in scope
                    this.type = v.type;
                    this.fullName = v.fullName;
                    return;
                }
            }
            // Check for generic entries by base name
            const bareResult = scope.lookup(this.name);
            if (bareResult && bareResult.attrs.class === "func" && bareResult.attrs.isGeneric) {
                // Generic entry found in scope — monomorphization will happen via parent walk below
            }
        }

        // Check scope for function entries
        // Walk the full scope chain to find function entries
        let currentScope = this.getScope();
        while (currentScope) {
            for (const v of currentScope.variables) {
                if (v.class === "func" && v.fullName === this.fullName && !v.isGeneric) {
                    this.type = v.type;
                    this.fullName = v.fullName;
                    return;
                }
            }
            // Check for generic function entries in this scope level
            for (const v of currentScope.variables) {
                if (v.class === "func" && v.name === this.name && v.isGeneric && v.def) {
                    const genericFn = v.def as FunctionDef;
                    const argTypes = this.templateTypes?.types ?? [];
                    const result = genericFn.monomorphize(argTypes);
                    if (result !== null) {
                        this.fullName = result.fullName;
                        this.type = result.funcType;
                        return;
                    }
                }
            }
            currentScope = currentScope.parent;
        }

        // Check for generic struct — e.g., Pair[Int]
        if (scope) {
            const structResult = scope.lookup(this.name);
            if (
                structResult &&
                structResult.attrs.class === "struct" &&
                structResult.attrs.isGeneric &&
                structResult.attrs.def
            ) {
                const structDefNode = structResult.attrs.def as StructDef;
                const monomorphized = structDefNode.monomorphize(this.templateTypes.types);
                if (monomorphized) {
                    this.type = new CustomType(this.name);
                    this.fullName = this.name;
                    return;
                }
            }
        }

        // Check for generic enum — e.g., Result[Int, Str]
        if (scope) {
            const enumResult = scope.lookup(this.name);
            if (
                enumResult &&
                enumResult.attrs.class === "enum" &&
                enumResult.attrs.isGeneric &&
                enumResult.attrs.def
            ) {
                const enumDefNode = enumResult.attrs.def as EnumDef;
                const monomorphized = enumDefNode.monomorphize(this.templateTypes.types);
                if (monomorphized) {
                    this.type = monomorphized.enumType;
                    this.fullName = this.name;
                    return;
                }
            }
        }

        // Fall back to type reference (e.g., Arr[Int] → type Arr with template [Int])
        if (isBuiltinTypeName(this.name)) {
            this.type = new CustomType(this.name);
            this.fullName = this.name;
            return;
        }
        throw this.error(`cannot resolve type of variable '${this}'`);
    }

    resolveAssignment(e: Expression): Type | null {
        if (e instanceof Assignment && e.name === this.name) {
            return e.value.type;
        }
        return null;
    }

    cascadeTypes(parent: Expression | null, valueUsed: boolean): void {
        super.cascadeTypes(parent, valueUsed);
        if (!this.templateTypes.empty()) {
            this.setTypeWithTemplateTypes();
            return;
        }
        // Scope-based lookup — resolves params, loop vars, local assignments,
        // function references, struct/enum/trait references from the enclosing scope hierarchy.
        const scope = this.getScope();
        if (scope) {
            const result = scope.lookup(this.name);
            if (result) {
                const attrs = result.attrs;
                if (attrs.class === "var") {
                    // Check if this variable was consumed (e.g., by detrans).
                    // Variables consumed via detrans cannot be used afterward.
                    if (attrs.isConsumed) {
                        throw this.error(
                            `cannot use variable '${this.name}' after it was detrans'd`
                        );
                    }
                    this.type = attrs.type;
                    this.fullName = this.name;
                    return;
                } else if (attrs.class === "func") {
                    // Functions with parameters cannot be referenced as values
                    // without explicit type annotations (e.g. foo[Int, Int]).
                    if (attrs.type instanceof FuncType && attrs.type.paramTypes.length > 0) {
                        throw this.error(
                            `cannot reference function '${this.name}' without type annotations`
                        );
                    }
                    this.type = attrs.type;
                    this.fullName = attrs.fullName;
                    return;
                } else if (attrs.class === "struct") {
                    this.type = new CustomType(this.name);
                    this.fullName = this.name;
                    return;
                } else if (attrs.class === "enum") {
                    this.type = new EnumType(
                        attrs.name,
                        attrs.variants.map((v) => ({ name: v.name, type: v.type }))
                    );
                    this.fullName = this.name;
                    return;
                }
            }
        }

        // type param from enclosing generic function (e.g., T in T.zero())
        if (!isBuiltinTypeName(this.name)) {
            let fn: Expression | null = this.parent;
            // TODO: we could get rid of the instanceof check here and just
            // have a class method called something like getGenericTypeParams
            while (fn) {
                if (
                    fn instanceof FunctionDef &&
                    fn.isGeneric &&
                    fn.typeParams.includes(this.name)
                ) {
                    const traits: string[] = [];
                    for (const param of fn.params) {
                        traits.push(...collectTraitsForTypeParam(param.type, this.name));
                    }
                    const ct = new CustomType(this.name);
                    for (const t of traits) ct.addTrait(t);
                    this.type = ct;
                    this.fullName = this.name;
                    return;
                }
                fn = fn.parent;
            }
        }

        // builtin type name used as a type reference (e.g., Int in Int.zero())
        if (isBuiltinTypeName(this.name)) {
            this.type = new CustomType(this.name);
            this.fullName = this.name;
            return;
        }

        throw this.error(`unable to resolve type of variable ${this}`);
    }

    clone(bindings?: Map<string, Type>): Expression {
        let newTemplateTypes = this.templateTypes;
        if (bindings && !this.templateTypes.empty()) {
            newTemplateTypes = new TemplateTypes(
                this.templateTypes.types.map((t) => substituteTypeParams(t, bindings)),
                this.templateTypes.returnType !== null
                    ? substituteTypeParams(this.templateTypes.returnType, bindings)
                    : null
            );
        }
        // If bindings map this variable's name (a type param) to a concrete type,
        // create a variable referencing the concrete type name so it can be
        // resolved in the monomorphized body.
        let clonedName = this.name;
        if (bindings && !this.templateTypes.empty() && bindings.has(this.name)) {
            const boundType = bindings.get(this.name)!;
            if (boundType instanceof CustomType) {
                clonedName = boundType.name;
            }
        } else if (bindings && this.templateTypes.empty() && bindings.has(this.name)) {
            const boundType = bindings.get(this.name)!;
            if (boundType instanceof CustomType) {
                clonedName = boundType.name;
            }
        }
        const cloned = new Variable(
            { line: this.line, col: this.col, text: clonedName, type: TokenType.Identifier },
            newTemplateTypes
        );
        return cloned;
    }

    toJS(writer: JSWriter): void {
        if (this.fullName === undefined) {
            throw this.error(`type of variable ${this} not resolved`);
        }
        const name = writer.safeName(this.fullName);
        writer.write(name);
        // Clone iterator variables on every use so that sharing an iterator
        // across multiple expressions (nested loops, call arguments, pipes, etc.)
        // doesn't cause one consumer to share the same state as another
        if (this.type instanceof IterType) {
            writer.write(".clone()");
        }
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

/**
 * Recursively set sourceFile on every node in a cloned expression tree.
 * Used after monomorphization so error messages show the correct source file.
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
                    if (cb.condition instanceof Expression)
                        tagClonedTree(cb.condition, sourceFile);
                    if (cb.branch instanceof Expression) tagClonedTree(cb.branch, sourceFile);
                }
            }
        }
    }
}

export class FunctionDef extends Expression {
    isFunctionBoundary(): boolean {
        return true;
    }

    name: string | null;
    params: { name: string; type: Type }[];
    returnType: Type;
    body: Block;
    fullName: string;
    typeParams: string[] = [];
    scope: Scope = new Scope();
    monomorphizedVersions: FunctionDef[] = [];
    /** Set to true for FunctionDef clones created during monomorphization. */
    isMonomorphizedClone: boolean = false;
    /** Need to maintain a list of any return statements this function has,
     * so we can check that they return a value whose type matches
     * the return type of this function */
    returnStatementValues: Expression[] = [];
    /** If non-null, this function is type-associated (e.g., Int.zero) */
    typeAssociatedName: string | null;
    /** For templated TAFs, the template types from the type name (e.g., [T] for Arr[T].empty). */
    typeAssociatedTemplates: TemplateTypes;

    constructor(
        rootToken: Token,
        name: string,
        params: { name: string; type: Type }[],
        returnType: Type,
        typeTraits: { type: Type; trait: Type }[],
        body: Expression,
        skipTypeValidation: boolean = false,
        typeAssociatedName: string | null = null,
        typeAssociatedTemplates: TemplateTypes = new TemplateTypes()
    ) {
        if (!(body instanceof Block)) {
            throw new Error("function body must be a Block expression");
        }
        if (params.reduce((acc, p) => acc || p.name === name, false)) {
            throw new Error("function name cannot be the same as a parameter name");
        }
        super(rootToken.line, rootToken.col);
        this.name = name;
        this.params = params;
        this.returnType = returnType;
        this.body = body;
        this.typeAssociatedName = typeAssociatedName;
        this.typeAssociatedTemplates = typeAssociatedTemplates;
        const baseName = typeAssociatedName ? `${typeAssociatedName}.${name}` : (name as string);
        this.fullName = functionNameWithParamTypes(
            baseName,
            params.map((p) => p.type)
        );

        // Collect type params from the where clause (types with trait bounds)
        const typeParamNames = new Set<string>();
        typeTraits.forEach(({ type, trait }) => {
            if (!(type instanceof CustomType)) {
                throw new Error(`type alias ${type} overrides a builtin type.`);
            }
            if (!(trait instanceof CustomType)) {
                throw new Error(`${trait} is not a valid trait name.`);
            }
            typeParamNames.add(type.name);
            const addTraitToTypeParam = (t: Type): void => {
                if (t instanceof CustomType && t.name === type.name) {
                    t.addTrait(trait.name);
                } else if (t instanceof ArrayType) {
                    addTraitToTypeParam(t.innerType);
                } else if (t instanceof IterType) {
                    addTraitToTypeParam(t.innerType);
                } else if (t instanceof MutArrType) {
                    addTraitToTypeParam(t.innerType);
                } else if (t instanceof TupleType) {
                    t.types.forEach((tt) => addTraitToTypeParam(tt));
                } else if (t instanceof FuncType) {
                    t.paramTypes.forEach((pt) => addTraitToTypeParam(pt));
                    addTraitToTypeParam(t.returnType);
                } else if (t instanceof MaybeType) {
                    addTraitToTypeParam(t.innerType);
                } else if (t instanceof CustomType && t.templateArgs) {
                    t.templateArgs.forEach((ta) => addTraitToTypeParam(ta));
                }
            };
            this.params.forEach((param) => addTraitToTypeParam(param.type));
            addTraitToTypeParam(this.returnType);
        });
        this.typeParams = [...typeParamNames];

        // When creating a monomorphized function programmatically, the types might
        // reference outer function type params — skip validation in that case.
        if (!skipTypeValidation) {
            // Validate: every type parameter must appear in at least one parameter type,
            // otherwise it can never be inferred from call arguments.
            // (Skip this check for type-associated functions — the type param can be
            // inferred from the template types on the associated type, e.g., Arr[T].empty.)
            if (!this.typeAssociatedName) {
                const paramTypeNames = new Set<string>();
                this.params.forEach((p) => collectCustomTypeNames(p.type, paramTypeNames));
                for (const tp of this.typeParams) {
                    if (!paramTypeNames.has(tp)) {
                        throw new Error(
                            `generic type parameter '${tp}' of function '${this.name}' must appear ` +
                                `in the type of at least one parameter so it can be inferred.`
                        );
                    }
                }
            }

            // Validate: every non-builtin CustomType in the signature that isn't a type param
            // is unresolvable. (Scope-based lookup will provide the real type during cascadeTypes.)
            const signatureTypes = new Set<string>();
            this.params.forEach((p) => collectCustomTypeNames(p.type, signatureTypes));
            collectCustomTypeNames(returnType, signatureTypes);
            for (const name of signatureTypes) {
                if (!isBuiltinTypeName(name) && !typeParamNames.has(name)) {
                    // Allow unknown type names — they'll be resolved via scope during cascadeTypes.
                    // If the type truly doesn't exist, cascadeTypes will throw an appropriate error.
                }
            }
        }

        this.type = "Null";
    }

    get isGeneric(): boolean {
        return this.typeParams.length > 0;
    }

    getScope(): Scope | null {
        return this.scope;
    }

    cascadeTypes(parent: Expression | null, valueUsed: boolean): void {
        super.cascadeTypes(parent, valueUsed);

        // Register this function's name in the enclosing scope so call resolution
        // can find it. Register all functions (zero-param and generic) in scope.
        // Module-level functions register in their own module's scope (for injection
        // into the importing scope by UseModule.cascadeTypes).
        // Skip type-associated functions (TAFs) — they're accessed via TypeName.funcName
        // syntax and not by bare function name.
        // Skip monomorphized clones — they're inserted before the generic by monomorphize().
        // Skip functions with params — they can't be referenced as values without type annotations.
        // Register this function in the enclosing scope BEFORE the body cascade
        // so recursive calls within the body can find this function.
        if (this.name && !this.isMonomorphizedClone) {
            const preEnclosingScope = this.parent?.getScope();
            if (preEnclosingScope) {
                const preScopeName = this.typeAssociatedName
                    ? `${this.typeAssociatedName}.${this.name}`
                    : this.name;
                preEnclosingScope.defineVariable(
                    {
                        class: "func",
                        name: preScopeName,
                        type: this.getFuncType(),
                        isGeneric: this.isGeneric,
                        fullName: this.fullName,
                        def: this.isGeneric ? this : undefined,
                        paramNames: this.params.map((p) => p.name),
                    },
                    true
                );
            }
        }

        // Chain this function's scope to the enclosing scope so lookups from inside
        // the body can reach outer variables (including the function's own name for recursion).
        if (this.parent && this.scope.parent === null) {
            this.scope.parent = this.parent.getScope();
        }

        // Resolve CustomType references in param/return types that are actually enums.
        // (During parsing, enum names resolve to CustomType because the enum registry is gone.)
        const resolveEnumTypes = (t: Type): Type => {
            if (t instanceof CustomType && !isBuiltinTypeName(t.name)) {
                const enumCheck = this.parent?.getScope()?.lookup(t.name);
                if (enumCheck && enumCheck.attrs.class === "enum") {
                    // If this is a generic enum with concrete template args (e.g., Option[Str]),
                    // monomorphize it to get concrete variant types.
                    if (
                        enumCheck.attrs.isGeneric &&
                        enumCheck.attrs.def &&
                        t.templateArgs &&
                        t.templateArgs.length > 0
                    ) {
                        const enumDefNode = enumCheck.attrs.def as EnumDef;
                        const result = enumDefNode.monomorphize(t.templateArgs);
                        if (result) {
                            return result.enumType;
                        }
                    }
                    return new EnumType(
                        enumCheck.attrs.name,
                        enumCheck.attrs.variants.map((v: { name: string; type: Type | null }) => ({
                            name: v.name,
                            type: v.type,
                        }))
                    );
                }
            }
            return t;
        };
        for (const param of this.params) {
            param.type = resolveEnumTypes(param.type);
        }
        this.returnType = resolveEnumTypes(this.returnType);

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
        // Register type params (e.g. `T` in `func foo(x: T) where T is Any`) in scope
        // so they can be used as type references (e.g. `T.zero()` inside the body).
        for (const tp of this.typeParams) {
            const traits: string[] = [];
            for (const param of this.params) {
                traits.push(...collectTraitsForTypeParam(param.type, tp));
            }
            const ct = new CustomType(tp);
            for (const t of traits) ct.addTrait(t);
            this.scope.defineVariable({
                class: "var",
                name: tp,
                type: ct,
                isMutable: false,
                isConsumed: false,
            });
        }
        // Chain the body scope to this function's scope so lookups from inside the body
        // can find parameters and (eventually) the function's own name for recursion.
        this.body.scope.parent = this.scope;

        // Body: last expression is the return value (always consumed).
        // Block.cascadeTypes handles per-expression valueUsed propagation.
        if (this.isGeneric) {
            this.body.cascadeTypes(this, true);
            return;
        }
        this.body.cascadeTypes(this, true);

        // Unwrap EscapeType from body type (functions ending in `return expr` have
        // an Escape-typed body, but we compare the inner value type against the return type).
        const bodyType =
            this.body.type instanceof EscapeType ? this.body.type.innerType : this.body.type;

        if (this.returnType === "Null" && bodyType !== null && bodyType !== "Null") {
            this.returnType = bodyType;
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

        // Update the scope entry with the (possibly inferred) return type.
        // The function was registered before the body cascade; now update the type.
        if (this.name && !this.isMonomorphizedClone) {
            const postEnclosingScope = this.parent?.getScope();
            if (postEnclosingScope) {
                postEnclosingScope.updateFuncType(this.fullName, this.getFuncType());
            }
        }
    }

    getFuncType(): FuncType {
        return new FuncType(
            this.params.map((p) => p.type),
            this.returnType
        );
    }

    monomorphize(
        argTypes: Type[],
        /** Optional parent to use for the monomorphized function's cascade instead
         *  of this.parent. Used when monomorphizing a function from an imported
         *  module — the call site's parent lets the cloned body's scope chain
         *  reach the importing file's scope (for trait dispatch, function lookup). */
        cascadeParent?: Expression | null
    ): { fullName: string; funcType: FuncType; returnType: Type } | null {
        if (!this.isGeneric) return null;
        if (this.params.length !== argTypes.length) return null;

        const bindings = new Map<string, Type>();
        if (!extractBindingsFromParams(this.params, argTypes, this.typeParams, bindings)) {
            return null;
        }

        for (const tp of this.typeParams) {
            if (!bindings.has(tp)) return null;
        }

        const concreteParamTypes = this.params.map((p) => substituteTypeParams(p.type, bindings));
        const concreteReturnType = substituteTypeParams(this.returnType, bindings);
        const monomorphizedFullName = functionNameWithParamTypes(this.name!, concreteParamTypes);

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
                                          const vars: {
                                              class: string;
                                              name: string;
                                              fullName?: string;
                                          }[] = [];
                                          let cur: typeof traitScope | null = traitScope;
                                          while (cur) {
                                              for (const v of cur.variables) {
                                                  vars.push(v);
                                              }
                                              cur = cur.parent;
                                          }
                                          return vars;
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
        // Propagate sourceFile to the cloned body BEFORE cascadeTypes, so
        // errors thrown during cascade show the correct source file.
        monomorphized.sourceFile = this.sourceFile;
        if (this.sourceFile !== undefined) {
            tagClonedTree(monomorphized.body, this.sourceFile);
        }

        // Cascade the entire monomorphized function, setting parent pointers
        // as we walk so ancestor lookups (findEnclosing) reach the main AST.
        // Use cascadeParent (the call site) if provided — this lets the cloned
        // body's scope chain reach the calling file's scope (for trait dispatch).
        monomorphized.cascadeTypes(cascadeParent ?? this.parent, true);

        // Check if a type is concrete by looking it up in the scope chain.
        // When cascadeParent is provided (cross-module monomorphization), use
        // its scope so types defined in the calling file are found.
        const scopeForConcreteCheck = cascadeParent ?? this;
        const isConcreteParam = (t: Type): boolean => {
            if (!(t instanceof CustomType)) return true;
            if (isBuiltinTypeName(t.name)) return true;
            const ps = scopeForConcreteCheck.getScope();
            if (ps) {
                const pl = ps.lookup(t.name);
                if (pl && pl.attrs.class === "struct") return true;
            }
            return false;
        };
        const allConcrete = clonedParams.every((p) => isConcreteParam(p.type));

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

        const finalReturnType =
            this.returnType === "Null" ? monomorphized.returnType : concreteReturnType;
        if (!typeEquals(monomorphizedBodyType, finalReturnType)) {
            throw new ASTError(
                this.line,
                this.col,
                `monomorphized function body should return ${finalReturnType}, but found ${monomorphized.body.type}`
            );
        }

        if (allConcrete) {
            this.monomorphizedVersions.push(monomorphized);

            // Insert the monomorphized version into the enclosing scope before the generic,
            // so subsequent lookups find the concrete version first.
            const enclosingScope = this.parent?.getScope();
            if (enclosingScope) {
                const genericInScope = enclosingScope.lookup(this.fullName);
                if (
                    genericInScope &&
                    genericInScope.attrs.class === "func" &&
                    genericInScope.attrs.isGeneric
                ) {
                    enclosingScope.defineVariableBefore(this.fullName, {
                        class: "func",
                        name: this.name!,
                        type: monomorphized.getFuncType(),
                        isGeneric: false,
                        fullName: monomorphizedFullName,
                    });
                }
            }
        }

        return {
            fullName: monomorphizedFullName,
            funcType: monomorphized.getFuncType(),
            returnType: monomorphized.returnType,
        };
    }

    /**
     * Monomorphize a generic TAF using pre-computed type bindings.
     * Unlike monomorphize(), this doesn't require the type params to appear
     * in function parameters — the bindings come from template matching.
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
        const clonedParams = this.params.map((p) => ({
            name: p.name,
            type: bindings ? substituteTypeParams(p.type, bindings) : p.type,
        }));
        const clonedReturnType = bindings
            ? substituteTypeParams(this.returnType, bindings)
            : this.returnType;
        const cloned = new FunctionDef(
            { line: this.line, col: this.col, text: this.name!, type: TokenType.Func },
            this.name!,
            clonedParams,
            clonedReturnType as Type,
            [],
            this.body.clone(bindings)
        );
        cloned.fullName = this.fullName;
        cloned.sourceFile = this.sourceFile;
        cloned.typeParams = [...this.typeParams];
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
