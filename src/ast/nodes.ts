import { TokenType, type Token } from "../tokens";
import type { JSWriter } from "../write-js";
import {
    functionNameWithParamTypes,
} from "./caller-utils";
import { Assignment } from "./assignment";
import { ASTError, Block, Expression, lastExprShouldReturn } from "./expression";
import type { EnumDef } from "./enums";
import type { FunctionDef } from "./function-defs";
import type { StructDef } from "./structs";

import {
    CustomType,
    EnumType,
    EscapeType,
    FuncType,
    isBuiltinTypeName,
    IterType,
    substituteTypeParams,
    TemplateTypes,
    TupleType,
    type Type,
} from "./types";

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
                    // Check if this variable was consumed
                    // Variables consumed cannot be used afterward.
                    if (attrs.isConsumed) {
                        throw this.error(
                            `cannot use variable '${this.name}' after it was consumed`
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
                // if (
                //     fn instanceof FunctionDef &&
                //     fn.isGeneric &&
                //     fn.typeParams.includes(this.name)
                // ) {
                //     const traits: string[] = [];
                //     for (const param of fn.params) {
                //         traits.push(...collectTraitsForTypeParam(param.type, this.name));
                //     }
                //     const ct = new CustomType(this.name);
                //     for (const t of traits) ct.addTrait(t);
                //     this.type = ct;
                //     this.fullName = this.name;
                //     return;
                // }
                // fn = fn.parent;
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
