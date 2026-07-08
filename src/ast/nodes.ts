import { type Token } from "../tokens";
import type { JSWriter } from "../write-js";
import { Assignment } from "./assignment";
import { findCaller } from "./caller-resolution";
import { Block, Expression } from "./expression";

import {
    CustomType,
    FuncType,
    isBuiltinTypeName,
    IterType,
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

    toJS(writer: JSWriter): void {
        writer.write("[");
        this.elements.forEach((elem, i) => {
            if (i > 0) writer.write(", ");
            elem.toJS(writer);
        });
        writer.write("]");
    }
}
