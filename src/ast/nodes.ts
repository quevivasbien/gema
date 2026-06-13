import type { JSWriter } from "../write-js";
import { TokenType, type Token } from "../tokens";
import { deepEquals } from "../deep-equals";
import {
    ArrayType,
    IterType,
    MutArrType,
    TupleType,
    substituteTypeParams,
    isBuiltinTypeName,
    collectCustomTypeNames,
    FuncType,
    CustomType,
    TemplateTypes,
    type Type,
} from "../types";
import { ASTError, Expression, DropValue } from "./expression";
import {
    functionNameWithParamTypes,
    extractBindingsFromParams,
    checkTraitSatisfied,
} from "./caller-utils";
import {
    findFunction,
    registerFunction,
    getMonomorphized,
    registerMonomorphized,
    getTrait,
    getStruct,
    isVarConsumed,
} from "./registries";

export class Block extends Expression {
    constructor(
        rootToken: Token,
        public expressions: Expression[]
    ) {
        if (expressions.length === 0) {
            throw new Error("block expression must not be empty.");
        }
        super(rootToken.line, rootToken.col);
    }

    cascadeTypes(ancestors: Expression[]): void {
        for (const expression of this.expressions) {
            expression.cascadeTypes([...ancestors, this]);
        }
        this.type = this.expressions[this.expressions.length - 1].type;
    }

    clone(bindings?: Map<string, Type>): Expression {
        return new Block(
            { line: this.line, col: this.col, text: "", type: TokenType.LBrace },
            this.expressions.map((e) => e.clone(bindings))
        );
    }

    toJS(writer: JSWriter): void {
        writer.write("(() => ");
        writer.beginScope();
        for (const expression of this.expressions.slice(0, -1)) {
            expression.toJS(writer);
            writer.write(";");
            writer.newLine();
        }
        const lastExpr = this.expressions[this.expressions.length - 1];
        if (
            lastExpr instanceof DropValue ||
            (lastExpr instanceof Assignment && lastExpr.isDropped)
        ) {
            lastExpr.toJS(writer);
            writer.write(";");
            writer.newLine();
            writer.write("return null;");
        } else {
            writer.write("return ");
            lastExpr.toJS(writer);
            writer.write(";");
        }
        writer.endScope();
        writer.write(")()");
    }
}

export class If extends Expression {
    conditionalBranches: { condition: Expression; branch: Block }[];
    elseBranch: Block;
    hasElse: boolean;

    constructor(
        rootToken: Token,
        conditionalBranches: { condition: Expression; branch: Expression }[],
        elseBranch: Expression,
        hasElse: boolean = true
    ) {
        super(rootToken.line, rootToken.col);

        conditionalBranches.forEach(({ branch }) => {
            if (!(branch instanceof Block)) {
                throw new Error("branch of if statement must be a block (enclosed by '{' and '}')");
            }
        });
        if (!(elseBranch instanceof Block)) {
            throw new Error("else branch of if statement must be a block");
        }

        this.conditionalBranches = conditionalBranches as {
            condition: Expression;
            branch: Block;
        }[];
        this.elseBranch = elseBranch;
        this.hasElse = hasElse;
    }

    cascadeTypes(ancestors: Expression[]): void {
        this.elseBranch.cascadeTypes([...ancestors, this]);

        this.conditionalBranches.forEach(({ condition, branch }) => {
            condition.cascadeTypes([...ancestors, this]);
            if (condition.type !== "Bool") {
                throw this.error(`condition must be boolean, but found ${condition.type}`);
            }
            branch.cascadeTypes([...ancestors, this]);
            if (this.hasElse && !deepEquals(this.elseBranch.type, branch.type)) {
                throw this.error(
                    `all branches of if expression must have the same type, but found branches of types ${branch.type} and ${this.elseBranch.type}`
                );
            }
        });

        this.type = this.hasElse ? this.elseBranch.type : "Null";
    }

    clone(bindings?: Map<string, Type>): Expression {
        const cloned = new If(
            { line: this.line, col: this.col, text: "if", type: TokenType.If },
            this.conditionalBranches.map(({ condition, branch }) => ({
                condition: condition.clone(bindings),
                branch: branch.clone(bindings),
            })),
            this.elseBranch.clone(bindings),
            this.hasElse
        );
        return cloned;
    }

    toJS(writer: JSWriter): void {
        if (this.hasElse) {
            writer.write("(() => {");
            writer.indentIn();
            writer.newLine();
            this.conditionalBranches.forEach(({ condition, branch }) => {
                writer.write("if (");
                condition.toJS(writer);
                writer.write(") ");
                writer.beginScope();
                branch.expressions.forEach((expr, i) => {
                    if (i === branch.expressions.length - 1) {
                        writer.write("return ");
                    }
                    expr.toJS(writer);
                    writer.write(";");
                    writer.newLine();
                });
                writer.endScope();
                writer.write(" else ");
            });
            writer.beginScope();
            this.elseBranch.expressions.forEach((expr, i) => {
                if (i === this.elseBranch!.expressions.length - 1) {
                    writer.write("return ");
                }
                expr.toJS(writer);
                writer.write(";");
                writer.newLine();
            });
            writer.endScope();
            writer.indentOut();
            writer.newLine();
            writer.write("})()");
        } else {
            this.conditionalBranches.forEach(({ condition, branch }) => {
                writer.write("if (");
                condition.toJS(writer);
                writer.write(") ");
                writer.beginScope();
                branch.expressions.forEach((expr) => {
                    expr.toJS(writer);
                    writer.write(";");
                    writer.newLine();
                });
                writer.endScope();
            });
        }
    }
}

export class ForLoop extends Expression {
    varName: string;
    iter: Expression;
    body: Block;

    constructor(startToken: Token, varName: string, iter: Expression, body: Block) {
        super(startToken.line, startToken.col);
        this.varName = varName;
        this.iter = iter;
        this.body = body;
        this.type = "Null";
    }

    cascadeTypes(ancestors: Expression[]): void {
        this.iter.cascadeTypes([...ancestors, this]);
        if (this.iter.type === null) {
            throw this.error("unable to resolve type of iterator");
        }
        let _innerType: Type;
        if (this.iter.type instanceof ArrayType) {
            _innerType = this.iter.type.innerType;
        } else if (this.iter.type instanceof IterType) {
            _innerType = this.iter.type.innerType;
        } else if (this.iter.type instanceof MutArrType) {
            _innerType = this.iter.type.innerType;
        } else if (this.iter.type === "Str") {
            _innerType = "Str";
        } else {
            throw this.error(`cannot iterate over object of type ${this.iter.type}`);
        }
        this.body.cascadeTypes([...ancestors, this]);
    }

    clone(bindings?: Map<string, Type>): Expression {
        return new ForLoop(
            { line: this.line, col: this.col, text: "for", type: TokenType.For },
            this.varName,
            this.iter.clone(bindings),
            this.body.clone(bindings) as Block
        );
    }

    toJS(writer: JSWriter): void {
        const iterVar = `_iter_${this.varName}`;
        const safeIterVar = writer.safeName(iterVar);
        const safeVarName = writer.safeName(this.varName);

        if (this.iter.type instanceof ArrayType || this.iter.type instanceof MutArrType) {
            writer.useBuiltin("__ARRAYITER__");
            writer.write(`const ${safeIterVar} = __ARRAYITER__(`);
            this.iter.toJS(writer);
            writer.write(");");
            writer.newLine();
        } else if (this.iter.type === "Str") {
            writer.write(`const ${safeIterVar} = __ARRAYITER__(`);
            this.iter.toJS(writer);
            writer.write(`.split(""));`);
            writer.newLine();
        } else {
            writer.write(`const ${safeIterVar} = `);
            this.iter.toJS(writer);
            writer.write(";");
            writer.newLine();
        }

        writer.write("while (true) {");
        writer.indentIn();
        writer.newLine();
        writer.write(`const ${safeVarName} = ${safeIterVar}.next();`);
        writer.newLine();
        writer.write(`if (${safeVarName} === undefined) break;`);
        writer.newLine();

        this.body.expressions.forEach((expr) => {
            expr.toJS(writer);
            writer.write(";");
            writer.newLine();
        });

        writer.indentOut();
        writer.newLine();
        writer.write("}");
        writer.newLine();
        writer.write(`${safeIterVar}.reset();`);
    }
}

export class Break extends Expression {
    constructor(startToken: Token) {
        super(startToken.line, startToken.col);
        this.type = "Null";
    }

    cascadeTypes(_ancestors: Expression[]): void {
        // Break is always valid; type is Null
    }

    clone(_bindings?: Map<string, Type>): Expression {
        return new Break({ line: this.line, col: this.col, text: "break", type: TokenType.Break });
    }

    toJS(writer: JSWriter): void {
        writer.write("break");
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

    cascadeTypes(ancestors: Expression[]): void {
        if (this.start !== null) {
            this.start.cascadeTypes(ancestors);
            if (this.start.type !== "Int") {
                throw this.error("range start must be an integer");
            }
        }
        if (this.end !== null) {
            this.end.cascadeTypes(ancestors);
            if (this.end.type !== "Int") {
                throw this.error("range end must be an integer");
            }
        }
        if (this.step !== null) {
            this.step.cascadeTypes(ancestors);
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
        writer.useBuiltin("__RANGEITER__");
        writer.write("__RANGEITER__(");
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
    constructor(
        startToken: Token,
        public elements: Expression[]
    ) {
        super(startToken.line, startToken.col);
        if (elements.length === 0) {
            throw new Error("tuple must not be empty");
        }
    }

    cascadeTypes(ancestors: Expression[]): void {
        const types: Type[] = [];
        for (let i = 0; i < this.elements.length; i++) {
            this.elements[i].cascadeTypes([...ancestors, this]);
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

export class TupleUnpack extends Expression {
    bindings: { name: string; isMutable: boolean; fullName?: string }[];
    source: Expression;

    constructor(
        startToken: Token,
        bindings: { name: string; isMutable: boolean }[],
        source: Expression
    ) {
        super(startToken.line, startToken.col);
        this.bindings = bindings;
        this.source = source;
    }

    cascadeTypes(ancestors: Expression[]): void {
        this.source.cascadeTypes([...ancestors, this]);
        if (this.source.type === null) {
            throw this.error("unable to resolve type of source expression");
        }
        if (!(this.source.type instanceof TupleType)) {
            throw this.error(`cannot unpack non-tuple expression of type ${this.source.type}`);
        }
        if (this.source.type.types.length !== this.bindings.length) {
            throw this.error(
                `tuple has ${this.source.type.types.length} elements but unpacking into ${this.bindings.length} variables`
            );
        }
        this.type = "Null";

        // Declare each binding as a variable (like writing a = src[0]; b = src[1]; ...)
        for (let i = 0; i < this.bindings.length; i++) {
            const binding = this.bindings[i];
            const elemType = this.source.type.types[i];

            // Check for existing variable with same name (reassignment semantics)
            const sameBlockDef = Assignment.findDefiningAssignment(binding.name, this, ancestors);
            const outerDef = sameBlockDef
                ? null
                : Assignment.findOuterDefinition(binding.name, this, ancestors);

            if (sameBlockDef !== null || outerDef !== null) {
                const existingDef = sameBlockDef ?? outerDef!;
                if (!existingDef.isMutable) {
                    throw this.error(`cannot reassign non-mutable variable '${binding.name}'`);
                }
                if (!deepEquals(existingDef.type, elemType)) {
                    throw this.error(
                        `cannot assign value of type ${elemType} to variable '${binding.name}' of type ${existingDef.type}`
                    );
                }
                binding.fullName = binding.name;
            } else {
                // New declaration
                binding.fullName = binding.name;
            }
        }
    }

    clone(bindings?: Map<string, Type>): Expression {
        return new TupleUnpack(
            { line: this.line, col: this.col, text: "(", type: TokenType.LParen },
            this.bindings.map((b) => ({ name: b.name, isMutable: b.isMutable })),
            this.source.clone(bindings)
        );
    }

    toJS(writer: JSWriter): void {
        for (let i = 0; i < this.bindings.length; i++) {
            const binding = this.bindings[i];
            const safeName = writer.safeName(binding.name);

            // Emit: let name; name = src[0];
            writer.declareVariable(binding.name);
            writer.write(`${safeName} = `);
            this.source.toJS(writer);
            writer.write(`[${i}]`);
            if (i < this.bindings.length - 1) {
                writer.write(";");
                writer.newLine();
            }
        }
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

    toString(): string {
        if (!this.templateTypes.empty()) {
            return `${this.name}${this.templateTypes}`;
        }
        return this.name;
    }

    setTypeWithTemplateTypes(ancestors: Expression[]): void {
        this.fullName = functionNameWithParamTypes(this.name, this.templateTypes?.types ?? []);
        const registered = findFunction(this.fullName);
        if (registered) {
            this.type = registered.getFuncType();
            return;
        }
        let prevAncestor: Expression | null = null;
        for (let i = 0; i < ancestors.length; i++) {
            const ancestor = ancestors[ancestors.length - i - 1];
            if (!(ancestor instanceof Block)) {
                prevAncestor = ancestor;
                continue;
            }
            const searchFor = prevAncestor ?? this;
            const olderSiblings = ancestor.expressions.slice(
                0,
                ancestor.expressions.indexOf(searchFor)
            );
            for (let j = 0; j < olderSiblings.length; j++) {
                let olderSibling = olderSiblings[olderSiblings.length - j - 1];
                if (olderSibling instanceof DropValue) {
                    olderSibling = olderSibling.child;
                }
                if (olderSibling instanceof Function && olderSibling.fullName === this.fullName) {
                    this.type = olderSibling.getFuncType();
                    return;
                }
            }
            prevAncestor = ancestor;
        }
        throw this.error(`cannot resolve type of variable '${this}'`);
    }

    resolveAssignment(e: Expression): Type | null {
        if (e instanceof Assignment && e.name === this.name) {
            return e.value.type;
        }
        return null;
    }

    cascadeTypes(ancestors: Expression[]): void {
        if (!this.templateTypes.empty()) {
            this.setTypeWithTemplateTypes(ancestors);
            return;
        }
        let prevAncestor: Expression | null = null;
        for (let i = 0; i < ancestors.length; i++) {
            const ancestor = ancestors[ancestors.length - i - 1];
            if (ancestor instanceof Block) {
                const searchFor = prevAncestor ?? this;
                const olderSiblings = ancestor.expressions.slice(
                    0,
                    ancestor.expressions.indexOf(searchFor)
                );
                for (let j = 0; j < olderSiblings.length; j++) {
                    let olderSibling = olderSiblings[olderSiblings.length - j - 1];
                    const type = this.resolveAssignment(olderSibling);
                    if (type !== null) {
                        this.type = type;
                        this.fullName = this.name;
                        if (isVarConsumed(this.fullName)) {
                            throw this.error(
                                `cannot use variable '${this.fullName}' after it was detrans'd`
                            );
                        }
                        return;
                    }
                    // Check TupleUnpack bindings
                    if (olderSibling instanceof TupleUnpack) {
                        const binding = olderSibling.bindings.find((b) => b.name === this.name);
                        if (binding) {
                            const idx = olderSibling.bindings.indexOf(binding);
                            if (olderSibling.source.type instanceof TupleType) {
                                this.type = olderSibling.source.type.types[idx];
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
                    if (olderSibling instanceof DropValue) {
                        olderSibling = olderSibling.child;
                    }
                    if (
                        olderSibling instanceof Function &&
                        olderSibling.name === this.name &&
                        olderSibling.params.length === 0 &&
                        olderSibling.fullName !== null
                    ) {
                        this.type = olderSibling.getFuncType();
                        this.fullName = olderSibling.fullName;
                        return;
                    }
                }
            } else if (ancestor instanceof Function) {
                for (const param of ancestor.params) {
                    if (param.name === this.name) {
                        this.type = param.type;
                        this.fullName = this.name;
                        return;
                    }
                }
                if (
                    ancestor.name === this.name &&
                    ancestor.params.length === 0 &&
                    ancestor.fullName !== null
                ) {
                    this.type = ancestor.type;
                    this.fullName = ancestor.fullName;
                    return;
                }
            } else if (ancestor instanceof AnonymousFunction) {
                for (const param of ancestor.params) {
                    if (param.name === this.name) {
                        this.type = param.type;
                        this.fullName = this.name;
                        return;
                    }
                }
            } else if (ancestor instanceof ForLoop) {
                if (ancestor.varName === this.name) {
                    let innerType: Type = "Int";
                    if (ancestor.iter.type instanceof ArrayType) {
                        innerType = ancestor.iter.type.innerType;
                    } else if (ancestor.iter.type instanceof IterType) {
                        innerType = ancestor.iter.type.innerType;
                    } else if (ancestor.iter.type instanceof MutArrType) {
                        innerType = ancestor.iter.type.innerType;
                    } else if (ancestor.iter.type === "Str") {
                        innerType = "Str";
                    }
                    this.type = innerType;
                    this.fullName = this.name;
                    return;
                }
            }
            prevAncestor = ancestor;
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
        const cloned = new Variable(
            { line: this.line, col: this.col, text: this.name, type: TokenType.Identifier },
            newTemplateTypes
        );
        return cloned;
    }

    toJS(writer: JSWriter): void {
        if (this.fullName === undefined) {
            throw this.error(`type of variable ${this} not resolved`);
        }
        writer.write(writer.safeName(this.fullName));
    }
}

export class Assignment extends Expression {
    name: string;
    isMutable: boolean = false;
    isReassignment: boolean = false;

    constructor(
        variableToken: Token,
        public value: Expression,
        public isDropped: boolean,
        isMutable: boolean = false
    ) {
        super(variableToken.line, variableToken.col);
        this.name = variableToken.text;
        this.isMutable = isMutable;
    }

    static findDefiningAssignment(
        name: string,
        startNode: Expression,
        ancestors: Expression[]
    ): { isMutable: boolean; type: Type } | null {
        for (let i = 0; i < ancestors.length; i++) {
            const ancestor = ancestors[ancestors.length - i - 1];
            if (ancestor instanceof Block) {
                const olderSiblings = ancestor.expressions.slice(
                    0,
                    ancestor.expressions.indexOf(startNode)
                );
                for (let j = olderSiblings.length - 1; j >= 0; j--) {
                    let olderSibling = olderSiblings[j];
                    if (olderSibling instanceof DropValue) {
                        olderSibling = olderSibling.child;
                    }
                    if (olderSibling instanceof Assignment && olderSibling.name === name) {
                        if (olderSibling.isReassignment) {
                            continue;
                        }
                        return {
                            isMutable: olderSibling.isMutable,
                            type: olderSibling.value.type!,
                        };
                    }
                }
                return null;
            }
        }
        return null;
    }

    static findOuterDefinition(
        name: string,
        startNode: Expression,
        ancestors: Expression[]
    ): { isMutable: boolean; type: Type } | null {
        let foundInnerBlock = false;
        let lastAncestor: Expression = startNode;
        for (let i = 0; i < ancestors.length; i++) {
            const ancestor = ancestors[ancestors.length - i - 1];
            if (!foundInnerBlock) {
                if (ancestor instanceof Block) {
                    foundInnerBlock = true;
                }
                lastAncestor = ancestor;
                continue;
            }
            if (ancestor instanceof Block) {
                const olderSiblings = ancestor.expressions.slice(
                    0,
                    ancestor.expressions.indexOf(lastAncestor)
                );
                for (let j = olderSiblings.length - 1; j >= 0; j--) {
                    let olderSibling = olderSiblings[j];
                    if (olderSibling instanceof DropValue) {
                        olderSibling = olderSibling.child;
                    }
                    if (olderSibling instanceof Assignment && olderSibling.name === name) {
                        if (olderSibling.isReassignment) {
                            continue;
                        }
                        return {
                            isMutable: olderSibling.isMutable,
                            type: olderSibling.value.type!,
                        };
                    }
                }
            } else if (ancestor instanceof Function) {
                for (const arg of ancestor.params) {
                    if (arg.name === name) {
                        return { isMutable: false, type: arg.type };
                    }
                }
            } else if (ancestor instanceof AnonymousFunction) {
                for (const arg of ancestor.params) {
                    if (arg.name === name) {
                        return { isMutable: false, type: arg.type };
                    }
                }
            }
            lastAncestor = ancestor;
        }
        return null;
    }

    cascadeTypes(ancestors: Expression[]): void {
        this.value.cascadeTypes([...ancestors, this]);
        this.type = this.isDropped ? "Null" : this.value.type;

        const sameBlockDef = Assignment.findDefiningAssignment(this.name, this, ancestors);

        if (sameBlockDef !== null) {
            this.isReassignment = true;

            if (this.isMutable) {
                throw this.error(
                    `cannot redeclare variable '${this.name}' with 'mut' — it was already defined in this scope`
                );
            }

            if (!sameBlockDef.isMutable) {
                throw this.error(`cannot reassign non-mutable variable '${this.name}'`);
            }

            const assignType = this.value.type!;
            if (!deepEquals(sameBlockDef.type, assignType)) {
                throw this.error(
                    `tried to reassign variable '${this.name}' with type ${assignType} but it was previously defined with type ${sameBlockDef.type}`
                );
            }
        } else if (this.isMutable) {
            const outerDef = Assignment.findOuterDefinition(this.name, this, ancestors);
            if (outerDef !== null && !outerDef.isMutable) {
                throw this.error(
                    `cannot declare mutable variable '${this.name}' — it shadows a non-mutable variable in an outer scope`
                );
            }
            this.isReassignment = false;
        } else {
            const outerDef = Assignment.findOuterDefinition(this.name, this, ancestors);
            if (outerDef !== null) {
                this.isReassignment = true;

                if (!outerDef.isMutable) {
                    throw this.error(`cannot reassign non-mutable variable '${this.name}'`);
                }

                const assignType = this.value.type!;
                if (!deepEquals(outerDef.type, assignType)) {
                    throw this.error(
                        `tried to reassign variable '${this.name}' with type ${assignType} but it was previously defined with type ${outerDef.type}`
                    );
                }
            } else {
                this.isReassignment = false;
            }
        }
    }

    clone(bindings?: Map<string, Type>): Expression {
        const cloned = new Assignment(
            { line: this.line, col: this.col, text: this.name, type: TokenType.Identifier },
            this.value.clone(bindings),
            this.isDropped,
            this.isMutable
        );
        return cloned;
    }

    toJS(writer: JSWriter): void {
        const safeName = writer.safeName(this.name);
        if (this.isReassignment) {
            if (this.isDropped) {
                writer.write(`${safeName} = `);
                this.value.toJS(writer);
            } else {
                writer.write(`(() => { ${safeName} = `);
                this.value.toJS(writer);
                writer.write(`; return ${safeName}; })()`);
            }
        } else {
            writer.declareVariable(this.name);
            if (this.isDropped) {
                writer.write(`${safeName} = `);
                this.value.toJS(writer);
            } else {
                writer.write(`(() => { ${safeName} = `);
                this.value.toJS(writer);
                writer.write(`; return ${safeName}; })()`);
            }
        }
    }
}

export class AnonymousFunction extends Expression {
    params: { name: string; type: Type }[];
    body: Block;
    returnType: Type | null;
    /** Whether this function has unresolved (null) param types that need inference. */
    needsInference: boolean = false;

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
    fillParams(types: Type[], ancestors: Expression[]): void {
        if (!this.needsInference) return;
        for (let i = 0; i < this.params.length; i++) {
            this.params[i].type = types[i] ?? this.params[i].type;
        }
        this.needsInference = false;
        this.body.cascadeTypes([...ancestors, this]);
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

    cascadeTypes(ancestors: Expression[]): void {
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
        this.body.cascadeTypes([...ancestors, this]);
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

    toJS(writer: JSWriter): void {
        writer.write(`(`);
        writer.write(this.params.map((p) => writer.safeName(p.name)).join(", "));
        writer.write(") => ");
        writer.beginFunction();
        this.body.expressions.slice(0, -1).forEach((expr) => {
            expr.toJS(writer);
            writer.newLine();
        });
        const lastExpr = this.body.expressions[this.body.expressions.length - 1];
        if (
            lastExpr instanceof DropValue ||
            (lastExpr instanceof Assignment && lastExpr.isDropped)
        ) {
            lastExpr.toJS(writer);
            writer.write(";");
            writer.newLine();
            writer.write("return null;");
        } else {
            writer.write("return ");
            lastExpr.toJS(writer);
            writer.write(";");
        }
        writer.endFunction();
    }
}

export class Function extends Expression {
    name: string | null;
    params: { name: string; type: Type }[];
    returnType: Type;
    body: Block;
    fullName: string;
    typeParams: string[] = [];
    monomorphizedVersions: Function[] = [];

    constructor(
        rootToken: Token,
        name: string,
        params: { name: string; type: Type }[],
        returnType: Type,
        typeTraits: { type: Type; trait: Type }[],
        body: Expression,
        skipTypeValidation: boolean = false
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
        this.fullName = functionNameWithParamTypes(
            name as string,
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
            this.params.forEach((param) => {
                if (param.type instanceof CustomType && param.type.name === type.name) {
                    param.type.addTrait(trait.name);
                }
            });
            if (this.returnType instanceof CustomType && this.returnType.name === type.name) {
                this.returnType.addTrait(trait.name);
            }
        });
        this.typeParams = [...typeParamNames];

        // When creating a monomorphized function programmatically, the types might
        // reference outer function type params — skip validation in that case.
        if (!skipTypeValidation) {
            // Validate: every non-builtin, non-struct CustomType in the signature must be a type param
            const signatureTypes = new Set<string>();
            this.params.forEach((p) => collectCustomTypeNames(p.type, signatureTypes));
            collectCustomTypeNames(returnType, signatureTypes);
            for (const name of signatureTypes) {
                if (
                    !isBuiltinTypeName(name) &&
                    !getStruct(name) &&
                    !getTrait(name) &&
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

    cascadeTypes(ancestors: Expression[]): void {
        if (this.isGeneric) {
            this.body.cascadeTypes([...ancestors, this]);
            return;
        }
        this.body.cascadeTypes([...ancestors, this]);

        if (this.returnType === "Null" && this.body.type !== null && this.body.type !== "Null") {
            this.returnType = this.body.type;
        }

        if (!deepEquals(this.body.type, this.returnType)) {
            throw this.error(
                `function body should return ${this.returnType}, but found ${this.body.type}`
            );
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
        ancestors?: Expression[]
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

        const monomorphized = new Function(
            { line: this.line, col: this.col, text: this.name!, type: TokenType.Func },
            this.name!,
            clonedParams,
            concreteReturnType as Type,
            [],
            clonedBody,
            true
        );

        const allConcrete = clonedParams.every(
            (p) =>
                !(p.type instanceof CustomType) ||
                isBuiltinTypeName(p.type.name) ||
                getStruct(p.type.name) !== undefined
        );

        monomorphized.body.cascadeTypes([...(ancestors || []), monomorphized]);

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

    clone(bindings?: Map<string, Type>): Expression {
        const clonedParams = this.params.map((p) => ({
            name: p.name,
            type: bindings ? substituteTypeParams(p.type, bindings) : p.type,
        }));
        const clonedReturnType = bindings
            ? substituteTypeParams(this.returnType, bindings)
            : this.returnType;
        const cloned = new Function(
            { line: this.line, col: this.col, text: this.name!, type: TokenType.Func },
            this.name!,
            clonedParams,
            clonedReturnType as Type,
            [],
            this.body.clone(bindings)
        );
        cloned.fullName = this.fullName;
        cloned.typeParams = [...this.typeParams];
        return cloned;
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
        this.body.expressions.slice(0, -1).forEach((expr) => {
            expr.toJS(writer);
            writer.newLine();
        });
        const lastExpr = this.body.expressions[this.body.expressions.length - 1];
        if (
            lastExpr instanceof DropValue ||
            (lastExpr instanceof Assignment && lastExpr.isDropped)
        ) {
            lastExpr.toJS(writer);
            writer.write(";");
            writer.newLine();
            writer.write("return null;");
        } else {
            writer.write("return ");
            lastExpr.toJS(writer);
            writer.write(";");
        }
        writer.endFunction();
    }
}
