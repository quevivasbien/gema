import { TokenType, type Token } from "../tokens";
import type { JSWriter } from "../write-js";
import {
    checkTraitSatisfied,
    extractBindingsFromParams,
    functionNameWithParamTypes,
} from "./caller-utils";
import { ASTError, Block, DropValue, Expression, lastExprShouldReturn } from "./expression";
import { EnumDef, Match } from "./enums";
import {
    findFunction,
    getEnum,
    getMonomorphized,
    getStruct,
    getTrait,
    isCrossModuleRefAllowed,
    isVarConsumed,
    registerFunction,
    registerMonomorphized,
    restoreConsumedVars,
    saveConsumedVars,
} from "./registries";
import { setParentPointers } from "./set-parent-pointers";
import { collectTraitsForTypeParam, deepEquals } from "./type-utils";
import {
    ArrayType,
    collectCustomTypeNames,
    CustomType,
    EnumType,
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
 * Compile-time `use` directive: loads another module's definitions.
 * Generates no runtime code — handled entirely during compilation.
 * TODO: Does this even need to be part of the AST? Maybe we should rework so that modules actually
 *  live entirely within a "UseModule" AST node?
 */
export class UseModule extends Expression {
    constructor(
        rootToken: Token,
        public path: string,
        public symbols?: string[]
    ) {
        super(rootToken.line, rootToken.col);
        this.type = "Null";
    }

    toJS(_writer: JSWriter): void {
        // No runtime code generated for `use` directives.
    }

    clone(_bindings?: Map<string, Type>): Expression {
        return new UseModule(
            { line: this.line, col: this.col, text: "use", type: TokenType.Use },
            this.path,
            this.symbols ? [...this.symbols] : undefined
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
    start: Expression | null;
    end: Expression | null;
    step: Expression | null;

    constructor(
        startToken: Token,
        start: Expression | null,
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
        if (this.start !== null) {
            this.start.cascadeTypes(this, true);
            if (this.start.type !== "Int") {
                throw this.error("range start must be an integer");
            }
        }
        if (this.end !== null) {
            this.end.cascadeTypes(this, true);
            if (this.end.type !== "Int") {
                throw this.error("range end must be an integer");
            }
        }
        if (this.step !== null) {
            this.step.cascadeTypes(this, true);
            if (this.step.type !== "Int") {
                throw this.error("range step must be an integer");
            }
        }

        this.type = new IterType("Int");
    }

    clone(bindings?: Map<string, Type>): Expression {
        return new RangeIter(
            { line: this.line, col: this.col, text: "..", type: TokenType.DotDot },
            this.start ? this.start.clone(bindings) : null,
            this.end ? this.end.clone(bindings) : null,
            this.step ? this.step.clone(bindings) : null
        );
    }

    toJS(writer: JSWriter): void {
        writer.useBuiltin("$RangeIterator$");
        writer.write("new $RangeIterator$(");
        if (this.start !== null) {
            this.start.toJS(writer);
        } else {
            writer.write("0n");
        }
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
        // Check global registry first (for non-generic or already-monomorphized functions)
        const registered = findFunction(this.fullName);
        if (registered) {
            this.type = registered.getFuncType();
            return;
        }
        // Walk up parent chain scanning older siblings in each enclosing Block
        const found = this.walkEnclosingBlocks((olderSiblings) => {
            for (let j = olderSiblings.length - 1; j >= 0; j--) {
                let olderSibling = olderSiblings[j];
                if (olderSibling instanceof DropValue) {
                    olderSibling = olderSibling.child;
                }
                // Exact match on fullName (non-generic or already monomorphized)
                if (
                    olderSibling instanceof FunctionDef &&
                    olderSibling.fullName === this.fullName
                ) {
                    this.type = olderSibling.getFuncType();
                    return true;
                }
                // Generic function match — attempt monomorphization
                if (
                    olderSibling instanceof FunctionDef &&
                    olderSibling.name === this.name &&
                    olderSibling.isGeneric
                ) {
                    const argTypes = this.templateTypes?.types ?? [];
                    const result = olderSibling.monomorphize(argTypes);
                    if (result !== null) {
                        this.fullName = result.fullName;
                        this.type = result.funcType;
                        return true;
                    }
                }
            }
            return false;
        });
        if (
            !found &&
            (isBuiltinTypeName(this.name) || getStruct(this.name) || getEnum(this.name))
        ) {
            // Fall back to type reference (e.g., Arr[Int] → type Arr with template [Int])
            this.type = new CustomType(this.name);
            this.fullName = this.name;
            return;
        }
        if (!found) {
            throw this.error(`cannot resolve type of variable '${this}'`);
        }
    }

    resolveAssignment(e: Expression): Type | null {
        if (e instanceof Assignment && e.name === this.name) {
            return e.value.type;
        }
        return null;
    }

    /** Recursively search an expression tree for an Assignment with the given name,
     *  e.g. to find `y` inside `Assignment(x, Assignment(y, 2))`. */
    private findNestedAssignment(expr: Expression, name: string): Type | null {
        if (expr instanceof Assignment) {
            if (expr.name === name) return expr.value.type;
            return this.findNestedAssignment(expr.value, name);
        }
        if (expr instanceof DropValue) {
            return this.findNestedAssignment(expr.child, name);
        }
        return null;
    }

    cascadeTypes(parent: Expression | null, valueUsed: boolean): void {
        super.cascadeTypes(parent, valueUsed);
        if (!this.templateTypes.empty()) {
            this.setTypeWithTemplateTypes();
            return;
        }
        // Walk up parent chain checking enclosing contexts for variable definitions.
        // 'child' tracks the expression at each level that leads back to this variable,
        // so we can correctly identify sibling positions in Blocks.
        let child: Expression | null = null;
        let node: Expression | null = this.parent;
        while (node) {
            // TODO: Probably the way to handle this is to have each expression type report on the variables it defines rather than asking the Variable to climb up and check everyone's definitions
            // Check Function/AnonymousFunction params
            if (node instanceof FunctionDef || node instanceof AnonymousFunction) {
                for (const param of node.params) {
                    if (param.name === this.name && param.type !== null) {
                        this.type = param.type;
                        this.fullName = this.name;
                        return;
                    }
                }
            }
            // Check ForLoop variable (skip infinite loops with no iterator)
            if (node instanceof ForLoop && node.iter !== null && node.varName === this.name) {
                let innerType: Type = "Int";
                if (node.iter.type instanceof ArrayType) {
                    innerType = node.iter.type.innerType;
                } else if (node.iter.type instanceof IterType) {
                    innerType = node.iter.type.innerType;
                } else if (node.iter.type instanceof MutArrType) {
                    innerType = node.iter.type.innerType;
                } else if (node.iter.type === "Str") {
                    innerType = "Str";
                }
                this.type = innerType;
                this.fullName = this.name;
                return;
            }
            // Check Match arm bindings (some(v) or variantName(v))
            // (only if this Variable is inside the arm body, not the scrutinee itself)
            if (node instanceof Match && this !== node.scrutinee) {
                for (const arm of node.arms) {
                    if (
                        (arm.kind === "some" || arm.kind === "variant") &&
                        arm.binding === this.name
                    ) {
                        this.type = arm.bindingType;
                        this.fullName = this.name;
                        return;
                    }
                }
            }
            // Scan older siblings in Blocks (only when child is a direct expression of the Block)
            if (node instanceof Block) {
                const idx = node.expressions.indexOf(child ?? this);
                if (idx > 0) {
                    const olderSiblings = node.expressions.slice(0, idx);
                    for (let j = olderSiblings.length - 1; j >= 0; j--) {
                        let sib = olderSiblings[j];
                        const type = this.resolveAssignment(sib);
                        if (type !== null) {
                            // Skip cross-module assignments unless allowed by import rules.
                            if (
                                !isCrossModuleRefAllowed(this.sourceFile, sib.sourceFile, this.name)
                            )
                                continue;
                            this.type = type;
                            this.fullName = this.name;
                            if (isVarConsumed(this.fullName)) {
                                throw this.error(
                                    `cannot use variable '${this.fullName}' after it was detrans'd`
                                );
                            }
                            return;
                        }
                        if (sib instanceof DropValue) {
                            sib = sib.child;
                            // Skip cross-module definitions unless allowed by import rules.
                            if (
                                !isCrossModuleRefAllowed(this.sourceFile, sib.sourceFile, this.name)
                            )
                                continue;
                            const innerType = this.resolveAssignment(sib);
                            if (innerType !== null) {
                                this.type = innerType;
                                this.fullName = this.name;
                                if (isVarConsumed(this.fullName)) {
                                    throw this.error(
                                        `cannot use variable '${this.fullName}' after it was detrans'd`
                                    );
                                }
                                return;
                            }
                        }
                        if (sib instanceof Assignment && sib.name !== this.name) {
                            // Skip cross-module definitions unless allowed by import rules.
                            if (
                                !isCrossModuleRefAllowed(this.sourceFile, sib.sourceFile, this.name)
                            )
                                continue;
                            const nested = this.findNestedAssignment(sib.value, this.name);
                            if (nested !== null) {
                                this.type = nested;
                                this.fullName = this.name;
                                if (isVarConsumed(this.fullName)) {
                                    throw this.error(
                                        `cannot use variable '${this.fullName}' after it was detrans'd`
                                    );
                                }
                                return;
                            }
                        }
                        if (sib instanceof TupleUnpack) {
                            // Skip cross-module definitions unless allowed by import rules.
                            if (
                                !isCrossModuleRefAllowed(this.sourceFile, sib.sourceFile, this.name)
                            )
                                continue;
                            const binding = sib.bindings.find((b) => b.name === this.name);
                            if (binding) {
                                const idx = sib.bindings.indexOf(binding);
                                if (sib.source.type instanceof TupleType) {
                                    this.type = sib.source.type.types[idx];
                                    this.fullName = this.name;
                                    if (isVarConsumed(this.fullName)) {
                                        throw this.error(
                                            `cannot use variable '${this.fullName}' after it was detrans'd`
                                        );
                                    }
                                    return;
                                }
                            }
                        }
                        if (sib instanceof DropValue) sib = sib.child;
                        if (
                            sib instanceof FunctionDef &&
                            sib.name === this.name &&
                            sib.params.length === 0 &&
                            sib.fullName !== null
                        ) {
                            // Skip functions from a different module unless allowed by import rules.
                            if (
                                !isCrossModuleRefAllowed(this.sourceFile, sib.sourceFile, this.name)
                            )
                                continue;
                            this.type = sib.getFuncType();
                            this.fullName = sib.fullName;
                            return;
                        }
                        if (sib instanceof EnumDef && sib.name === this.name) {
                            // Skip enums from a different module unless allowed by import rules.
                            if (
                                !isCrossModuleRefAllowed(this.sourceFile, sib.sourceFile, this.name)
                            )
                                continue;
                            const variants = sib.variants.map((v) => ({
                                name: v.name,
                                type: v.type,
                            }));
                            this.type = new EnumType(sib.name, variants);
                            this.fullName = sib.name;
                            return;
                        }
                    }
                }
            }
            child = node;
            node = node.parent;
        }

        // Fallback: type param from enclosing generic function (e.g., T in T.zero())
        if (!isBuiltinTypeName(this.name) && !getStruct(this.name) && !getEnum(this.name)) {
            let fn: Expression | null = this.parent;
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

        // Fallback: builtin type name used as a type reference (e.g., Int in Int.zero())
        if (isBuiltinTypeName(this.name) || getStruct(this.name) || getEnum(this.name)) {
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
    params: { name: string; type: Type }[];
    body: Block;
    returnType: Type | null;
    /** Whether this function has unresolved (null) param types that need inference. */
    needsInference: boolean = false;
    /** Need to maintain a list of any return statements this function has,
     * so we can check that they return a value whose type matches
     * the return type of this function */
    returnStatements: Return[] = [];

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
    fillParams(types: Type[]): void {
        if (!this.needsInference) return;
        for (let i = 0; i < this.params.length; i++) {
            this.params[i].type = types[i] ?? this.params[i].type;
        }
        this.needsInference = false;
        // Body: last expression is the return value (always consumed).
        this.body.cascadeTypes(this, true);
        const bodyReturnType = this.body.type;
        if (bodyReturnType === null) {
            throw this.error(`unable to resolve return type of function.`);
        }
        if (this.returnType !== null && !deepEquals(bodyReturnType, this.returnType)) {
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
        this.body.cascadeTypes(this, true);
        const bodyReturnType = this.body.type;
        if (bodyReturnType === null) {
            throw this.error(`unable to resolve return type of function.`);
        }
        if (this.returnType !== null && !deepEquals(bodyReturnType, this.returnType)) {
            throw this.error(
                `anonymous function body should return ${this.returnType}, but found ${bodyReturnType}`
            );
        }
        for (const s of this.returnStatements) {
            if (!deepEquals(s.value.type, this.returnType)) {
                throw new ASTError(
                    s.line,
                    s.col,
                    `anonymous function with return type ${this.returnType} has a return statement that returns a value of type ${s.value.type}`
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
            if (expr instanceof Return) return expr.needsExceptionForControlFlow();
            if (expr instanceof DropValue) return check(expr.child);
            if (expr instanceof Block) return expr.expressions.some((e) => check(e));
            if (expr instanceof If) {
                return (
                    expr.conditionalBranches.some((b) => check(b.branch)) || check(expr.elseBranch)
                );
            }
            if (expr instanceof ForLoop) return check(expr.body);
            for (const key of ["child", "value"] as const) {
                const child = (expr as unknown as Record<string, Expression | undefined>)[key];
                if (child && typeof child === "object" && child.constructor?.name) {
                    if (check(child)) return true;
                }
            }
            return false;
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

export class FunctionDef extends Expression {
    name: string | null;
    params: { name: string; type: Type }[];
    returnType: Type;
    body: Block;
    fullName: string;
    typeParams: string[] = [];
    scope: Scope = new Scope(); // TODO: Fill this in when function is concretized
    monomorphizedVersions: FunctionDef[] = [];
    /** Need to maintain a list of any return statements this function has,
     * so we can check that they return a value whose type matches
     * the return type of this function */
    returnStatements: Return[] = [];
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

            // Validate: every non-builtin, non-struct CustomType in the signature must be a type param
            const signatureTypes = new Set<string>();
            this.params.forEach((p) => collectCustomTypeNames(p.type, signatureTypes));
            collectCustomTypeNames(returnType, signatureTypes);
            for (const name of signatureTypes) {
                if (
                    !isBuiltinTypeName(name) &&
                    !getStruct(name) &&
                    !getTrait(name) &&
                    !getEnum(name) &&
                    !typeParamNames.has(name)
                ) {
                    throw new Error(
                        `unknown type '${name}' — if it's a generic type parameter, add it to a 'where' clause with a trait bound (e.g., 'where ${name} is SomeTrait')`
                    );
                }
            }
        }

        this.type = "Null";

        // Register in the global function registry (non-generic functions only)
        if (this.name && !this.isGeneric) {
            registerFunction(this);
        }
    }

    get isGeneric(): boolean {
        return this.typeParams.length > 0;
    }

    getScope(): Scope | null {
        this.scope;
    }

    cascadeTypes(parent: Expression | null, valueUsed: boolean): void {
        super.cascadeTypes(parent, valueUsed);
        // Body: last expression is the return value (always consumed).
        // Block.cascadeTypes handles per-expression valueUsed propagation.
        if (this.isGeneric) {
            this.body.cascadeTypes(this, true);
            return;
        }
        // Save/restore consumedVars so detrans inside function bodies doesn't
        // leak consumed status to outer scopes
        const savedConsumed = saveConsumedVars();
        this.body.cascadeTypes(this, true);
        restoreConsumedVars(savedConsumed);

        if (this.returnType === "Null" && this.body.type !== null && this.body.type !== "Null") {
            this.returnType = this.body.type;
        }

        if (!deepEquals(this.body.type, this.returnType)) {
            throw this.error(
                `function body should return ${this.returnType}, but found ${this.body.type}`
            );
        }

        for (const s of this.returnStatements) {
            if (!deepEquals(s.value.type, this.returnType)) {
                throw new ASTError(
                    s.line,
                    s.col,
                    `function ${this.name} with return type ${this.returnType} has a return statement that returns a value of type ${s.value.type}`
                );
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
        argTypes: Type[]
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

        const cached = getMonomorphized(monomorphizedFullName);
        if (cached) {
            return {
                fullName: monomorphizedFullName,
                funcType: cached.getFuncType(),
                returnType: concreteReturnType,
            };
        }

        for (const param of this.params) {
            if (param.type instanceof CustomType && param.type.traits.length > 0) {
                const concreteType = substituteTypeParams(param.type, bindings);
                const isConcrete =
                    !(concreteType instanceof CustomType) ||
                    isBuiltinTypeName(concreteType.name) ||
                    getStruct(concreteType.name) !== undefined;
                if (isConcrete) {
                    for (const traitName of param.type.traits) {
                        if (!checkTraitSatisfied(concreteType, traitName, this.name!)) {
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

        // Fix parent pointers on the cloned subtree so findEnclosing() works
        // during cascadeTypes of the monomorphized body.
        // Link the monomorphized function into the parent chain by using
        // this function's parent so ancestor lookups reach the main AST.
        setParentPointers(monomorphized, this.parent);

        const allConcrete = clonedParams.every(
            (p) =>
                !(p.type instanceof CustomType) ||
                isBuiltinTypeName(p.type.name) ||
                getStruct(p.type.name) !== undefined
        );

        // Last body expression is return value (always consumed).
        monomorphized.body.cascadeTypes(this, true);
        monomorphized.sourceFile = this.sourceFile;

        if (
            this.returnType === "Null" &&
            monomorphized.body.type !== null &&
            monomorphized.body.type !== "Null"
        ) {
            monomorphized.returnType = monomorphized.body.type;
        }

        const finalReturnType =
            this.returnType === "Null" ? monomorphized.returnType : concreteReturnType;
        if (!deepEquals(monomorphized.body.type, finalReturnType)) {
            throw new ASTError(
                this.line,
                this.col,
                `monomorphized function body should return ${finalReturnType}, but found ${monomorphized.body.type}`
            );
        }

        if (allConcrete) {
            registerMonomorphized(monomorphizedFullName, monomorphized);
            this.monomorphizedVersions.push(monomorphized);
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

        const cached = getMonomorphized(monomorphizedFullName);
        if (cached) {
            return {
                fullName: monomorphizedFullName,
                funcType: cached.getFuncType(),
                returnType: concreteReturnType,
            };
        }

        // Verify trait satisfaction
        for (const param of this.params) {
            if (param.type instanceof CustomType && param.type.traits.length > 0) {
                const concreteType = substituteTypeParams(param.type, bindings);
                const isConcrete =
                    !(concreteType instanceof CustomType) ||
                    isBuiltinTypeName(concreteType.name) ||
                    getStruct(concreteType.name) !== undefined;
                if (isConcrete) {
                    for (const traitName of param.type.traits) {
                        if (!checkTraitSatisfied(concreteType, traitName, this.name!)) {
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

        setParentPointers(monomorphized, this.parent);
        monomorphized.body.cascadeTypes(this, true);
        monomorphized.sourceFile = this.sourceFile;

        if (
            this.returnType === "Null" &&
            monomorphized.body.type !== null &&
            monomorphized.body.type !== "Null"
        ) {
            monomorphized.returnType = monomorphized.body.type;
        }

        const allConcrete = clonedParams.every(
            (p) =>
                !(p.type instanceof CustomType) ||
                isBuiltinTypeName(p.type.name) ||
                getStruct(p.type.name) !== undefined
        );

        if (allConcrete) {
            registerMonomorphized(monomorphizedFullName, monomorphized);
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
            if (expr instanceof Return) return expr.needsExceptionForControlFlow();
            if (expr instanceof DropValue) return check(expr.child);
            if (expr instanceof Block) return expr.expressions.some((e) => check(e));
            if (expr instanceof If) {
                return (
                    expr.conditionalBranches.some((b) => check(b.branch)) || check(expr.elseBranch)
                );
            }
            if (expr instanceof ForLoop) return check(expr.body);
            for (const key of ["child", "value"] as const) {
                const child = (expr as unknown as Record<string, Expression | undefined>)[key];
                if (child && typeof child === "object" && child.constructor?.name) {
                    if (check(child)) return true;
                }
            }
            return false;
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
