import type { JSWriter } from "./write-js";
import { TokenType, type Token } from "./tokens";
import { deepEquals } from "bun";
import {
    isBuiltinTypeName,
    collectCustomTypeNames,
    substituteTypeParams,
    FuncType,
    ArrayType,
    IterType,
    CustomType,
    type Type,
    type CallableType,
    TemplateTypes,
} from "./types";

// Global registry of trait definitions, keyed by trait name
const traitRegistry: Map<string, { name: string; paramNames: string[]; types: TemplateTypes }[]> =
    new Map();

export function registerTrait(
    name: string,
    requiredFunctions: { name: string; paramNames: string[]; types: TemplateTypes }[]
): void {
    traitRegistry.set(name, requiredFunctions);
}

export function getTrait(
    name: string
): { name: string; paramNames: string[]; types: TemplateTypes }[] | undefined {
    return traitRegistry.get(name);
}

// Global registry of struct definitions, keyed by struct name
const structRegistry: Map<string, { name: string; fields: { name: string; type: Type }[] }> =
    new Map();

export function registerStruct(name: string, fields: { name: string; type: Type }[]): void {
    structRegistry.set(name, { name, fields });
}

export function getStruct(
    name: string
): { name: string; fields: { name: string; type: Type }[] } | undefined {
    return structRegistry.get(name);
}

// Global cache of monomorphized functions, keyed by fullName
const monomorphizedCache: Map<string, Function> = new Map();

// Global registry of all named functions (non-generic), keyed by fullName
const functionRegistry: Map<string, Function> = new Map();

export function registerFunction(fn: Function): void {
    if (!fn.isGeneric) {
        functionRegistry.set(fn.fullName, fn);
    }
}

export function findFunction(fullName: string): Function | undefined {
    return functionRegistry.get(fullName) ?? monomorphizedCache.get(fullName);
}

export function getMonomorphized(fullName: string): Function | undefined {
    return monomorphizedCache.get(fullName);
}

export function registerMonomorphized(fullName: string, fn: Function): void {
    monomorphizedCache.set(fullName, fn);
}

export function getAllMonomorphized(): Map<string, Function> {
    return monomorphizedCache;
}

// Reset all global registries (useful between tests)
export function resetRegistries(): void {
    traitRegistry.clear();
    structRegistry.clear();
    functionRegistry.clear();
    monomorphizedCache.clear();
}

export class ASTError {
    constructor(
        public line: number,
        public col: number,
        public message: string
    ) {}
}

export abstract class Expression {
    type: Type | null = null;

    constructor(
        public line: number,
        public col: number
    ) {}

    error(message: string): ASTError {
        return new ASTError(this.line, this.col, message);
    }

    abstract cascadeTypes(ancestors: Expression[]): void;

    toJS(writer: JSWriter): void {
        throw new Error(`\`toJS\` not implemented for ${this.constructor.name}.`);
    }

    // Deep-clone this expression tree, optionally substituting type parameters
    abstract clone(bindings?: Map<string, Type>): Expression;
}

export class ErrorExpression extends Expression {
    constructor(
        token: Token,
        public message: string
    ) {
        super(token.line, token.col);
    }

    cascadeTypes(ancestors: Expression[]): void {
        // noop
    }

    clone(bindings?: Map<string, Type>): Expression {
        return this; // Error expressions don't need deep cloning
    }
}

export class DropValue extends Expression {
    constructor(public child: Expression) {
        super(child.line, child.col);
        this.type = "Null";
    }

    cascadeTypes(ancestors: Expression[]): void {
        // Type is already resolved as null, so just pass to children
        this.child.cascadeTypes([...ancestors, this]);
    }

    toJS(writer: JSWriter): void {
        this.child.toJS(writer);
    }

    clone(bindings?: Map<string, Type>): Expression {
        return new DropValue(this.child.clone(bindings));
    }
}

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
        // Resolve type based on last child
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

export class Literal extends Expression {
    value: string;

    constructor(token: Token, type: Type) {
        super(token.line, token.col);
        this.value = token.text;
        this.type = type;
    }

    cascadeTypes(ancestors: Expression[]): void {
        // Type is already resolved; no need to do anything
    }

    clone(bindings?: Map<string, Type>): Expression {
        return this; // Literals are immutable, safe to share
    }

    toJS(compiler: JSWriter): void {
        switch (this.type) {
            case "Int":
                compiler.write(`BigInt(${this.value})`);
                break;
            case "Float":
                compiler.write(this.value);
                break;
            case "Str":
                compiler.write(this.value);
                break;
            case "Bool":
                compiler.write(this.value);
                break;
            default:
                throw this.error(`cannot use token ${this.value} as literal type`);
        }
    }
}

export class Unary extends Expression {
    operator: TokenType;

    constructor(
        operatorToken: Token,
        public child: Expression
    ) {
        super(operatorToken.line, operatorToken.col);
        this.operator = operatorToken.type;
    }

    cascadeTypes(ancestors: Expression[]): void {
        this.child.cascadeTypes([...ancestors, this]);

        switch (this.child.type) {
            case "Int":
                if (this.operator === TokenType.Minus) {
                    this.type = "Int";
                    return;
                }
                break;
            case "Float":
                if (this.operator === TokenType.Minus) {
                    this.type = "Float";
                    return;
                }
                break;
            case "Bool":
                if (this.operator === TokenType.Bang) {
                    this.type = "Bool";
                    return;
                }
                break;
        }
        if (this.child.type instanceof IterType) {
            if (this.operator === TokenType.At) {
                this.type = new ArrayType(this.child.type.innerType);
                return;
            }
        }
        throw this.error(
            `cannot use token ${this.operator} on expression of type ${this.child.type}.`
        );
    }

    clone(bindings?: Map<string, Type>): Expression {
        const cloned = new Unary(
            {
                line: this.line,
                col: this.col,
                text: this.operator,
                type: this.operator as TokenType,
            },
            this.child.clone(bindings)
        );
        return cloned;
    }

    toJS(writer: JSWriter): void {
        if (this.child.type instanceof IterType && this.operator === TokenType.At) {
            writer.useBuiltin("__COLLECT__");
            writer.write("__COLLECT__(");
            this.child.toJS(writer);
            writer.write(")");
            return;
        }
        writer.write(`(${this.operator}(`);
        this.child.toJS(writer);
        writer.write("))");
    }
}

// Operator overloading — maps TokenType to function names for user-defined types
const OPERATOR_TO_FUNCTION: Partial<Record<string, string>> = {
    [TokenType.Plus]: "add",
    [TokenType.Minus]: "subtract",
    [TokenType.Star]: "multiply",
    [TokenType.Slash]: "divide",
    [TokenType.Percent]: "modulo",
    [TokenType.EqualEqual]: "equal",
    [TokenType.BangEqual]: "notEqual",
    [TokenType.Less]: "less",
    [TokenType.LessEqual]: "lessEqual",
    [TokenType.Greater]: "greater",
    [TokenType.GreaterEqual]: "greaterEqual",
};

const OPERATOR_TRANSLATIONS: Record<string, string> = {
    [TokenType.Plus]: "+",
    [TokenType.Minus]: "-",
    [TokenType.Star]: "*",
    [TokenType.Slash]: "/",
    [TokenType.Greater]: ">",
    [TokenType.GreaterEqual]: ">=",
    [TokenType.Less]: "<",
    [TokenType.LessEqual]: "<=",
    [TokenType.EqualEqual]: "==", // Non-strict equality is fine here since we are stricter about what types can be compared
    [TokenType.BangEqual]: "!=",
    [TokenType.And]: "&&",
    [TokenType.Or]: "||",
};

export class Binary extends Expression {
    operator: TokenType;
    overloadedAs?: { name: string };

    constructor(
        operatorToken: Token,
        public left: Expression,
        public right: Expression
    ) {
        super(operatorToken.line, operatorToken.col);
        this.operator = operatorToken.type;
    }

    cascadeTypes(ancestors: Expression[]): void {
        this.left.cascadeTypes([...ancestors, this]);
        this.right.cascadeTypes([...ancestors, this]);

        const [ltype, rtype] = [this.left.type, this.right.type];

        if (ltype === null) {
            throw this.error("Left-hand side of expression has null type");
        }
        if (rtype === null) {
            throw this.error("Right-hand side of expression has null type");
        }

        const NUMERIC_OPS = [
            TokenType.Plus,
            TokenType.Minus,
            TokenType.Star,
            TokenType.Slash,
            TokenType.Percent,
            TokenType.Caret,
        ];
        const COMPARISON_OPS = [
            TokenType.Greater,
            TokenType.GreaterEqual,
            TokenType.Less,
            TokenType.LessEqual,
            TokenType.EqualEqual,
            TokenType.BangEqual,
        ];
        const BOOLEAN_OPS = [
            TokenType.And,
            TokenType.Or,
            TokenType.EqualEqual,
            TokenType.BangEqual,
        ];

        switch (ltype) {
            case "Int":
                if (rtype === "Int" || rtype === "Float") {
                    if (NUMERIC_OPS.includes(this.operator)) {
                        this.type = rtype;
                        return;
                    }
                    if (COMPARISON_OPS.includes(this.operator)) {
                        this.type = "Bool";
                        return;
                    }
                }
                break;

            case "Float":
                if (rtype === "Int" || rtype === "Float") {
                    if (NUMERIC_OPS.includes(this.operator)) {
                        this.type = "Float";
                        return;
                    }
                    if (COMPARISON_OPS.includes(this.operator)) {
                        this.type = "Bool";
                        return;
                    }
                }
                break;

            case "Str":
                if (rtype === "Str" && this.operator === TokenType.Plus) {
                    this.type = "Str";
                    return;
                } else if (rtype === "Str" && COMPARISON_OPS.includes(this.operator)) {
                    this.type = "Bool";
                    return;
                }
                break;

            case "Bool":
                if (rtype === "Bool" && BOOLEAN_OPS.includes(this.operator)) {
                    this.type = "Bool";
                    return;
                }
                break;
        }
        if (ltype instanceof ArrayType && rtype instanceof ArrayType) {
            if (ltype.innerType === rtype.innerType && this.operator === TokenType.Plus) {
                this.type = ltype;
                return;
            }
            if (ltype.innerType === rtype.innerType && this.operator === TokenType.EqualEqual) {
                this.type = "Bool";
                return;
            }
        }

        // Try operator overloading for user-defined types (at least one operand is a CustomType)
        if (
            (ltype instanceof CustomType || rtype instanceof CustomType) &&
            !(ltype instanceof ArrayType) &&
            !(rtype instanceof ArrayType) &&
            !(ltype instanceof IterType) &&
            !(rtype instanceof IterType)
        ) {
            const opName = OPERATOR_TO_FUNCTION[this.operator];
            if (opName) {
                const { error, result } = findCaller(this, ancestors, opName, [ltype, rtype]);
                if (error === null) {
                    this.type = result.rootType;
                    this.overloadedAs = { name: result.referToByName };
                    return;
                }
            }
        }
        throw this.error(
            `cannot use operator ${this.operator} with left operand of type ${ltype} and right operand of type ${rtype}.`
        );
    }

    clone(bindings?: Map<string, Type>): Expression {
        const cloned = new Binary(
            {
                line: this.line,
                col: this.col,
                text: this.operator,
                type: this.operator as TokenType,
            },
            this.left.clone(bindings),
            this.right.clone(bindings)
        );
        return cloned;
    }

    toJS(writer: JSWriter): void {
        // Operator overloading: emit function call instead of inline operator
        if (this.overloadedAs) {
            writer.write(writer.safeName(this.overloadedAs.name));
            writer.write("(");
            this.left.toJS(writer);
            writer.write(", ");
            this.right.toJS(writer);
            writer.write(")");
            return;
        }
        if (this.left.type instanceof ArrayType) {
            if (this.operator === TokenType.Plus) {
                this.left.toJS(writer);
                writer.write(".concat(");
                this.right.toJS(writer);
                writer.write(")");
                return;
            } else if (this.operator === TokenType.EqualEqual) {
                writer.useBuiltin("__ARRAY_EQUAL__");
                writer.write("__ARRAY_EQUAL__(");
                this.left.toJS(writer);
                writer.write(", ");
                this.right.toJS(writer);
                writer.write(")");
                return;
            }
        }
        if (Object.keys(OPERATOR_TRANSLATIONS).includes(this.operator)) {
            writer.write("(");
            this.left.toJS(writer);
            writer.write(` ${OPERATOR_TRANSLATIONS[this.operator]} `);
            this.right.toJS(writer);
            writer.write(")");
            return;
        } else if (this.operator === TokenType.Percent) {
            // Don't use JS's default modulo operator behavior
            // Treat % as euclidean remainder (i.e., it will always give a positive result)
            writer.useBuiltin("__MOD__");
            writer.write("__MOD__(");
            this.left.toJS(writer);
            writer.write(", ");
            this.right.toJS(writer);
            writer.write(")");
            return;
        } else if (this.operator === TokenType.Caret) {
            this.left.toJS(writer);
            writer.write(" ** ");
            this.right.toJS(writer);
            return;
        }
        throw this.error(`tried to use token ${this.operator} as binary operator`);
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
        // Check the global function registry first
        const registered = findFunction(this.fullName);
        if (registered) {
            this.type = registered.getFuncType();
            return;
        }
        let lastAncestor: Expression = this;
        for (let i = 0; i < ancestors.length; i++) {
            const ancestor = ancestors[ancestors.length - i - 1];
            if (!(ancestor instanceof Block)) {
                continue;
            }
            const olderSiblings = ancestor.expressions.slice(
                0,
                ancestor.expressions.indexOf(lastAncestor)
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
            lastAncestor = ancestor;
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
        let lastAncestor: Expression = this;
        for (let i = 0; i < ancestors.length; i++) {
            const ancestor = ancestors[ancestors.length - i - 1];
            if (ancestor instanceof Block) {
                const olderSiblings = ancestor.expressions.slice(
                    0,
                    ancestor.expressions.indexOf(lastAncestor)
                );
                for (let j = 0; j < olderSiblings.length; j++) {
                    let olderSibling = olderSiblings[olderSiblings.length - j - 1];
                    const type = this.resolveAssignment(olderSibling);
                    if (type !== null) {
                        this.type = type;
                        this.fullName = this.name;
                        return;
                    }
                    // This could also refer to a function if the function has no params
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
                // This could also refer to the function itself if the function has no params
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
            }
            lastAncestor = ancestor;
        }
        throw this.error(`unable to resolve type of variable ${this}`);
    }

    clone(bindings?: Map<string, Type>): Expression {
        // If we have template types, substitute them
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

    /**
     * Find a previous assignment for the variable in the SAME block (same scope level).
     * Returns the original declaration (skipping past intermediate reassignments).
     */
    static findDefiningAssignment(
        name: string,
        startNode: Expression,
        ancestors: Expression[]
    ): { isMutable: boolean; type: Type } | null {
        // Find the nearest Block ancestor that contains startNode
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
                        // Skip past intermediate reassignments to find the original declaration
                        if (olderSibling.isReassignment) {
                            continue;
                        }
                        return {
                            isMutable: olderSibling.isMutable,
                            type: olderSibling.value.type!,
                        };
                    }
                }
                // Only check the immediate (innermost) Block containing startNode
                return null;
            }
        }
        return null;
    }

    /**
     * Search across outer blocks and function boundaries for a variable definition.
     * Used to find variables in enclosing scopes (for reassignment from nested blocks
     * or closure capture).
     * Returns { isMutable, type } of the original declaration, or null.
     */
    static findOuterDefinition(
        name: string,
        startNode: Expression,
        ancestors: Expression[]
    ): { isMutable: boolean; type: Type } | null {
        // First skip past the innermost Block to reach outer scopes
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

        // Step 1: Check for a previous definition in the SAME block
        const sameBlockDef = Assignment.findDefiningAssignment(this.name, this, ancestors);

        if (sameBlockDef !== null) {
            // Same-block reassignment
            this.isReassignment = true;

            // Using 'mut' on a reassignment is not allowed (double declaration)
            if (this.isMutable) {
                throw this.error(
                    `cannot redeclare variable '${this.name}' with 'mut' — it was already defined in this scope`
                );
            }

            // Reassignment requires the variable to be mutable
            if (!sameBlockDef.isMutable) {
                throw this.error(
                    `cannot reassign non-mutable variable '${this.name}'`
                );
            }

            // Reassignment must match the original type
            const assignType = this.value.type!;
            if (!deepEquals(sameBlockDef.type, assignType)) {
                throw this.error(
                    `tried to reassign variable '${this.name}' with type ${assignType} but it was previously defined with type ${sameBlockDef.type}`
                );
            }
        } else if (this.isMutable) {
            // New 'mut' declaration — check for shadowing conflicts with outer non-mut vars
            const outerDef = Assignment.findOuterDefinition(this.name, this, ancestors);
            if (outerDef !== null && !outerDef.isMutable) {
                throw this.error(
                    `cannot declare mutable variable '${this.name}' — it shadows a non-mutable variable in an outer scope`
                );
            }
            this.isReassignment = false;
        } else {
            // Non-mut assignment — check if this is a reassignment of an outer variable
            const outerDef = Assignment.findOuterDefinition(this.name, this, ancestors);
            if (outerDef !== null) {
                // Cross-block reassignment (e.g., from a nested block or closure)
                this.isReassignment = true;

                if (!outerDef.isMutable) {
                    throw this.error(
                        `cannot reassign non-mutable variable '${this.name}'`
                    );
                }

                const assignType = this.value.type!;
                if (!deepEquals(outerDef.type, assignType)) {
                    throw this.error(
                        `tried to reassign variable '${this.name}' with type ${assignType} but it was previously defined with type ${outerDef.type}`
                    );
                }
            } else {
                // New non-mut declaration
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
            // Reassignment: just emit "x = value" (no let)
            if (this.isDropped) {
                writer.write(`${safeName} = `);
                this.value.toJS(writer);
            } else {
                writer.write(`(() => { ${safeName} = `);
                this.value.toJS(writer);
                writer.write(`; return ${safeName}; })()`);
            }
        } else {
            // First declaration: emit "let x; x = value"
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

export class If extends Expression {
    conditionalBranches: { condition: Expression; branch: Block }[];
    elseBranch: Block;

    constructor(
        rootToken: Token,
        conditionalBranches: { condition: Expression; branch: Expression }[],
        elseBranch: Expression
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
    }

    cascadeTypes(ancestors: Expression[]): void {
        this.elseBranch.cascadeTypes([...ancestors, this]);

        this.conditionalBranches.forEach(({ condition, branch }) => {
            condition.cascadeTypes([...ancestors, this]);
            if (condition.type !== "Bool") {
                throw this.error(`condition must be boolean, but found ${condition.type}`);
            }
            branch.cascadeTypes([...ancestors, this]);
            if (!deepEquals(this.elseBranch.type, branch.type)) {
                throw this.error(
                    `all branches of if expression must have the same type, but found branches of types ${branch.type} and ${this.elseBranch.type}`
                );
            }
        });

        this.type = this.elseBranch.type;
    }

    clone(bindings?: Map<string, Type>): Expression {
        const cloned = new If(
            { line: this.line, col: this.col, text: "if", type: TokenType.If },
            this.conditionalBranches.map(({ condition, branch }) => ({
                condition: condition.clone(bindings),
                branch: branch.clone(bindings),
            })),
            this.elseBranch.clone(bindings)
        );
        return cloned;
    }

    toJS(writer: JSWriter): void {
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
    }
}

function functionNameWithParamTypes(name: string | null, paramTypes: Type[]): string {
    return `${name}$${paramTypes.map(typeToName).join("$")}`;
}

/** Produce a stable, readable name fragment for a type. */
function typeToName(t: Type): string {
    if (typeof t === "string") return t;
    if (t instanceof CustomType) return t.name;
    if (t instanceof ArrayType) return `Arr_${typeToName(t.innerType)}`;
    if (t instanceof IterType) return `Iter_${typeToName(t.innerType)}`;
    if (t instanceof FuncType)
        return `Func_${t.paramTypes.map(typeToName).join("_")}_${typeToName(t.returnType)}`;
    return "Null";
}

/**
 * Recursively extract type param bindings from param types against arg types.
 * Handles nested types like Arr[T], Iter[T], Func[Int: T], and auto-converts
 * Arr → Iter when matching.
 */
function extractBindingsFromParams(
    params: { name: string; type: Type }[],
    argTypes: Type[],
    typeParams: string[],
    bindings: Map<string, Type>
): boolean {
    if (params.length !== argTypes.length) return false;
    for (let i = 0; i < params.length; i++) {
        if (!extractBindings(params[i].type, argTypes[i], typeParams, bindings)) {
            return false;
        }
    }
    return true;
}

function extractBindings(
    paramType: Type,
    argType: Type,
    typeParams: string[],
    bindings: Map<string, Type>
): boolean {
    if (paramType instanceof CustomType && typeParams.includes(paramType.name)) {
        const existing = bindings.get(paramType.name);
        if (existing && !deepEquals(existing, argType)) return false;
        bindings.set(paramType.name, argType);
        return true;
    }
    if (paramType instanceof ArrayType && argType instanceof ArrayType) {
        return extractBindings(paramType.innerType, argType.innerType, typeParams, bindings);
    }
    if (paramType instanceof IterType && argType instanceof IterType) {
        return extractBindings(paramType.innerType, argType.innerType, typeParams, bindings);
    }
    // Auto-convert: Arr[X] matches Iter[X]
    if (paramType instanceof IterType && argType instanceof ArrayType) {
        return extractBindings(paramType.innerType, argType.innerType, typeParams, bindings);
    }
    if (paramType instanceof FuncType && argType instanceof FuncType) {
        if (paramType.paramTypes.length !== argType.paramTypes.length) return false;
        for (let i = 0; i < paramType.paramTypes.length; i++) {
            if (
                !extractBindings(
                    paramType.paramTypes[i],
                    argType.paramTypes[i],
                    typeParams,
                    bindings
                )
            )
                return false;
        }
        return extractBindings(paramType.returnType, argType.returnType, typeParams, bindings);
    }
    // For non-type-param types, just check equality (with Arr↔Iter conversion)
    if (!typesMatchWithConversion(paramType, argType)) return false;
    return true;
}

/** Check if two types match, allowing Arr[X] ↔ Iter[X] auto-conversion
 *  and ignoring trait differences on CustomTypes. */
function typesMatchWithConversion(a: Type, b: Type): boolean {
    if (deepEquals(a, b)) return true;
    // Try comparison with traits stripped (traits are metadata, not semantic type identity)
    if (deepEquals(stripTraits(a), stripTraits(b))) return true;
    // Arr[X] can be treated as Iter[X]
    if (a instanceof IterType && b instanceof ArrayType) {
        return typesMatchWithConversion(a.innerType, b.innerType);
    }
    if (a instanceof ArrayType && b instanceof IterType) {
        return typesMatchWithConversion(a.innerType, b.innerType);
    }
    return false;
}

/** Return a copy of a type with all trait information removed. */
function stripTraits(t: Type): Type {
    if (t instanceof CustomType) {
        return new CustomType(t.name);
    }
    if (t instanceof ArrayType) {
        return new ArrayType(stripTraits(t.innerType));
    }
    if (t instanceof IterType) {
        return new IterType(stripTraits(t.innerType));
    }
    if (t instanceof FuncType) {
        return new FuncType(
            t.paramTypes.map((pt) => stripTraits(pt)),
            stripTraits(t.returnType)
        );
    }
    return t;
}

/** Compare two types for equality, ignoring trait differences on CustomTypes. */
function typeEquals(a: Type, b: Type): boolean {
    return deepEquals(stripTraits(a), stripTraits(b));
}

/** Check if a type is fully concrete (not a type variable from an enclosing generic). */
function isConcreteType(t: Type): boolean {
    if (typeof t === "string") return true;
    if (t instanceof CustomType) {
        return isBuiltinTypeName(t.name) || getStruct(t.name) !== undefined;
    }
    if (t instanceof ArrayType) return isConcreteType(t.innerType);
    if (t instanceof IterType) return isConcreteType(t.innerType);
    if (t instanceof FuncType)
        return t.paramTypes.every(isConcreteType) && isConcreteType(t.returnType);
    return true;
}

/** Collect trait names associated with a type param name inside a type tree. */
function collectTraitsForTypeParam(t: Type, typeParamName: string): string[] {
    if (t instanceof CustomType && t.name === typeParamName) {
        return [...t.traits];
    }
    if (t instanceof ArrayType) {
        return collectTraitsForTypeParam(t.innerType, typeParamName);
    }
    if (t instanceof IterType) {
        return collectTraitsForTypeParam(t.innerType, typeParamName);
    }
    if (t instanceof FuncType) {
        const result: string[] = [];
        t.paramTypes.forEach((pt) => result.push(...collectTraitsForTypeParam(pt, typeParamName)));
        result.push(...collectTraitsForTypeParam(t.returnType, typeParamName));
        return result;
    }
    return [];
}

/** Recursively add a trait to all CustomTypes with the given name inside a type tree. */
function addTraitToType(t: Type, typeParamName: string, traitName: string): void {
    if (t instanceof CustomType && t.name === typeParamName) {
        t.addTrait(traitName);
    } else if (t instanceof ArrayType) {
        addTraitToType(t.innerType, typeParamName, traitName);
    } else if (t instanceof IterType) {
        addTraitToType(t.innerType, typeParamName, traitName);
    } else if (t instanceof FuncType) {
        t.paramTypes.forEach((pt) => addTraitToType(pt, typeParamName, traitName));
        addTraitToType(t.returnType, typeParamName, traitName);
    }
}

export class AnonymousFunction extends Expression {
    params: { name: string; type: Type }[];
    body: Block;
    returnType: Type | null;

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
    }

    cascadeTypes(ancestors: Expression[]): void {
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
                type: bindings ? substituteTypeParams(p.type, bindings) : p.type,
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
            // For generic functions, we still cascade through the body Block for type resolution,
            // but we don't validate return type match since type params aren't concrete yet.
            this.body.cascadeTypes([...ancestors, this]);
            return;
        }
        this.body.cascadeTypes([...ancestors, this]);

        // Infer return type if it was defaulted to "Null" (no explicit annotation)
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

    /**
     * Monomorphize this generic function with concrete type parameters.
     * Creates a cloned function with substituted types, cascadeTypes it, and registers it.
     */
    monomorphize(
        argTypes: Type[],
        ancestors?: Expression[]
    ): { fullName: string; funcType: FuncType; returnType: Type } | null {
        if (!this.isGeneric) return null;
        if (this.params.length !== argTypes.length) return null;

        // Build type bindings from arg types.
        // Recursively handles nested types like Arr[T], Iter[T], Func[Int: T], etc.
        const bindings = new Map<string, Type>();
        if (!extractBindingsFromParams(this.params, argTypes, this.typeParams, bindings)) {
            return null;
        }

        // All type params must be bound
        for (const tp of this.typeParams) {
            if (!bindings.has(tp)) return null;
        }

        // Compute the mangled name for the monomorphized version
        const concreteParamTypes = this.params.map((p) => substituteTypeParams(p.type, bindings));
        const concreteReturnType = substituteTypeParams(this.returnType, bindings);
        const monomorphizedFullName = functionNameWithParamTypes(this.name!, concreteParamTypes);

        // Check cache first
        const cached = getMonomorphized(monomorphizedFullName);
        if (cached) {
            return {
                fullName: monomorphizedFullName,
                funcType: cached.getFuncType(),
                returnType: concreteReturnType,
            };
        }

        // Check trait constraints — only when the concrete type is truly concrete
        // (skip when it's still a type variable from an outer generic function)
        for (const param of this.params) {
            if (param.type instanceof CustomType && param.type.traits.length > 0) {
                const concreteType = substituteTypeParams(param.type, bindings);
                // If the "concrete" type is still a CustomType, it's actually a type variable
                // from an outer generic function — skip the check for now.
                const isConcrete =
                    !(concreteType instanceof CustomType) ||
                    isBuiltinTypeName(concreteType.name) ||
                    getStruct(concreteType.name) !== undefined;
                if (isConcrete) {
                    for (const traitName of param.type.traits) {
                        if (!checkTraitSatisfied(concreteType, traitName, this.name!)) {
                            return null; // Trait not satisfied
                        }
                    }
                }
            }
        }

        // Clone the function body with type substitution
        const clonedBody = this.body.clone(bindings) as Block;

        // Create a new assignment-like expression to hold the monomorphized version
        const clonedParams = this.params.map((p) => ({
            name: p.name,
            type: substituteTypeParams(p.type, bindings),
        }));

        // Create a monomorphized function with concrete types
        const monomorphized = new Function(
            { line: this.line, col: this.col, text: this.name!, type: TokenType.Func },
            this.name!,
            clonedParams,
            concreteReturnType as Type,
            [],
            clonedBody,
            true // skipTypeValidation: outer type params are OK here
        );

        // Determine if this monomorphization produced truly concrete types
        // (as opposed to still having type variables from an outer generic function)
        const allConcrete = clonedParams.every(
            (p) =>
                !(p.type instanceof CustomType) ||
                isBuiltinTypeName(p.type.name) ||
                getStruct(p.type.name) !== undefined
        );

        // cascadeTypes the monomorphized version with the original ancestors so that
        // findCaller can resolve functions defined in outer scopes.
        monomorphized.body.cascadeTypes([...(ancestors || []), monomorphized]);

        // Infer return type if the original generic function had no explicit return type
        if (
            this.returnType === "Null" &&
            monomorphized.body.type !== null &&
            monomorphized.body.type !== "Null"
        ) {
            monomorphized.returnType = monomorphized.body.type;
        }

        // Verify return type matches (use inferred type if applicable)
        const finalReturnType =
            this.returnType === "Null" ? monomorphized.returnType : concreteReturnType;
        if (!deepEquals(monomorphized.body.type, finalReturnType)) {
            throw new ASTError(
                this.line,
                this.col,
                `monomorphized function body should return ${finalReturnType}, but found ${monomorphized.body.type}`
            );
        }

        // Only cache and register when the types are truly concrete
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
            // Emit monomorphized versions alongside the original generic function
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

/**
 * Check if a concrete type satisfies a trait by looking for standalone function definitions
 * that match the trait's required function signatures.
 * Searches the global function registry for matching functions.
 */
function checkTraitSatisfied(
    concreteType: Type,
    traitName: string,
    contextFnName: string
): boolean {
    const traitFuncs = getTrait(traitName);
    if (!traitFuncs) return false;

    for (const { name, types } of traitFuncs) {
        // Replace Self with the concrete type to get the required signature
        const requiredParamTypes = types.types.map((t) => {
            if (t === "Self" || (t instanceof CustomType && t.name === "Self")) return concreteType;
            return t;
        });

        const targetFullName = functionNameWithParamTypes(name, requiredParamTypes);

        // Check function registry (includes both non-generic and monomorphized functions)
        const fn = findFunction(targetFullName);
        if (!fn) return false;
    }

    return true;
}

// function getMatchingTraitFuncSignatures(argTypes: Type[]): TemplateTypes[] {
//     const traits: string[] = [];
//     argTypes.forEach(argType => {
//         if (!(argType instanceof CustomType)) {
//             return;
//         }
//         argType.traits.forEach(trait => {
//             if (!traits.includes(trait)) {
//                 traits.push(trait);
//             }
//         });
//     });
//     const signatures: TemplateTypes[] = [];
//     traits.forEach(trait => {
//         const traitFuncs = getTraitFuncs(trait);
//         traitFuncs.forEach(traitFunc => {
//             if (functionIsCompatibleWithArgTypes(traitFunc.params, argTypes)) {
//                 signatures.push(traitFunc.types);
//             }
//         });
//     });
//     return signatures;
// }

/**
 * Find a variable (param or assignment) with a struct type matching the given name.
 * Searches through the ancestors chain for function params and variable assignments.
 * Looks through ALL expressions in each Block (not just older siblings) to find
 * assignments with struct types.
 */
function findStructTypedVariable(
    root: Expression,
    ancestors: Expression[],
    name: string
): { varName: string; structType: Type } | null {
    for (let i = ancestors.length - 1; i >= 0; i--) {
        const ancestor = ancestors[i];
        if (ancestor instanceof Function) {
            // Check ALL params of this function (not just the first match)
            for (const param of ancestor.params) {
                if (param.name === name && param.type instanceof CustomType) {
                    const structInfo = getStruct(param.type.name);
                    if (structInfo) return { varName: name, structType: param.type };
                }
            }
        } else if (ancestor instanceof AnonymousFunction) {
            for (const param of ancestor.params) {
                if (param.name === name && param.type instanceof CustomType) {
                    const structInfo = getStruct(param.type.name);
                    if (structInfo) return { varName: name, structType: param.type };
                }
            }
        } else if (ancestor instanceof Block) {
            // Check ALL expressions in this block for assignments
            for (const expr of ancestor.expressions) {
                let e = expr;
                while (e instanceof DropValue) e = e.child;
                if (e instanceof Assignment && e.name === name) {
                    const varType = e.value.type;
                    if (varType instanceof CustomType) {
                        const structInfo = getStruct(varType.name);
                        if (structInfo) return { varName: name, structType: varType };
                    }
                }
            }
        }
    }
    return null;
}

/**
 * Find a variable (param or assignment) with a string type matching the given name.
 * Returns the variable name if found, null otherwise.
 */
function findStringTypedVariable(
    root: Expression,
    ancestors: Expression[],
    name: string
): string | null {
    for (let i = ancestors.length - 1; i >= 0; i--) {
        const ancestor = ancestors[i];
        if (ancestor instanceof Function) {
            for (const param of ancestor.params) {
                if (param.name === name && param.type === "Str") {
                    return name;
                }
            }
        } else if (ancestor instanceof AnonymousFunction) {
            for (const param of ancestor.params) {
                if (param.name === name && param.type === "Str") {
                    return name;
                }
            }
        } else if (ancestor instanceof Block) {
            for (const expr of ancestor.expressions) {
                let e = expr;
                while (e instanceof DropValue) e = e.child;
                if (e instanceof Assignment && e.name === name) {
                    if (e.value.type === "Str") {
                        return name;
                    }
                }
            }
        }
    }
    return null;
}

function getTraitFunc(
    root: Expression,
    ancestors: Expression[],
    name: string,
    argTypes: Type[]
): { referToByName: string; callerType: CallableType; rootType: Type } | null {
    const traits: { selfType: Type; traitName: string }[] = [];
    argTypes.forEach((argType) => {
        if (!(argType instanceof CustomType)) {
            return;
        }
        argType.traits.forEach((trait) => {
            traits.push({ selfType: argType, traitName: trait });
        });
    });

    // Climb up tree of ancestors looking for functions defined by each trait
    // If a match is found, return it
    let lastAncestor = root;
    for (let i = ancestors.length - 1; i >= 0; i--) {
        const ancestor = ancestors[i];
        if (!(ancestor instanceof Block)) {
            continue;
        }
        const olderSiblings = ancestor.expressions.slice(
            0,
            ancestor.expressions.indexOf(lastAncestor)
        );
        for (let j = olderSiblings.length - 1; j >= 0; j--) {
            const olderSibling = olderSiblings[j];
            if (!(olderSibling instanceof Trait)) {
                continue;
            }
            const matchingTraits = traits.filter((t) => t.traitName === olderSibling.name);
            for (const { selfType, traitName } of matchingTraits) {
                const match = olderSibling.getMatchingFunction(selfType, argTypes);
                if (match !== null) {
                    return {
                        referToByName: "I DONT KNOW",
                        callerType: new FuncType(argTypes, match.returnType), // TODO: Also not sure about this
                        rootType: match.returnType,
                    };
                }
            }
        }
    }

    return null;
}

function paramTypesMatchArgTypes(funcParamTypes: Type[], argTypes: Type[]): boolean {
    if (funcParamTypes.length !== argTypes.length) return false;
    return funcParamTypes.every((t, i) => typesMatchWithConversion(t, argTypes[i]));
}

/**
 * This function takes a root expression (the callable we're trying to resolve) and ancestors,
 * and tries to find a callable with a matching name and type signature.
 * If a matching callable is found, it returns an object with the name to refer to the function by,
 * the type of the function, and the type of the root.
 * If no matching callable is found, it returns an error string.
 */
function findCaller(
    root: Expression,
    ancestors: Expression[],
    name: string,
    argTypes: Type[]
):
    | {
          error: null;
          result: {
              referToByName: string;
              callerType: CallableType;
              rootType: Type;
              paramNames?: string[];
          };
      }
    | { error: string; result: null } {
    // Check if name matches a registered struct (constructor call)
    const structDef = getStruct(name);
    if (structDef) {
        const fieldTypes = structDef.fields.map((f) => f.type);
        if (!paramTypesMatchArgTypes(fieldTypes, argTypes)) {
            return {
                error: `struct ${name} constructor expects arguments of types [${fieldTypes}], got [${argTypes}]`,
                result: null,
            };
        }
        const structType = new CustomType(name);
        return {
            error: null,
            result: {
                referToByName: name,
                callerType: new FuncType(fieldTypes, structType),
                rootType: structType,
            },
        };
    }

    // First try direct match by fullName (existing logic)
    const fullName = functionNameWithParamTypes(name, argTypes);
    const foundFn = findFunction(fullName);
    if (foundFn) {
        return {
            error: null,
            result: {
                referToByName: fullName,
                callerType: foundFn.getFuncType(),
                rootType: foundFn.returnType,
            },
        };
    }

    let lastAncestor: Expression = root;
    for (let i = 0; i < ancestors.length; i++) {
        const ancestor = ancestors[ancestors.length - i - 1];
        if (ancestor instanceof Block) {
            const olderSiblings = ancestor.expressions.slice(
                0,
                ancestor.expressions.indexOf(lastAncestor)
            );
            for (let j = 0; j < olderSiblings.length; j++) {
                let olderSibling = olderSiblings[olderSiblings.length - j - 1];
                while (olderSibling instanceof DropValue) {
                    olderSibling = olderSibling.child;
                }

                // Direct match with a non-generic function — must match NAME too
                if (
                    olderSibling instanceof Function &&
                    !olderSibling.isGeneric &&
                    olderSibling.name === name &&
                    paramTypesMatchArgTypes(
                        olderSibling.params.map((t) => t.type),
                        argTypes
                    )
                ) {
                    return {
                        error: null,
                        result: {
                            referToByName: olderSibling.fullName,
                            callerType: olderSibling.getFuncType(),
                            rootType: olderSibling.returnType,
                        },
                    };
                }

                // Generic function matching — attempt monomorphization
                if (
                    olderSibling instanceof Function &&
                    olderSibling.isGeneric &&
                    olderSibling.params.length === argTypes.length
                ) {
                    // Check if this generic function could match (same name)
                    if (olderSibling.name === name) {
                        const result = olderSibling.monomorphize(argTypes, ancestors);
                        if (result !== null) {
                            // Monomorphization succeeded — resolve to the concrete function
                            return {
                                error: null,
                                result: {
                                    referToByName: result.fullName,
                                    callerType: result.funcType,
                                    rootType: result.returnType,
                                },
                            };
                        }
                    }
                }

                // Variable-based callable (assignment)
                if (olderSibling instanceof Assignment && olderSibling.name === name) {
                    const varType = olderSibling.value.type;
                    if (varType instanceof FuncType) {
                        if (!paramTypesMatchArgTypes(varType.paramTypes, argTypes)) {
                            return {
                                error: `most recent definition of variable ${name} has an incompatible type signature for this function call.`,
                                result: null,
                            };
                        }
                        return {
                            error: null,
                            result: {
                                referToByName: name,
                                callerType: varType,
                                rootType: varType.returnType,
                            },
                        };
                    }
                    if (varType instanceof ArrayType) {
                        const incompatible = varType.checkIndicesCompatible(argTypes);
                        if (incompatible !== null) {
                            return { error: incompatible, result: null };
                        }
                        return {
                            error: null,
                            result: {
                                referToByName: name,
                                callerType: varType,
                                rootType: varType.innerType,
                            },
                        };
                    }
                    if (varType instanceof IterType) {
                        const incompatible = varType.checkIndicesCompatible(argTypes);
                        if (incompatible !== null) {
                            return { error: incompatible, result: null };
                        }
                        return {
                            error: null,
                            result: {
                                referToByName: name,
                                callerType: varType,
                                rootType: varType.innerType,
                            },
                        };
                    }
                    // Struct types: fall through — might be struct field access handled by Call.cascadeTypes
                    if (varType instanceof CustomType && getStruct(varType.name)) {
                        break;
                    }
                    // String types: fall through — might be string indexing handled by Call.cascadeTypes
                    if (varType === "Str") {
                        break;
                    }
                    return {
                        error: `most recent definition of variable ${name} is of type ${varType}, which is not a callable object.`,
                        result: null,
                    };
                }
            }
        } else if (ancestor instanceof Function) {
            // Check both the function params and the function itself (in the case of recursive functions)
            for (const param of ancestor.params) {
                if (param.name === name) {
                    if (param.type instanceof FuncType) {
                        if (!paramTypesMatchArgTypes(param.type.paramTypes, argTypes)) {
                            return {
                                error: `variable ${name} (parameter of function ${ancestor.name}) has an incompatible type signature for this function call.`,
                                result: null,
                            };
                        }
                        return {
                            error: null,
                            result: {
                                referToByName: name,
                                callerType: param.type,
                                rootType: param.type.returnType,
                            },
                        };
                    }
                    if (param.type instanceof ArrayType) {
                        const incompatible = param.type.checkIndicesCompatible(argTypes);
                        if (incompatible !== null) {
                            return { error: incompatible, result: null };
                        }
                        return {
                            error: null,
                            result: {
                                referToByName: name,
                                callerType: param.type,
                                rootType: param.type.innerType,
                            },
                        };
                    }
                    if (param.type instanceof IterType) {
                        const incompatible = param.type.checkIndicesCompatible(argTypes);
                        if (incompatible !== null) {
                            return { error: incompatible, result: null };
                        }
                        return {
                            error: null,
                            result: {
                                referToByName: name,
                                callerType: param.type,
                                rootType: param.type.innerType,
                            },
                        };
                    }
                    // Struct types: fall through — might be struct field access handled by Call.cascadeTypes
                    if (param.type instanceof CustomType && getStruct(param.type.name)) {
                        break;
                    }
                    // String types: fall through — might be string indexing handled by Call.cascadeTypes
                    if (param.type === "Str") {
                        break;
                    }
                    return {
                        error: `variable ${name} (parameter of function ${ancestor.name}) is not a function.`,
                        result: null,
                    };
                }
            }
            if (ancestor.fullName === fullName) {
                // Recursive function
                return {
                    error: null,
                    result: {
                        referToByName: fullName,
                        callerType: ancestor.getFuncType(),
                        rootType: ancestor.returnType,
                    },
                };
            }
        }
        lastAncestor = ancestor;
    }

    // Check for type conversion builtins
    if (argTypes.length === 1) {
        const conversionResult = findTypeConversion(name, argTypes[0]);
        if (conversionResult) {
            return conversionResult;
        }
    }

    // Trait dispatch: if arg types are CustomTypes with trait bounds and the call name matches a trait method
    const traitCandidates: { traitName: string; selfType: Type }[] = [];
    for (const argType of argTypes) {
        if (argType instanceof CustomType) {
            for (const trait of argType.traits) {
                traitCandidates.push({ traitName: trait, selfType: argType });
            }
        }
    }
    for (const { traitName, selfType } of traitCandidates) {
        const traitFuncs = getTrait(traitName);
        if (!traitFuncs) continue;
        for (const tf of traitFuncs) {
            if (tf.name !== name) continue;
            // Replace "Self" (stored as string literal, not CustomType) with selfType
            const replacedParamTypes = tf.types.types.map((t) => {
                if (t === "Self" || (t instanceof CustomType && t.name === "Self")) return selfType;
                return t;
            });
            if (paramTypesMatchArgTypes(replacedParamTypes, argTypes)) {
                const returnType =
                    tf.types.returnType !== null
                        ? tf.types.returnType === "Self" ||
                          (tf.types.returnType instanceof CustomType &&
                              tf.types.returnType.name === "Self")
                            ? selfType
                            : tf.types.returnType
                        : "Null";
                return {
                    error: null,
                    result: {
                        referToByName: name,
                        callerType: new FuncType(argTypes, returnType),
                        rootType: returnType,
                        paramNames: tf.paramNames,
                    },
                };
            }
        }
    }

    // Fallback: when inside a generic function body, check if the call name matches
    // a trait function required by the function's type params. This handles cases
    // where type variables (like T) don't carry their traits on the arg type objects.
    for (let ai = ancestors.length - 1; ai >= 0; ai--) {
        const ancestor = ancestors[ai];
        if (ancestor instanceof Function && ancestor.isGeneric) {
            for (const tp of ancestor.typeParams) {
                // Collect traits for this type param by examining the function's params/return type
                const traits = new Set<string>();
                for (const param of ancestor.params) {
                    for (const t of collectTraitsForTypeParam(param.type, tp)) {
                        traits.add(t);
                    }
                }
                // Also check the return type
                for (const t of collectTraitsForTypeParam(ancestor.returnType, tp)) {
                    traits.add(t);
                }
                for (const traitName of traits) {
                    const traitFuncs = getTrait(traitName);
                    if (!traitFuncs) continue;
                    for (const tf of traitFuncs) {
                        if (tf.name !== name) continue;
                        // Replace Self with the type variable T for trait matching
                        const selfType = new CustomType(tp);
                        const replacedParamTypes = tf.types.types.map((t) => {
                            if (t === "Self" || (t instanceof CustomType && t.name === "Self"))
                                return selfType;
                            return t;
                        });
                        if (paramTypesMatchArgTypes(replacedParamTypes, argTypes)) {
                            const returnType =
                                tf.types.returnType !== null
                                    ? tf.types.returnType === "Self" ||
                                      (tf.types.returnType instanceof CustomType &&
                                          tf.types.returnType.name === "Self")
                                        ? selfType
                                        : tf.types.returnType
                                    : "Null";
                            return {
                                error: null,
                                result: {
                                    referToByName: name,
                                    callerType: new FuncType(argTypes, returnType),
                                    rootType: returnType,
                                    paramNames: tf.paramNames,
                                },
                            };
                        }
                    }
                }
            }
            break; // Only check the innermost enclosing generic function
        }
    }

    return {
        error: `function ${name}[${argTypes.map((t) => t.toString()).join(", ")}: unknown] not found`,
        result: null,
    };
}

// Type conversion builtins — maps function name + input type to { returnType, jsConversion }
const TYPE_CONVERSIONS: Record<
    string,
    Record<string, { returnType: Type; jsExpr: (arg: string) => string }>
> = {
    toStr: {
        Int: { returnType: "Str", jsExpr: (a) => `String(${a})` },
        Float: { returnType: "Str", jsExpr: (a) => `String(${a})` },
        Bool: { returnType: "Str", jsExpr: (a) => `String(${a})` },
    },
    toInt: {
        Float: { returnType: "Int", jsExpr: (a) => `BigInt(Math.trunc(${a}))` },
        Bool: { returnType: "Int", jsExpr: (a) => `BigInt(${a})` },
    },
    toFloat: {
        Int: { returnType: "Float", jsExpr: (a) => `Number(${a})` },
    },
    toBool: {
        Int: { returnType: "Bool", jsExpr: (a) => `Boolean(${a})` },
        Float: { returnType: "Bool", jsExpr: (a) => `Boolean(${a})` },
    },
};

function findTypeConversion(
    name: string,
    inputType: Type
): {
    error: null;
    result: {
        referToByName: string;
        callerType: FuncType;
        rootType: Type;
        isTypeConversion: true;
        jsExpr: (arg: string) => string;
    };
} | null {
    const byInput = TYPE_CONVERSIONS[name];
    if (!byInput) return null;
    let inputTypeKey: string | null = null;
    if (inputType === "Int") inputTypeKey = "Int";
    else if (inputType === "Float") inputTypeKey = "Float";
    else if (inputType === "Bool") inputTypeKey = "Bool";
    else if (inputType === "Str") inputTypeKey = "Str";
    if (!inputTypeKey) return null;
    const conversion = byInput[inputTypeKey];
    if (!conversion) return null;
    const fullName = functionNameWithParamTypes(name, [inputType]);
    return {
        error: null,
        result: {
            referToByName: fullName,
            callerType: new FuncType([inputType], conversion.returnType),
            rootType: conversion.returnType,
            isTypeConversion: true,
            jsExpr: conversion.jsExpr,
        },
    };
}

export class Call extends Expression {
    name: string;
    args: Expression[];
    keywordArgs: { name: string; value: Expression }[] = [];

    callerType?: CallableType;
    referToByName?: string;
    isStructFieldAccess: boolean = false;
    structFieldName: string = "";
    isStringIndexing: boolean = false;
    isTypeConversion: boolean = false;
    conversionJsExpr: ((arg: string) => string) | null = null;

    constructor(nameToken: Token, args: Expression[]) {
        if (nameToken.type !== TokenType.Identifier) {
            throw new Error("call name must be an identifier");
        }
        super(nameToken.line, nameToken.col);
        this.name = nameToken.text;
        this.args = args;
    }

    cascadeTypes(ancestors: Expression[]): void {
        // Cascade types on all positional and keyword arg expressions first
        const positionalArgTypes = this.args.map((arg, i) => {
            arg.cascadeTypes([...ancestors, this]);
            if (arg.type === null) {
                throw this.error(`unable to resolve type of argument ${i + 1} in call`);
            }
            return arg.type;
        });

        const keywordInfos = this.keywordArgs.map((k) => {
            k.value.cascadeTypes([...ancestors, this]);
            if (k.value.type === null) {
                throw this.error(`unable to resolve type of keyword argument '${k.name}'`);
            }
            return { name: k.name, type: k.value.type, value: k.value };
        });

        // If keyword args exist, resolve to positional order FIRST, then call findCaller
        if (this.keywordArgs.length > 0) {
            // Inline keyword resolution: find the function/struct, reorder args by name
            const totalArgs = this.args.length + keywordInfos.length;

            // Try struct constructor first
            const structDef = getStruct(this.name);
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
                // Search ancestors for a matching function
                let lastAncestor: Expression = this;
                for (let ai = ancestors.length - 1; ai >= 0; ai--) {
                    const ancestor = ancestors[ai];
                    if (ancestor instanceof Block) {
                        const olderSiblings = ancestor.expressions.slice(
                            0,
                            ancestor.expressions.indexOf(lastAncestor)
                        );
                        for (let sj = olderSiblings.length - 1; sj >= 0; sj--) {
                            let sib = olderSiblings[sj];
                            while (sib instanceof DropValue) {
                                sib = sib.child;
                            }
                            if (
                                sib instanceof Function &&
                                sib.name === this.name &&
                                !sib.isGeneric &&
                                sib.params.length === totalArgs
                            ) {
                                const paramNames = sib.params.map((p) => p.name);
                                // Check if ALL keyword names match this function's param names
                                const allKeywordsMatch = keywordInfos.every((kw) =>
                                    paramNames.includes(kw.name)
                                );
                                if (!allKeywordsMatch) {
                                    // Keyword names don't match this concrete function — skip it.
                                    // Could be a trait-based call; let findCaller resolve it.
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
                                // Found and resolved — break out of all loops
                                ai = -1;
                                break;
                            }
                        }
                    }
                    lastAncestor = ancestor;
                }
            }
        }

        // After keyword resolution, recompute allArgTypes from the (possibly reordered) args.
        // If keyword args were resolved (keywordArgs cleared), use the resolved args directly.
        // Otherwise, combine positional and keyword types for findCaller.
        let allArgTypes: Type[];
        if (this.keywordArgs.length === 0) {
            // Resolution succeeded — use reordered args
            allArgTypes = this.args.map((arg) => arg.type as Type);
        } else {
            // Resolution didn't happen (trait dispatch) — combine types
            allArgTypes = [...positionalArgTypes, ...keywordInfos.map((k) => k.type)];
        }

        const { error, result } = findCaller(this, ancestors, this.name, allArgTypes);
        if (error !== null) {
            // Check if this is a struct field access: varName("fieldName")
            if (
                allArgTypes.length === 1 &&
                allArgTypes[0] === "Str" &&
                this.args[0] instanceof Literal
            ) {
                const fieldName = this.args[0].value.slice(1, -1);
                const structVar = findStructTypedVariable(this, ancestors, this.name);
                if (structVar !== null) {
                    const structInfo =
                        structVar.structType instanceof CustomType
                            ? getStruct(structVar.structType.name)
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
            if (allArgTypes.length === 1 && allArgTypes[0] === "Int") {
                const stringVarType = findStringTypedVariable(this, ancestors, this.name);
                if (stringVarType !== null) {
                    this.type = "Str";
                    this.referToByName = this.name;
                    this.isStringIndexing = true;
                    return;
                }
            }
            throw this.error(error);
        }
        if ((result as any).isTypeConversion) {
            const convResult = result as any;
            this.isTypeConversion = true;
            this.conversionJsExpr = convResult.jsExpr;
        }
        this.referToByName = result.referToByName;
        this.callerType = result.callerType;
        this.type = result.rootType;

        // If keyword args weren't resolved by ancestor search, try trait param names
        if (
            this.keywordArgs.length > 0 &&
            this.args.length < positionalArgTypes.length + keywordInfos.length &&
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
            // Fallback: look up the resolved function by name and use its param names
            const resolvedFn = findFunction(result.referToByName);
            if (
                resolvedFn &&
                resolvedFn.params.length === positionalArgTypes.length + keywordInfos.length
            ) {
                const paramNames = resolvedFn.params.map((p) => p.name);
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
        // Struct field access: p("x") → p.x
        if (this.isStructFieldAccess) {
            writer.write(writer.safeName(this.referToByName!));
            writer.write(`.${this.structFieldName}`);
            return;
        }
        // Type conversion: toStr(152) → String(arg)
        if (this.isTypeConversion && this.conversionJsExpr) {
            const jsExpr = this.conversionJsExpr;
            const conversionStr = jsExpr("%%ARG%%");
            const parts = conversionStr.split("%%ARG%%");
            writer.write(parts[0]);
            this.args[0].toJS(writer);
            if (parts.length > 1) {
                writer.write(parts[1]);
            }
            return;
        }
        // String indexing: x(index) → x[index]
        if (this.isStringIndexing) {
            writer.write(writer.safeName(this.referToByName!));
            writer.write("[");
            this.args[0].toJS(writer);
            writer.write("]");
            return;
        }
        if (this.callerType instanceof FuncType) {
            // Check if this is a struct constructor (call name matches a registered struct name)
            const structInfo =
                this.type instanceof CustomType ? getStruct(this.type.name) : undefined;
            // Only use constructor formatting when the call name directly matches the struct name,
            // not when a regular function call happens to return a struct type
            if (structInfo && this.name === structInfo.name) {
                // Generate object literal: {field1: arg1, field2: arg2}
                writer.write("{");
                this.args.forEach((arg, i) => {
                    if (i > 0) {
                        writer.write(", ");
                    }
                    writer.write(`${structInfo.fields[i].name}: `);
                    arg.toJS(writer);
                });
                writer.write("}");
            } else {
                writer.write(writer.safeName(this.referToByName));
                writer.write("(");
                // Look up the function to check for Array→Iter conversion needed at call site
                const calledFn = findFunction(this.referToByName);
                const iterParamIndices: number[] = [];
                if (calledFn) {
                    calledFn.params.forEach((p, i) => {
                        if (p.type instanceof IterType && i < this.args.length) {
                            const argType = this.args[i].type;
                            if (argType instanceof ArrayType) {
                                iterParamIndices.push(i);
                            }
                        }
                    });
                }
                this.args.forEach((arg, i) => {
                    if (i > 0) {
                        writer.write(", ");
                    }
                    if (iterParamIndices.includes(i)) {
                        writer.useBuiltin("__ARRAYITER__");
                        writer.write("__ARRAYITER__(");
                        arg.toJS(writer);
                        writer.write(")");
                    } else {
                        arg.toJS(writer);
                    }
                });
                writer.write(")");
            }
        } else if (this.callerType instanceof IterType) {
            // Iterate up to the desired index and return that element
            writer.useBuiltin("__ITER_GET__");
            writer.write("__ITER_GET__(");
            writer.write(writer.safeName(this.referToByName));
            writer.write(", ");
            this.args.forEach((arg, i) => {
                if (i > 0) {
                    writer.write(", ");
                }
                arg.toJS(writer);
            });
            writer.write(")");
        } else if (this.callerType instanceof ArrayType) {
            writer.write(writer.safeName(this.referToByName));
            this.args.forEach((arg, i) => {
                writer.write("[");
                arg.toJS(writer);
                writer.write("]");
            });
        } else {
            throw new Error(`unknown caller type: ${this.callerType}`);
        }
    }
}

export class DirectCall extends Expression {
    caller: Expression;
    args: Expression[];
    keywordArgs: { name: string; value: Expression }[] = [];

    constructor(caller: Expression, args: Expression[]) {
        super(caller.line, caller.col);
        this.caller = caller;
        this.args = args;
    }

    cascadeTypes(ancestors: Expression[]): void {
        this.caller.cascadeTypes(ancestors);
        if (this.caller.type === null) {
            throw this.error("unable to resolve type of call");
        }
        if (this.caller.type instanceof FuncType) {
            const argTypes = this.args.map((arg, i) => {
                arg.cascadeTypes([...ancestors, this]);
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
        if (this.caller.type instanceof ArrayType) {
            const incompatible = this.caller.type.checkIndicesCompatible(
                this.args.map((arg) => arg.type as Type)
            );
            if (incompatible !== null) {
                throw this.error(incompatible);
            }
            this.type = this.caller.type.innerType;
            return;
        }
        if (this.caller.type instanceof IterType) {
            this.args.forEach((arg, i) => {
                arg.cascadeTypes([...ancestors, this]);
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
            this.type = this.caller.type.innerType;
            return;
        }
        // String indexing: "hello"(0) → character at index 0
        if (this.caller.type === "Str") {
            this.args.forEach((arg, i) => {
                arg.cascadeTypes([...ancestors, this]);
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
            if (this.args[0].type !== "Int") {
                throw this.error(`string index must be of type Int`);
            }
            this.type = "Str";
            return;
        }

        // Struct field access: instance("fieldName")
        if (this.caller.type instanceof CustomType) {
            const structInfo = getStruct(this.caller.type.name);
            if (structInfo) {
                if (this.args.length !== 1) {
                    throw this.error(
                        `struct field access requires exactly one argument (the field name), got ${this.args.length}`
                    );
                }
                this.args[0].cascadeTypes([...ancestors, this]);
                if (this.args[0].type === null) {
                    throw this.error("unable to resolve type of field name argument");
                }
                if (this.args[0].type !== "Str" || !(this.args[0] instanceof Literal)) {
                    throw this.error(`struct field access requires a string literal field name`);
                }
                const fieldName = this.args[0].value;
                // Strip quotes from the string literal value
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
        // String indexing: "hello"(0) → "hello"[0]
        if (this.caller.type === "Str") {
            this.caller.toJS(writer);
            writer.write("[");
            this.args[0].toJS(writer);
            writer.write("]");
        } else if (this.caller.type instanceof CustomType && getStruct(this.caller.type.name)) {
            // Struct field access: p("x") → p.x
            const fieldName =
                this.args[0] instanceof Literal
                    ? this.args[0].value.slice(1, -1) // Strip quotes
                    : "";
            writer.write("(");
            this.caller.toJS(writer);
            writer.write(`).${fieldName}`);
        } else if (this.caller.type instanceof IterType) {
            // Iterate up to the desired index and return that element
            writer.useBuiltin("__ITER_GET__");
            writer.write("__ITER_GET__(");
            this.caller.toJS(writer);
            writer.write(", ");
            this.args.forEach((arg, i) => {
                if (i > 0) {
                    writer.write(", ");
                }
                arg.toJS(writer);
            });
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
                    arg.toJS(writer);
                });
                writer.write(")");
            } else if (this.caller.type instanceof ArrayType) {
                this.args.forEach((arg, i) => {
                    writer.write("[");
                    arg.toJS(writer);
                    writer.write("]");
                });
            } else {
                throw new Error(`unknown caller type: ${this.caller.type}`);
            }
        }
    }
}

export class Array extends Expression {
    expressions: Expression[];
    innerType?: Type;

    constructor(startToken: Token, expressions: Expression[], innerType?: Type) {
        super(startToken.line, startToken.col);
        this.expressions = expressions;
        if (innerType !== undefined) {
            this.innerType = innerType;
        }
    }

    cascadeTypes(ancestors: Expression[]): void {
        this.expressions.forEach((expr, i) => {
            expr.cascadeTypes(ancestors);
            if (expr.type === null) {
                throw this.error(`unable to resolve type of array element ${i + 1}`);
            }
            if (this.innerType === undefined) {
                this.innerType = expr.type;
            } else if (!deepEquals(this.innerType, expr.type)) {
                throw this.error(
                    `incompatible types in array: expected ${this.innerType}, got ${expr.type}`
                );
            }
        });
        if (this.innerType === undefined) {
            throw this.error(`empty array must be annotated with a type`);
        }
        this.type = new ArrayType(this.innerType);
    }

    clone(bindings?: Map<string, Type>): Expression {
        // Don't pass innerType — let the clone re-infer it from cloned elements
        const cloned = new Array(
            { line: this.line, col: this.col, text: "[", type: TokenType.LBracket },
            this.expressions.map((e) => e.clone(bindings)),
            undefined
        );
        return cloned;
    }

    toJS(writer: JSWriter): void {
        writer.write("[");
        this.expressions.forEach((expr, i) => {
            if (i > 0) {
                writer.write(", ");
            }
            expr.toJS(writer);
        });
        writer.write("]");
    }
}

export class RangeIter extends Expression {
    start: Expression;
    end: Expression;
    step: Expression | null;

    constructor(startToken: Token, start: Expression, end: Expression, step: Expression | null) {
        super(startToken.line, startToken.col);
        this.start = start;
        this.end = end;
        this.step = step;
    }

    cascadeTypes(ancestors: Expression[]): void {
        this.start.cascadeTypes(ancestors);
        if (this.start.type === null) {
            throw this.error("unable to resolve type of range start expression");
        }
        if (this.start.type !== "Int") {
            throw this.error("range start expression must be an integer");
        }
        this.end.cascadeTypes(ancestors);
        if (this.end.type === null) {
            throw this.error("unable to resolve type of range end expression");
        }
        if (this.end.type !== "Int") {
            throw this.error("range end expression must be an integer");
        }
        if (this.step !== null) {
            this.step.cascadeTypes(ancestors);
            if (this.step.type === null) {
                throw this.error("unable to resolve type of range step expression");
            }
            if (this.step.type !== "Int") {
                throw this.error("range step expression must be an integer");
            }
        }

        this.type = new IterType("Int");
    }

    clone(bindings?: Map<string, Type>): Expression {
        const cloned = new RangeIter(
            { line: this.line, col: this.col, text: "range", type: TokenType.Range },
            this.start.clone(bindings),
            this.end.clone(bindings),
            this.step ? this.step.clone(bindings) : null
        );
        return cloned;
    }

    toJS(writer: JSWriter): void {
        writer.useBuiltin("__RANGEITER__");
        writer.write("__RANGEITER__(");
        this.start.toJS(writer);
        writer.write(", ");
        this.end.toJS(writer);
        if (this.step !== null) {
            writer.write(", ");
            this.step.toJS(writer);
        }
        writer.write(")");
    }
}

export class MapIter extends Expression {
    mapFn: Expression;
    iterOver: Expression;

    mapFnIsArray: boolean = false;
    iterOverIsArray: boolean = false;
    referToMapFnByName: string | null = null;

    constructor(startToken: Token, mapFn: Expression, iterOver: Expression) {
        super(startToken.line, startToken.col);
        this.mapFn = mapFn;
        this.iterOver = iterOver;
    }

    cascadeTypes(ancestors: Expression[]): void {
        this.iterOver.cascadeTypes(ancestors);
        if (this.iterOver.type === null) {
            throw this.error("unable to resolve type of iterable expression");
        }
        let iterInnerType: Type;
        if (this.iterOver.type instanceof ArrayType) {
            iterInnerType = this.iterOver.type.innerType;
            this.iterOverIsArray = true;
        } else if (this.iterOver.type instanceof IterType) {
            iterInnerType = this.iterOver.type.innerType;
        } else {
            throw this.error(
                `cannot map over non-iterable object (expression of type ${this.iterOver.type})`
            );
        }

        // If mapFn is a Variable Expression, it may actually refer to a function, not to an extant variable
        let mapFnType: Type;
        if (this.mapFn instanceof Variable) {
            const { result, error } = findCaller(this, ancestors, this.mapFn.name, [iterInnerType]);
            if (error !== null) {
                throw this.error(error);
            }
            this.referToMapFnByName = result.referToByName;
            mapFnType = result.callerType;
        } else {
            this.mapFn.cascadeTypes(ancestors);
            if (this.mapFn.type === null) {
                throw this.error("unable to resolve type of map function");
            }
            mapFnType = this.mapFn.type;
        }
        let inputType: Type;
        let outputType: Type;
        if (mapFnType instanceof FuncType) {
            if (mapFnType.paramTypes.length !== 1) {
                throw this.error("map function must take exactly one argument");
            }
            inputType = mapFnType.paramTypes[0];
            outputType = mapFnType.returnType;
        } else if (mapFnType instanceof ArrayType) {
            this.mapFnIsArray = true;
            inputType = "Int";
            outputType = mapFnType.innerType;
        } else {
            throw this.error(
                `cannot map with non-callable object (expression of type ${mapFnType})`
            );
        }

        if (!typeEquals(iterInnerType, inputType)) {
            throw this.error(
                `incompatible types in map: expected ${inputType}, but iterable is over type ${iterInnerType}`
            );
        }

        this.type = new IterType(outputType);
    }

    clone(bindings?: Map<string, Type>): Expression {
        const cloned = new MapIter(
            { line: this.line, col: this.col, text: "map", type: TokenType.Map },
            this.mapFn.clone(bindings),
            this.iterOver.clone(bindings)
        );
        return cloned;
    }

    toJS(writer: JSWriter): void {
        if (this.mapFnIsArray) {
            writer.useBuiltin("__ARRAYMAPITER__");
            writer.write("__ARRAYMAPITER__(");
        } else {
            writer.useBuiltin("__MAPITER__");
            writer.write("__MAPITER__(");
        }
        if (this.referToMapFnByName !== null) {
            writer.write(writer.safeName(this.referToMapFnByName));
        } else {
            this.mapFn.toJS(writer);
        }
        writer.write(", ");
        if (this.iterOverIsArray) {
            // Convert to Array Iterator first
            writer.useBuiltin("__ARRAYITER__");
            writer.write("__ARRAYITER__(");
            this.iterOver.toJS(writer);
            writer.write(")");
        } else {
            this.iterOver.toJS(writer);
        }
        writer.write(")");
    }
}

export class Reduce extends Expression {
    reduceFn: Expression;
    initValue: Expression;
    iterOver: Expression;

    iterOverIsArray: boolean = false;
    referToReduceFnByName: string | null = null;

    constructor(
        startToken: Token,
        reduceFn: Expression,
        initValue: Expression,
        iterOver: Expression
    ) {
        super(startToken.line, startToken.col);
        this.reduceFn = reduceFn;
        this.initValue = initValue;
        this.iterOver = iterOver;
    }

    cascadeTypes(ancestors: Expression[]): void {
        this.initValue.cascadeTypes(ancestors);
        if (this.initValue.type === null) {
            throw this.error("unable to resolve type of initial value");
        }
        this.iterOver.cascadeTypes(ancestors);
        if (this.iterOver.type === null) {
            throw this.error("unable to resolve type of iterable expression");
        }
        let iterInnerType: Type;
        if (this.iterOver.type instanceof ArrayType) {
            iterInnerType = this.iterOver.type.innerType;
            this.iterOverIsArray = true;
        } else if (this.iterOver.type instanceof IterType) {
            iterInnerType = this.iterOver.type.innerType;
        } else {
            throw this.error(
                `cannot reduce with non-iterable object (expression of type ${this.iterOver.type})`
            );
        }

        // If filterFn is a Variable Expression, it may actually refer to a function, not to an extant variable
        let reduceFnType: Type;
        if (this.reduceFn instanceof Variable) {
            const { result, error } = findCaller(this, ancestors, this.reduceFn.name, [
                this.initValue.type,
                iterInnerType,
            ]);
            if (error !== null) {
                throw this.error(error);
            }
            this.referToReduceFnByName = result.referToByName;
            reduceFnType = result.callerType;
        } else {
            this.reduceFn.cascadeTypes(ancestors);
            if (this.reduceFn.type === null) {
                throw this.error("unable to resolve type of reduce function");
            }
            reduceFnType = this.reduceFn.type;
        }
        let accType: Type;
        let inputType: Type;
        if (reduceFnType instanceof FuncType) {
            if (reduceFnType.paramTypes.length !== 2) {
                throw this.error(
                    "reduce function must take exactly two arguments (an accumulator and the current element)"
                );
            }
            accType = reduceFnType.paramTypes[0];
            inputType = reduceFnType.paramTypes[1];
            if (!typeEquals(reduceFnType.returnType, accType)) {
                // Inside a generic function body, type variables may not yet be resolved
                if (isConcreteType(reduceFnType.returnType) && isConcreteType(accType)) {
                    throw this.error(
                        "reduce function must return the same type as its accumulator (first argument)"
                    );
                }
            }
        } else {
            throw this.error(
                `cannot reduce with non-function object (expression of type ${reduceFnType})`
            );
        }

        if (!typeEquals(iterInnerType, inputType)) {
            if (isConcreteType(iterInnerType) && isConcreteType(inputType)) {
                throw this.error(
                    `incompatible types in reduce: expected ${inputType}, but iterable is over type ${iterInnerType}`
                );
            }
        }
        if (!typeEquals(accType, this.initValue.type)) {
            if (isConcreteType(accType) && isConcreteType(this.initValue.type)) {
                throw this.error(
                    `incompatible types in reduce: expected ${accType}, but initial value is of type ${this.initValue.type}`
                );
            }
        }

        this.type = accType;
    }

    clone(bindings?: Map<string, Type>): Expression {
        const cloned = new Reduce(
            { line: this.line, col: this.col, text: "reduce", type: TokenType.Reduce },
            this.reduceFn.clone(bindings),
            this.initValue.clone(bindings),
            this.iterOver.clone(bindings)
        );
        return cloned;
    }

    toJS(writer: JSWriter): void {
        writer.useBuiltin("__REDUCE__");
        writer.write("__REDUCE__(");
        if (this.referToReduceFnByName !== null) {
            writer.write(writer.safeName(this.referToReduceFnByName));
        } else {
            this.reduceFn.toJS(writer);
        }
        writer.write(", ");
        this.initValue.toJS(writer);
        writer.write(", ");
        if (this.iterOverIsArray) {
            // Convert to Array Iterator first
            writer.useBuiltin("__ARRAYITER__");
            writer.write("__ARRAYITER__(");
            this.iterOver.toJS(writer);
            writer.write(")");
        } else {
            this.iterOver.toJS(writer);
        }
        writer.write(")");
    }
}

export class FilterIter extends Expression {
    filterFn: Expression;
    iterOver: Expression;

    iterOverIsArray: boolean = false;
    referToFilterFnByName: string | null = null;

    constructor(startToken: Token, filterFn: Expression, iterOver: Expression) {
        super(startToken.line, startToken.col);
        this.filterFn = filterFn;
        this.iterOver = iterOver;
    }

    cascadeTypes(ancestors: Expression[]): void {
        this.iterOver.cascadeTypes(ancestors);
        if (this.iterOver.type === null) {
            throw this.error("unable to resolve type of iterable expression");
        }
        let iterInnerType: Type;
        if (this.iterOver.type instanceof ArrayType) {
            iterInnerType = this.iterOver.type.innerType;
            this.iterOverIsArray = true;
        } else if (this.iterOver.type instanceof IterType) {
            iterInnerType = this.iterOver.type.innerType;
        } else {
            throw this.error(
                `cannot filter non-iterable object (expression of type ${this.iterOver.type})`
            );
        }

        // If filterFn is a Variable Expression, it may actually refer to a function, not to an extant variable
        let filterFnType: Type;
        if (this.filterFn instanceof Variable) {
            const { result, error } = findCaller(this, ancestors, this.filterFn.name, [
                iterInnerType,
            ]);
            if (error !== null) {
                throw this.error(error);
            }
            this.referToFilterFnByName = result.referToByName;
            filterFnType = result.callerType;
        } else {
            this.filterFn.cascadeTypes(ancestors);
            if (this.filterFn.type === null) {
                throw this.error("unable to resolve type of filter function");
            }
            filterFnType = this.filterFn.type;
        }
        let inputType: Type;
        if (filterFnType instanceof FuncType) {
            if (filterFnType.paramTypes.length !== 1) {
                throw this.error("filter function must take exactly one argument");
            }
            inputType = filterFnType.paramTypes[0];
            if (filterFnType.returnType !== "Bool") {
                throw this.error("filter function must return a boolean");
            }
        } else {
            throw this.error(
                `cannot filter with non-function object (expression of type ${filterFnType})`
            );
        }

        if (!typeEquals(iterInnerType, inputType)) {
            throw this.error(
                `incompatible types in filter: expected ${inputType}, but iterable is over type ${iterInnerType}`
            );
        }

        this.type = new IterType(iterInnerType);
    }

    clone(bindings?: Map<string, Type>): Expression {
        const cloned = new FilterIter(
            { line: this.line, col: this.col, text: "filter", type: TokenType.Filter },
            this.filterFn.clone(bindings),
            this.iterOver.clone(bindings)
        );
        return cloned;
    }

    toJS(writer: JSWriter): void {
        writer.useBuiltin("__FILTERITER__");
        writer.write("__FILTERITER__(");
        if (this.referToFilterFnByName !== null) {
            writer.write(writer.safeName(this.referToFilterFnByName));
        } else {
            this.filterFn.toJS(writer);
        }
        writer.write(", ");
        if (this.iterOverIsArray) {
            // Convert to Array Iterator first
            writer.useBuiltin("__ARRAYITER__");
            writer.write("__ARRAYITER__(");
            this.iterOver.toJS(writer);
            writer.write(")");
        } else {
            this.iterOver.toJS(writer);
        }
        writer.write(")");
    }
}

export class TakeIter extends Expression {
    count: Expression;
    iter: Expression;
    iterIsArray: boolean = false;

    constructor(startToken: Token, count: Expression, iter: Expression) {
        super(startToken.line, startToken.col);
        this.count = count;
        this.iter = iter;
    }

    cascadeTypes(ancestors: Expression[]): void {
        this.count.cascadeTypes(ancestors);
        if (this.count.type === null) {
            throw this.error("unable to resolve type of count expression");
        }
        if (this.count.type !== "Int") {
            throw this.error("take count must be an integer");
        }
        this.iter.cascadeTypes(ancestors);
        if (this.iter.type === null) {
            throw this.error("unable to resolve type of iterable expression");
        }
        let innerType: Type;
        if (this.iter.type instanceof ArrayType) {
            innerType = this.iter.type.innerType;
            this.iterIsArray = true;
        } else if (this.iter.type instanceof IterType) {
            innerType = this.iter.type.innerType;
        } else {
            throw this.error(
                `cannot take from non-iterable object (expression of type ${this.iter.type})`
            );
        }
        this.type = new IterType(innerType);
    }

    clone(bindings?: Map<string, Type>): Expression {
        const cloned = new TakeIter(
            { line: this.line, col: this.col, text: "take", type: TokenType.Take },
            this.count.clone(bindings),
            this.iter.clone(bindings)
        );
        return cloned;
    }

    toJS(writer: JSWriter): void {
        writer.useBuiltin("__TAKEITER__");
        writer.write("__TAKEITER__(");
        this.count.toJS(writer);
        writer.write(", ");
        if (this.iterIsArray) {
            writer.useBuiltin("__ARRAYITER__");
            writer.write("__ARRAYITER__(");
            this.iter.toJS(writer);
            writer.write(")");
        } else {
            this.iter.toJS(writer);
        }
        writer.write(")");
    }
}

export class TakeWhileIter extends Expression {
    pred: Expression;
    iter: Expression;
    iterIsArray: boolean = false;
    referToPredByName: string | null = null;

    constructor(startToken: Token, pred: Expression, iter: Expression) {
        super(startToken.line, startToken.col);
        this.pred = pred;
        this.iter = iter;
    }

    cascadeTypes(ancestors: Expression[]): void {
        this.iter.cascadeTypes(ancestors);
        if (this.iter.type === null) {
            throw this.error("unable to resolve type of iterable expression");
        }
        let iterInnerType: Type;
        if (this.iter.type instanceof ArrayType) {
            iterInnerType = this.iter.type.innerType;
            this.iterIsArray = true;
        } else if (this.iter.type instanceof IterType) {
            iterInnerType = this.iter.type.innerType;
        } else {
            throw this.error(
                `cannot use takeWhile on non-iterable object (expression of type ${this.iter.type})`
            );
        }

        let predType: Type;
        if (this.pred instanceof Variable) {
            const { result, error } = findCaller(this, ancestors, this.pred.name, [iterInnerType]);
            if (error !== null) {
                throw this.error(error);
            }
            this.referToPredByName = result.referToByName;
            predType = result.callerType;
        } else {
            this.pred.cascadeTypes(ancestors);
            if (this.pred.type === null) {
                throw this.error("unable to resolve type of predicate");
            }
            predType = this.pred.type;
        }
        if (predType instanceof FuncType) {
            if (predType.paramTypes.length !== 1) {
                throw this.error("takeWhile predicate must take exactly one argument");
            }
            if (predType.returnType !== "Bool") {
                throw this.error("takeWhile predicate must return a boolean");
            }
            if (!typeEquals(predType.paramTypes[0], iterInnerType)) {
                throw this.error(
                    `incompatible types in takeWhile: predicate expects ${predType.paramTypes[0]}, but iterable is over type ${iterInnerType}`
                );
            }
        } else {
            throw this.error(
                `cannot use takeWhile with non-function object (expression of type ${predType})`
            );
        }

        this.type = new IterType(iterInnerType);
    }

    clone(bindings?: Map<string, Type>): Expression {
        const cloned = new TakeWhileIter(
            { line: this.line, col: this.col, text: "takeWhile", type: TokenType.TakeWhile },
            this.pred.clone(bindings),
            this.iter.clone(bindings)
        );
        return cloned;
    }

    toJS(writer: JSWriter): void {
        writer.useBuiltin("__TAKEWHILEITER__");
        writer.write("__TAKEWHILEITER__(");
        // Order: predicate first, iterable second
        if (this.referToPredByName !== null) {
            writer.write(writer.safeName(this.referToPredByName));
        } else {
            this.pred.toJS(writer);
        }
        writer.write(", ");
        if (this.iterIsArray) {
            writer.useBuiltin("__ARRAYITER__");
            writer.write("__ARRAYITER__(");
            this.iter.toJS(writer);
            writer.write(")");
        } else {
            this.iter.toJS(writer);
        }
        writer.write(")");
    }
}

export class DropIter extends Expression {
    count: Expression;
    iter: Expression;
    iterIsArray: boolean = false;

    constructor(startToken: Token, count: Expression, iter: Expression) {
        super(startToken.line, startToken.col);
        this.count = count;
        this.iter = iter;
    }

    cascadeTypes(ancestors: Expression[]): void {
        this.count.cascadeTypes(ancestors);
        if (this.count.type === null) {
            throw this.error("unable to resolve type of count expression");
        }
        if (this.count.type !== "Int") {
            throw this.error("drop count must be an integer");
        }
        this.iter.cascadeTypes(ancestors);
        if (this.iter.type === null) {
            throw this.error("unable to resolve type of iterable expression");
        }
        let innerType: Type;
        if (this.iter.type instanceof ArrayType) {
            innerType = this.iter.type.innerType;
            this.iterIsArray = true;
        } else if (this.iter.type instanceof IterType) {
            innerType = this.iter.type.innerType;
        } else {
            throw this.error(
                `cannot drop from non-iterable object (expression of type ${this.iter.type})`
            );
        }
        this.type = new IterType(innerType);
    }

    clone(bindings?: Map<string, Type>): Expression {
        const cloned = new DropIter(
            { line: this.line, col: this.col, text: "drop", type: TokenType.Drop },
            this.count.clone(bindings),
            this.iter.clone(bindings)
        );
        return cloned;
    }

    toJS(writer: JSWriter): void {
        writer.useBuiltin("__DROPITER__");
        writer.write("__DROPITER__(");
        this.count.toJS(writer);
        writer.write(", ");
        if (this.iterIsArray) {
            writer.useBuiltin("__ARRAYITER__");
            writer.write("__ARRAYITER__(");
            this.iter.toJS(writer);
            writer.write(")");
        } else {
            this.iter.toJS(writer);
        }
        writer.write(")");
    }
}

export class DropWhileIter extends Expression {
    pred: Expression;
    iter: Expression;
    iterIsArray: boolean = false;
    referToPredByName: string | null = null;

    constructor(startToken: Token, pred: Expression, iter: Expression) {
        super(startToken.line, startToken.col);
        this.pred = pred;
        this.iter = iter;
    }

    cascadeTypes(ancestors: Expression[]): void {
        this.iter.cascadeTypes(ancestors);
        if (this.iter.type === null) {
            throw this.error("unable to resolve type of iterable expression");
        }
        let iterInnerType: Type;
        if (this.iter.type instanceof ArrayType) {
            iterInnerType = this.iter.type.innerType;
            this.iterIsArray = true;
        } else if (this.iter.type instanceof IterType) {
            iterInnerType = this.iter.type.innerType;
        } else {
            throw this.error(
                `cannot use dropWhile on non-iterable object (expression of type ${this.iter.type})`
            );
        }

        let predType: Type;
        if (this.pred instanceof Variable) {
            const { result, error } = findCaller(this, ancestors, this.pred.name, [iterInnerType]);
            if (error !== null) {
                throw this.error(error);
            }
            this.referToPredByName = result.referToByName;
            predType = result.callerType;
        } else {
            this.pred.cascadeTypes(ancestors);
            if (this.pred.type === null) {
                throw this.error("unable to resolve type of predicate");
            }
            predType = this.pred.type;
        }
        if (predType instanceof FuncType) {
            if (predType.paramTypes.length !== 1) {
                throw this.error("dropWhile predicate must take exactly one argument");
            }
            if (predType.returnType !== "Bool") {
                throw this.error("dropWhile predicate must return a boolean");
            }
            if (!typeEquals(predType.paramTypes[0], iterInnerType)) {
                throw this.error(
                    `incompatible types in dropWhile: predicate expects ${predType.paramTypes[0]}, but iterable is over type ${iterInnerType}`
                );
            }
        } else {
            throw this.error(
                `cannot use dropWhile with non-function object (expression of type ${predType})`
            );
        }

        this.type = new IterType(iterInnerType);
    }

    clone(bindings?: Map<string, Type>): Expression {
        const cloned = new DropWhileIter(
            { line: this.line, col: this.col, text: "dropWhile", type: TokenType.DropWhile },
            this.pred.clone(bindings),
            this.iter.clone(bindings)
        );
        return cloned;
    }

    toJS(writer: JSWriter): void {
        writer.useBuiltin("__DROPWHILEITER__");
        writer.write("__DROPWHILEITER__(");
        // Order: predicate first, iterable second
        if (this.referToPredByName !== null) {
            writer.write(writer.safeName(this.referToPredByName));
        } else {
            this.pred.toJS(writer);
        }
        writer.write(", ");
        if (this.iterIsArray) {
            writer.useBuiltin("__ARRAYITER__");
            writer.write("__ARRAYITER__(");
            this.iter.toJS(writer);
            writer.write(")");
        } else {
            this.iter.toJS(writer);
        }
        writer.write(")");
    }
}

export class IterateIter extends Expression {
    fn: Expression;
    start: Expression;
    referToFnByName: string | null = null;

    constructor(startToken: Token, fn: Expression, start: Expression) {
        super(startToken.line, startToken.col);
        this.fn = fn;
        this.start = start;
    }

    cascadeTypes(ancestors: Expression[]): void {
        this.start.cascadeTypes(ancestors);
        if (this.start.type === null) {
            throw this.error("unable to resolve type of start value");
        }
        const startType = this.start.type;

        let fnType: Type;
        if (this.fn instanceof Variable) {
            const { result, error } = findCaller(this, ancestors, this.fn.name, [startType]);
            if (error !== null) {
                throw this.error(error);
            }
            this.referToFnByName = result.referToByName;
            fnType = result.callerType;
        } else {
            this.fn.cascadeTypes(ancestors);
            if (this.fn.type === null) {
                throw this.error("unable to resolve type of iterate function");
            }
            fnType = this.fn.type;
        }
        if (fnType instanceof FuncType) {
            if (fnType.paramTypes.length !== 1) {
                throw this.error("iterate function must take exactly one argument");
            }
            if (!typeEquals(fnType.paramTypes[0], startType)) {
                throw this.error(
                    `incompatible types in iterate: function expects ${fnType.paramTypes[0]}, but start value is ${startType}`
                );
            }
            if (!typeEquals(fnType.returnType, startType)) {
                if (isConcreteType(fnType.returnType) && isConcreteType(startType)) {
                    throw this.error(
                        `iterate function must return the same type as its argument, got ${fnType.returnType} vs ${startType}`
                    );
                }
            }
        } else {
            throw this.error(
                `cannot use iterate with non-function object (expression of type ${fnType})`
            );
        }

        this.type = new IterType(startType);
    }

    clone(bindings?: Map<string, Type>): Expression {
        const cloned = new IterateIter(
            { line: this.line, col: this.col, text: "iterate", type: TokenType.Iterate },
            this.fn.clone(bindings),
            this.start.clone(bindings)
        );
        return cloned;
    }

    toJS(writer: JSWriter): void {
        writer.useBuiltin("__ITERATEITER__");
        writer.write("__ITERATEITER__(");
        if (this.referToFnByName !== null) {
            writer.write(writer.safeName(this.referToFnByName));
        } else {
            this.fn.toJS(writer);
        }
        writer.write(", ");
        this.start.toJS(writer);
        writer.write(")");
    }
}

export class Last extends Expression {
    iter: Expression;
    iterIsArray: boolean = false;

    constructor(startToken: Token, iter: Expression) {
        super(startToken.line, startToken.col);
        this.iter = iter;
    }

    cascadeTypes(ancestors: Expression[]): void {
        this.iter.cascadeTypes(ancestors);
        if (this.iter.type === null) {
            throw this.error("unable to resolve type of iterable expression");
        }
        let innerType: Type;
        if (this.iter.type instanceof ArrayType) {
            innerType = this.iter.type.innerType;
            this.iterIsArray = true;
        } else if (this.iter.type instanceof IterType) {
            innerType = this.iter.type.innerType;
        } else {
            throw this.error(
                `cannot get last element of non-iterable object (expression of type ${this.iter.type})`
            );
        }
        this.type = innerType;
    }

    clone(bindings?: Map<string, Type>): Expression {
        const cloned = new Last(
            { line: this.line, col: this.col, text: "last", type: TokenType.Last },
            this.iter.clone(bindings)
        );
        return cloned;
    }

    toJS(writer: JSWriter): void {
        if (this.iterIsArray) {
            // Direct array access: arr[arr.length - 1]
            this.iter.toJS(writer);
            writer.write("[");
            this.iter.toJS(writer);
            writer.write(".length - 1]");
        } else {
            writer.useBuiltin("__LAST__");
            writer.write("__LAST__(");
            this.iter.toJS(writer);
            writer.write(")");
        }
    }
}

export class Length extends Expression {
    iter: Expression;
    iterIsArray: boolean = false;

    constructor(startToken: Token, iter: Expression) {
        super(startToken.line, startToken.col);
        this.iter = iter;
    }

    cascadeTypes(ancestors: Expression[]): void {
        this.iter.cascadeTypes(ancestors);
        if (this.iter.type === null) {
            throw this.error("unable to resolve type of iterable expression");
        }
        if (this.iter.type instanceof ArrayType) {
            this.iterIsArray = true;
        } else if (!(this.iter.type instanceof IterType)) {
            throw this.error(
                `cannot get length of non-iterable object (expression of type ${this.iter.type})`
            );
        }
        this.type = "Int";
    }

    clone(bindings?: Map<string, Type>): Expression {
        const cloned = new Length(
            { line: this.line, col: this.col, text: "length", type: TokenType.Length },
            this.iter.clone(bindings)
        );
        return cloned;
    }

    toJS(writer: JSWriter): void {
        if (this.iterIsArray) {
            // Direct array length (must return BigInt for type Int)
            writer.write("BigInt(");
            this.iter.toJS(writer);
            writer.write(".length)");
        } else {
            writer.useBuiltin("__LENGTH__");
            writer.write("__LENGTH__(");
            this.iter.toJS(writer);
            writer.write(")");
        }
    }
}

export class FieldAccess extends Expression {
    constructor(
        public obj: Expression,
        public fieldName: string
    ) {
        super(obj.line, obj.col);
    }

    cascadeTypes(ancestors: Expression[]): void {
        this.obj.cascadeTypes([...ancestors, this]);
        if (this.obj.type === null) {
            throw this.error("unable to resolve type of object");
        }
        if (!(this.obj.type instanceof CustomType)) {
            throw this.error(`cannot access field on non-struct type ${this.obj.type}`);
        }
        const structInfo = getStruct(this.obj.type.name);
        if (!structInfo) {
            throw this.error(`type ${this.obj.type.name} is not a struct`);
        }
        const field = structInfo.fields.find((f) => f.name === this.fieldName);
        if (!field) {
            throw this.error(`struct ${structInfo.name} has no field named "${this.fieldName}"`);
        }
        this.type = field.type;
    }

    clone(bindings?: Map<string, Type>): Expression {
        return new FieldAccess(this.obj.clone(bindings), this.fieldName);
    }

    toJS(writer: JSWriter): void {
        writer.write("(");
        this.obj.toJS(writer);
        writer.write(`).${this.fieldName}`);
    }
}

export class StructDef extends Expression {
    name: string;
    fields: { name: string; type: Type }[];

    constructor(rootToken: Token, name: string, fields: { name: string; type: Type }[]) {
        super(rootToken.line, rootToken.col);
        this.name = name;
        this.fields = fields;
        this.type = "Null";

        // Register in global struct registry
        registerStruct(name, fields);
    }

    cascadeTypes(ancestors: Expression[]): void {
        // Nothing to cascade — struct definition just registers its type
    }

    clone(bindings?: Map<string, Type>): Expression {
        return this; // Struct definitions are immutable, safe to share
    }

    toJS(writer: JSWriter): void {
        // Struct definitions are for type-checking only; not emitted to JS
    }
}

export class Trait extends Expression {
    name: string;
    requiredFunctions: { name: string; paramNames: string[]; types: TemplateTypes }[];

    constructor(
        rootToken: Token,
        name: string,
        requiredFunctions: { name: string; paramNames: string[]; types: TemplateTypes }[]
    ) {
        super(rootToken.line, rootToken.col);
        this.name = name;
        this.requiredFunctions = requiredFunctions;

        // Check that requiredFunctions all have return types
        for (const { name, types } of requiredFunctions) {
            if (types.returnType === null) {
                throw new Error(`function ${name} for trait ${this.name} must have a return type`);
            }
        }

        // Check that Self appears in at least one argument of each required function
        for (const { name, types } of requiredFunctions) {
            const hasSelf = types.types.some(
                (t) => t === "Self" || (t instanceof CustomType && t.name === "Self")
            );
            if (!hasSelf) {
                throw new Error(
                    `function ${name} for trait ${this.name} must include Self in at least one parameter type`
                );
            }
        }

        this.type = "Null";

        // Register trait globally
        registerTrait(name, requiredFunctions);
    }

    getMatchingFunction(
        selfType: Type,
        argTypes: Type[]
    ): { name: string; paramNames: string[]; returnType: Type } | null {
        for (const { name, paramNames, types } of this.requiredFunctions) {
            if (types.returnType === null) {
                continue;
            }
            const paramTypesReplaced = types.types.map((t) => {
                if (t instanceof CustomType && t.name === "Self") {
                    return selfType;
                } else {
                    return t;
                }
            });
            if (paramTypesMatchArgTypes(paramTypesReplaced, argTypes)) {
                return { name, paramNames, returnType: types.returnType };
            }
        }
        return null;
    }

    cascadeTypes(ancestors: Expression[]): void {
        // Nothing to do here
    }

    clone(bindings?: Map<string, Type>): Expression {
        return this; // Traits are immutable, safe to share
    }

    toJS(writer: JSWriter): void {
        // Nothing to do here, either.
        // Traits are solely for the sake of type checking and aren't converted to JS.
    }
}
