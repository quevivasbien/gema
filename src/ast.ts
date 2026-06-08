import type { JSWriter } from "./write-js";
import { TokenType, type Token } from "./tokens";
import { deepEquals } from "bun";  // If using Node.js, replace this with isDeepStrictEqual from "util" library

export class ASTError {
    constructor(public line: number, public col: number, public message: string) { }
}

// Built-in type names that cannot be used as type parameters or user-defined types
const BUILTIN_TYPE_NAMES = new Set(["Int", "Float", "Str", "Bool", "Null", "Func", "Arr", "Iter", "Self"]);

export function isBuiltinTypeName(name: string): boolean {
    return BUILTIN_TYPE_NAMES.has(name);
}

// Collect all CustomType names from a type tree
export function collectCustomTypeNames(type: Type, names: Set<string>): void {
    if (type instanceof CustomType) {
        names.add(type.name);
    } else if (type instanceof FuncType) {
        type.paramTypes.forEach(pt => collectCustomTypeNames(pt, names));
        collectCustomTypeNames(type.returnType, names);
    } else if (type instanceof ArrayType) {
        collectCustomTypeNames(type.innerType, names);
    } else if (type instanceof IterType) {
        collectCustomTypeNames(type.innerType, names);
    }
}

// Substitute type parameters in a type tree using a binding map
export function substituteTypeParams(type: Type, bindings: Map<string, Type>): Type {
    if (type instanceof CustomType && bindings.has(type.name)) {
        const substituted = bindings.get(type.name)!;
        // Preserve traits from the original type param
        if (substituted instanceof CustomType && type.traits.length > 0) {
            // Don't carry trait constraints onto the concrete type
        }
        return substituted;
    }
    if (type instanceof FuncType) {
        return new FuncType(
            type.paramTypes.map(pt => substituteTypeParams(pt, bindings)),
            substituteTypeParams(type.returnType, bindings)
        );
    }
    if (type instanceof ArrayType) {
        return new ArrayType(substituteTypeParams(type.innerType, bindings));
    }
    if (type instanceof IterType) {
        return new IterType(substituteTypeParams(type.innerType, bindings));
    }
    return type;
}

// Global registry of trait definitions, keyed by trait name
const traitRegistry: Map<string, { name: string, types: TemplateTypes }[]> = new Map();

export function registerTrait(name: string, requiredFunctions: { name: string, types: TemplateTypes }[]): void {
    traitRegistry.set(name, requiredFunctions);
}

export function getTrait(name: string): { name: string, types: TemplateTypes }[] | undefined {
    return traitRegistry.get(name);
}

// Global registry of struct definitions, keyed by struct name
const structRegistry: Map<string, { name: string, fields: { name: string, type: Type }[] }> = new Map();

export function registerStruct(name: string, fields: { name: string, type: Type }[]): void {
    structRegistry.set(name, { name, fields });
}

export function getStruct(name: string): { name: string, fields: { name: string, type: Type }[] } | undefined {
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

class FuncType {
    constructor(
        public paramTypes: Type[],
        public returnType: Type
    ) { }

    toString(): string {
        return `Func[${this.paramTypes.join(", ")}, ${this.returnType}]`;
    }
}

class ArrayType {
    constructor(public innerType: Type) { }

    toString(): string {
        return `Arr[${this.innerType}]`;
    }

    nDims(): number {
        if (!(this.innerType instanceof ArrayType)) {
            return 1;
        }
        return 1 + this.innerType.nDims();
    }

    checkIndicesCompatible(indexTypes: Type[]): string | null {
        if (indexTypes.length !== this.nDims()) {
            return `incompatible number of array indices: expected ${this.nDims()}, got ${indexTypes.length}`;
        }
        if (indexTypes.some(type => type !== "Int")) {
            return `array indices are not of type Int`;
        }

        return null;
    }
}

class IterType {
    constructor(public innerType: Type) { }

    toString(): string {
        return `Iter[${this.innerType}]`;
    }

    checkIndicesCompatible(indexTypes: Type[]): string | null {
        if (indexTypes.length !== 1) {
            return `iter type requires exactly one index, got ${indexTypes.length}`;
        }
        if (indexTypes[0] !== "Int") {
            return `iter index must be of type Int`;
        }
        return null;
    }
}

class CustomType {
    name: string;
    traits: string[];

    constructor(name: string, traits: string[] = []) {
        this.name = name;
        this.traits = traits;
    }

    toString(): string {
        if (this.traits.length === 0) {
            return this.name;
        }
        return `${this.name}[[${this.traits.join(", ")}]]`;
    }

    addTrait(trait: string) {
        this.traits.push(trait);
    }
}

export type Type =
    "Int" |
    "Float" |
    "Str" |
    "Bool" |
    "Null" |
    FuncType |
    ArrayType |
    IterType |
    CustomType |
    "Self"
    ;

type CallableType = FuncType | ArrayType | IterType;

export class TemplateTypes {
    constructor(public types: Type[] = [], public returnType: Type | null = null) { }

    toString(): string {
        return `[${this.types.join(", ")}${this.returnType === null ? "" : ": " + this.returnType}]`;
    }

    push(type: Type) {
        this.types.push(type);
    }

    empty(): boolean {
        return this.types.length === 0 && this.returnType === null;
    }
}

export function getType(typeName: string, templateTypes: TemplateTypes): Type {
    if ([
        "Int",
        "Float",
        "Str",
        "Bool",
        "Null",
        "Self",
    ].includes(typeName)) {
        if (!templateTypes.empty()) {
            throw new Error(`${typeName} cannot have template types`);
        }
        return typeName as Type;
    }
    if (typeName === "Func") {
        if (templateTypes.returnType === null) {
            throw new Error(`Func type requires a return type`);
        }
        return new FuncType(templateTypes.types, templateTypes.returnType);
    }
    if (typeName === "Arr") {
        if (templateTypes.types.length !== 1) {
            throw new Error(`Array type requires a single template type (for the inner type)`);
        }
        if (templateTypes.returnType !== null) {
            throw new Error(`Array type cannot have a return type`);
        }
        return new ArrayType(templateTypes.types[0]);
    }
    if (typeName === "Iter") {
        if (templateTypes.types.length !== 1) {
            throw new Error(`Iter type requires a single template type (for the inner type)`);
        }
        if (templateTypes.returnType !== null) {
            throw new Error(`Iter type cannot have a return type`);
        }
        return new IterType(templateTypes.types[0]);
    }

    return new CustomType(typeName);
}

export abstract class Expression {
    type: Type | null = null;

    constructor(public line: number, public col: number) { }

    error(message: string): ASTError {
        return new ASTError(this.line, this.col, message);
    }

    abstract cascadeTypes(ancestors: Expression[]): void;

    toJS(writer: JSWriter): void {
        throw new Error(`\`toJS\` not implemented for ${this.constructor.name}.`)
    }

    // Deep-clone this expression tree, optionally substituting type parameters
    abstract clone(bindings?: Map<string, Type>): Expression;
}

export class ErrorExpression extends Expression {

    constructor(token: Token, public message: string) {
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
    constructor(rootToken: Token, public expressions: Expression[]) {
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
            this.expressions.map(e => e.clone(bindings))
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
        // Emit monomorphized functions inside the block scope (hoisted by JS)
        const monomorphizedFns = getAllMonomorphized();
        if (monomorphizedFns.size > 0 && writer.monoFunctionsEmitted === false) {
            writer.monoFunctionsEmitted = true;
            for (const [name, fn] of monomorphizedFns) {
                if (!fn.isGeneric) {
                    fn.toJS(writer);
                    writer.write(";");
                    writer.newLine();
                }
            }
        }
        const lastExpr = this.expressions[this.expressions.length - 1];
        if (lastExpr instanceof DropValue || (lastExpr instanceof Assignment && lastExpr.isDropped)) {
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

    constructor(operatorToken: Token, public child: Expression) {
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
        throw this.error(`cannot use token ${this.operator} on expression of type ${this.child.type}.`);
    }

    clone(bindings?: Map<string, Type>): Expression {
        const cloned = new Unary(
            { line: this.line, col: this.col, text: this.operator, type: this.operator as TokenType },
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
        writer.write(`(${this.operator}`);
        this.child.toJS(writer);
        writer.write(")");
    }
}

const OPERATOR_TRANSLATIONS: Record<string, string> = {
    [TokenType.Plus]: "+",
    [TokenType.Minus]: "-",
    [TokenType.Star]: "*",
    [TokenType.Slash]: "/",
    [TokenType.Greater]: ">",
    [TokenType.GreaterEqual]: ">=",
    [TokenType.Less]: "<",
    [TokenType.LessEqual]: "<=",
    [TokenType.EqualEqual]: "==",  // Non-strict equality is fine here since we are stricter about what types can be compared
    [TokenType.BangEqual]: "!=",
    [TokenType.And]: "&&",
    [TokenType.Or]: "||",
};

export class Binary extends Expression {
    operator: TokenType;

    constructor(operatorToken: Token, public left: Expression, public right: Expression) {
        super(operatorToken.line, operatorToken.col);
        this.operator = operatorToken.type;
    }

    cascadeTypes(ancestors: Expression[]): void {
        this.left.cascadeTypes([...ancestors, this]);
        this.right.cascadeTypes([...ancestors, this]);

        const [ltype, rtype] = [this.left.type, this.right.type];

        const NUMERIC_OPS = [
            TokenType.Plus,
            TokenType.Minus,
            TokenType.Star,
            TokenType.Slash,
            TokenType.Percent,
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
                if (
                    rtype === "Int" ||
                    rtype === "Float"
                ) {
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
                if (
                    rtype === "Int" ||
                    rtype === "Float"
                ) {
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
                if (
                    rtype === "Str" &&
                    this.operator === TokenType.Plus
                ) {
                    this.type = "Str";
                    return;
                } else if (
                    rtype === "Str" &&
                    COMPARISON_OPS.includes(this.operator)
                ) {
                    this.type = "Bool";
                    return;
                }
                break;

            case "Bool":
                if (
                    rtype === "Bool" &&
                    BOOLEAN_OPS.includes(this.operator)
                ) {
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

        throw this.error(`cannot use operator ${this.operator} with left operand of type ${ltype} and right operand of type ${rtype}.`);
    }

    clone(bindings?: Map<string, Type>): Expression {
        const cloned = new Binary(
            { line: this.line, col: this.col, text: this.operator, type: this.operator as TokenType },
            this.left.clone(bindings),
            this.right.clone(bindings)
        );
        return cloned;
    }

    toJS(writer: JSWriter): void {
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
            const olderSiblings = ancestor.expressions.slice(0, ancestor.expressions.indexOf(lastAncestor));
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
                const olderSiblings = ancestor.expressions.slice(0, ancestor.expressions.indexOf(lastAncestor));
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
                    if (olderSibling instanceof Function && olderSibling.name === this.name && olderSibling.params.length === 0 && olderSibling.fullName !== null) {
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
                if (ancestor.name === this.name && ancestor.params.length === 0 && ancestor.fullName !== null) {
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
                this.templateTypes.types.map(t => substituteTypeParams(t, bindings)),
                this.templateTypes.returnType !== null ? substituteTypeParams(this.templateTypes.returnType, bindings) : null
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
        writer.write(this.fullName);
    }
}

export class Assignment extends Expression {
    name: string;

    constructor(variableToken: Token, public value: Expression, public isDropped: boolean) {
        super(variableToken.line, variableToken.col);
        this.name = variableToken.text;
    }

    cascadeTypes(ancestors: Expression[]): void {
        this.value.cascadeTypes([...ancestors, this]);

        // // Disallow assignment to non-anonymous function declaration
        // if (this.value.type instanceof FuncType) {
        //     throw this.error("cannot assign a non-anonymous function to a variable");
        // }

        this.type = this.isDropped ? "Null" : this.value.type;

        // Check if this variable has been defined before in the same block, get type of previous definition if so to make sure it matches
        const previousType = (() => {
            for (let i = 0; i < ancestors.length; i++) {
                const ancestor = ancestors[ancestors.length - i - 1];
                if (ancestor instanceof Block) {
                    const olderSiblings = ancestor.expressions.slice(0, ancestor.expressions.indexOf(this));
                    for (let j = 0; j < olderSiblings.length; j++) {
                        const olderSibling = olderSiblings[olderSiblings.length - j - 1];
                        if (olderSibling instanceof Assignment && olderSibling.name === this.name) {
                            return olderSibling.value.type;
                        }
                    }
                    return null;
                } else if (ancestor instanceof Function) {
                    for (const arg of ancestor.params) {
                        if (arg.name === this.name) {
                            return arg.type;
                        }
                    }
                }
            }
            return null;
        })();

        if (previousType !== null && !deepEquals(previousType, this.type)) {
            throw this.error(`tried to reassign variable ${this.name} with type ${this.type} but it was previously defined in the same scope with type ${previousType}`);
        }

    }

    clone(bindings?: Map<string, Type>): Expression {
        const cloned = new Assignment(
            { line: this.line, col: this.col, text: this.name, type: TokenType.Identifier },
            this.value.clone(bindings),
            this.isDropped
        );
        return cloned;
    }

    toJS(writer: JSWriter): void {
        writer.declareVariable(this.name);
        if (this.isDropped) {
            writer.write(`${this.name} = `);
            this.value.toJS(writer);
        } else {
            writer.write(`(() => { ${this.name} = `);
            this.value.toJS(writer);
            writer.write(`; return ${this.name}; })()`);
        }
    }
}

export class If extends Expression {
    conditionalBranches: { condition: Expression, branch: Block }[];
    elseBranch: Block;

    constructor(rootToken: Token, conditionalBranches: { condition: Expression, branch: Expression }[], elseBranch: Expression) {
        super(rootToken.line, rootToken.col);

        conditionalBranches.forEach(({ branch }) => {
            if (!(branch instanceof Block)) {
                throw new Error("branch of if statement must be a block (enclosed by '{' and '}')");
            }
        });
        if (!(elseBranch instanceof Block)) {
            throw new Error("else branch of if statement must be a block");
        }

        this.conditionalBranches = conditionalBranches as { condition: Expression, branch: Block }[];
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
                throw this.error(`all branches of if expression must have the same type, but found branches of types ${branch.type} and ${this.elseBranch.type}`);
            }
        });

        this.type = this.elseBranch.type;
    }

    clone(bindings?: Map<string, Type>): Expression {
        const cloned = new If(
            { line: this.line, col: this.col, text: "if", type: TokenType.If },
            this.conditionalBranches.map(({ condition, branch }) => ({
                condition: condition.clone(bindings),
                branch: branch.clone(bindings)
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
    return `${name}$${paramTypes.join("$")}`.replaceAll(" ", "").replaceAll(/[^0-9a-zA-Z_$]/g, "_");
}

export class AnonymousFunction extends Expression {
    params: { name: string, type: Type }[];
    body: Block;

    constructor(rootToken: Token, params: { name: string, type: Type }[], body: Expression) {
        if (!(body instanceof Block)) {
            throw new Error("function body must be a Blcok expression");
        }
        super(rootToken.line, rootToken.col);
        this.params = params;
        this.body = body;
    }

    cascadeTypes(ancestors: Expression[]): void {
        this.body.cascadeTypes([...ancestors, this]);
        const returnType = this.body.type;
        if (returnType === null) {
            throw this.error(`unable to resolve return type of function.`);
        }
        this.type = new FuncType(this.params.map(p => p.type), returnType);
    }

    clone(bindings?: Map<string, Type>): Expression {
        const cloned = new AnonymousFunction(
            { line: this.line, col: this.col, text: "func", type: TokenType.Func },
            this.params.map(p => ({
                name: p.name,
                type: bindings ? substituteTypeParams(p.type, bindings) : p.type
            })),
            this.body.clone(bindings)
        );
        return cloned;
    }

    toJS(writer: JSWriter): void {
        writer.write(`(`);
        writer.write(this.params.map(p => p.name).join(", "));
        writer.write(") => ")
        writer.beginFunction();
        this.body.expressions.slice(0, -1).forEach(expr => {
            expr.toJS(writer);
            writer.newLine();
        });
        const lastExpr = this.body.expressions[this.body.expressions.length - 1];
        if (lastExpr instanceof DropValue || (lastExpr instanceof Assignment && lastExpr.isDropped)) {
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
    params: { name: string, type: Type }[];
    returnType: Type;
    body: Block;
    fullName: string;
    typeParams: string[] = [];

    constructor(rootToken: Token, name: string, params: { name: string, type: Type }[], returnType: Type, typeTraits: { type: Type, trait: Type }[], body: Expression) {
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
        this.fullName = functionNameWithParamTypes(name as string, params.map(p => p.type));

        typeTraits.forEach(({ type, trait }) => {
            if (!(type instanceof CustomType)) {
                throw new Error(`type alias ${type} overrides a builtin type.`);
            }
            if (!(trait instanceof CustomType)) {
                throw new Error(`${trait} is not a valid trait name.`);
            }
            this.params.forEach(param => {
                if (param.type instanceof CustomType && param.type.name === type.name) {
                    param.type.addTrait(trait.name);
                }
            });
            if (this.returnType instanceof CustomType && this.returnType.name === type.name) {
                this.returnType.addTrait(trait.name);
            }
        });

        // Detect type parameters by scanning the function signature for non-builtin CustomTypes
        // that are NOT known structs or traits (those are concrete types, not type params)
        const foundParams = new Set<string>();
        this.params.forEach(p => collectCustomTypeNames(p.type, foundParams));
        collectCustomTypeNames(returnType, foundParams);
        // Filter out built-in type names and known struct/trait names
        this.typeParams = [...foundParams].filter((n: string) =>
            !isBuiltinTypeName(n) && !getStruct(n) && !getTrait(n)
        );

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
            throw this.error(`function body should return ${this.returnType}, but found ${this.body.type}`);
        }
    }

    getFuncType(): FuncType {
        return new FuncType(this.params.map(p => p.type), this.returnType);
    }

    /**
     * Monomorphize this generic function with concrete type parameters.
     * Creates a cloned function with substituted types, cascadeTypes it, and registers it.
     */
    monomorphize(argTypes: Type[]): { fullName: string, funcType: FuncType, returnType: Type } | null {
        if (!this.isGeneric) return null;
        if (this.params.length !== argTypes.length) return null;

        // Build type bindings from arg types
        // A type param matches if it appears in the param types in the same position as the arg
        const bindings = new Map<string, Type>();
        for (let i = 0; i < this.params.length; i++) {
            const paramType = this.params[i].type;
            if (paramType instanceof CustomType && this.typeParams.includes(paramType.name)) {
                // If this type param is already bound, it must match
                const existing = bindings.get(paramType.name);
                if (existing && !deepEquals(existing, argTypes[i])) {
                    return null; // Type param bound to conflicting types
                }
                bindings.set(paramType.name, argTypes[i]);
            } else if (paramType instanceof CustomType) {
                // Not a type param, must match exactly
                if (!deepEquals(paramType, argTypes[i])) return null;
            } else if (!deepEquals(paramType, argTypes[i])) {
                // Param has a concrete type that must match
                return null;
            }
        }

        // All type params must be bound
        for (const tp of this.typeParams) {
            if (!bindings.has(tp)) return null;
        }

        // Compute the mangled name for the monomorphized version
        const concreteParamTypes = this.params.map(p => substituteTypeParams(p.type, bindings));
        const concreteReturnType = substituteTypeParams(this.returnType, bindings);
        const monomorphizedFullName = functionNameWithParamTypes(this.name!, concreteParamTypes);

        // Check cache first
        const cached = getMonomorphized(monomorphizedFullName);
        if (cached) {
            return {
                fullName: monomorphizedFullName,
                funcType: cached.getFuncType(),
                returnType: concreteReturnType
            };
        }

        // Check trait constraints
        for (const param of this.params) {
            if (param.type instanceof CustomType && param.type.traits.length > 0) {
                const concreteType = substituteTypeParams(param.type, bindings);
                for (const traitName of param.type.traits) {
                    if (!checkTraitSatisfied(concreteType, traitName, this.name!)) {
                        return null; // Trait not satisfied
                    }
                }
            }
        }

        // Clone the function body with type substitution
        const clonedBody = this.body.clone(bindings) as Block;

        // Create a new assignment-like expression to hold the monomorphized version
        const clonedParams = this.params.map(p => ({
            name: p.name,
            type: substituteTypeParams(p.type, bindings)
        }));

        // Create a monomorphized function with concrete types
        const monomorphized = new Function(
            { line: this.line, col: this.col, text: this.name!, type: TokenType.Func },
            this.name!,
            clonedParams,
            concreteReturnType as Type,
            [],
            clonedBody
        );

        // cascadeTypes the monomorphized version with itself as ancestor (so Variable nodes can find params)
        monomorphized.body.cascadeTypes([monomorphized]);

        // Verify return type matches
        if (!deepEquals(monomorphized.body.type, concreteReturnType)) {
            throw new ASTError(this.line, this.col,
                `monomorphized function body should return ${concreteReturnType}, but found ${monomorphized.body.type}`);
        }

        // Register in cache
        registerMonomorphized(monomorphizedFullName, monomorphized);

        return {
            fullName: monomorphizedFullName,
            funcType: monomorphized.getFuncType(),
            returnType: concreteReturnType
        };
    }

    clone(bindings?: Map<string, Type>): Expression {
        const clonedParams = this.params.map(p => ({
            name: p.name,
            type: bindings ? substituteTypeParams(p.type, bindings) : p.type
        }));
        const clonedReturnType = bindings ? substituteTypeParams(this.returnType, bindings) : this.returnType;
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
            // Generic template functions are not emitted directly — only monomorphized versions are
            return;
        }
        writer.write(`function ${this.fullName}(`);
        writer.write(this.params.map(p => p.name).join(", "));
        writer.write(") ");
        writer.beginFunction();
        this.body.expressions.slice(0, -1).forEach(expr => {
            expr.toJS(writer);
            writer.newLine();
        });
        const lastExpr = this.body.expressions[this.body.expressions.length - 1];
        if (lastExpr instanceof DropValue || (lastExpr instanceof Assignment && lastExpr.isDropped)) {
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
function checkTraitSatisfied(concreteType: Type, traitName: string, contextFnName: string): boolean {
    const traitFuncs = getTrait(traitName);
    if (!traitFuncs) return false;

    for (const { name, types } of traitFuncs) {
        // Replace Self with the concrete type to get the required signature
        const requiredParamTypes = types.types.map(t => {
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
function findStructTypedVariable(root: Expression, ancestors: Expression[], name: string): { varName: string, structType: Type } | null {
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

function getTraitFunc(root: Expression, ancestors: Expression[], name: string, argTypes: Type[]): { referToByName: string, callerType: CallableType, rootType: Type } | null {
    const traits: { selfType: Type, traitName: string }[] = [];
    argTypes.forEach(argType => {
        if (!(argType instanceof CustomType)) {
            return;
        }
        argType.traits.forEach(trait => {
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
        const olderSiblings = ancestor.expressions.slice(0, ancestor.expressions.indexOf(lastAncestor));
        for (let j = olderSiblings.length - 1; j >= 0; j--) {
            const olderSibling = olderSiblings[j];
            if (!(olderSibling instanceof Trait)) {
                continue;
            }
            const matchingTraits = traits.filter(t => t.traitName === olderSibling.name);
            for (const { selfType, traitName } of matchingTraits) {
                const match = olderSibling.getMatchingFunction(selfType, argTypes);
                if (match !== null) {
                    return {
                        referToByName: "I DONT KNOW",
                        callerType: new FuncType(argTypes, match.returnType),  // TODO: Also not sure about this
                        rootType: match.returnType,
                    };
                }
            }
        }
    }

    return null;
}

function paramTypesMatchArgTypes(funcParamTypes: Type[], argTypes: Type[]): boolean {
    return deepEquals(funcParamTypes, argTypes);
}

/**
 * This function takes a root expression (the callable we're trying to resolve) and ancestors,
 * and tries to find a callable with a matching name and type signature.
 * If a matching callable is found, it returns an object with the name to refer to the function by,
 * the type of the function, and the type of the root.
 * If no matching callable is found, it returns an error string.
 */
function findCaller(root: Expression, ancestors: Expression[], name: string, argTypes: Type[]): { error: null, result: { referToByName: string, callerType: CallableType, rootType: Type } } | { error: string, result: null } {
    // Check if name matches a registered struct (constructor call)
    const structDef = getStruct(name);
    if (structDef) {
        const fieldTypes = structDef.fields.map(f => f.type);
        if (!paramTypesMatchArgTypes(fieldTypes, argTypes)) {
            return { error: `struct ${name} constructor expects arguments of types [${fieldTypes}], got [${argTypes}]`, result: null };
        }
        const structType = new CustomType(name);
        return {
            error: null,
            result: {
                referToByName: name,
                callerType: new FuncType(fieldTypes, structType),
                rootType: structType
            }
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
                rootType: foundFn.returnType
            }
        };
    }

    let lastAncestor: Expression = root;
    for (let i = 0; i < ancestors.length; i++) {
        const ancestor = ancestors[ancestors.length - i - 1];
        if (ancestor instanceof Block) {
            const olderSiblings = ancestor.expressions.slice(0, ancestor.expressions.indexOf(lastAncestor));
            for (let j = 0; j < olderSiblings.length; j++) {
                let olderSibling = olderSiblings[olderSiblings.length - j - 1];
                while (olderSibling instanceof DropValue) {
                    olderSibling = olderSibling.child;
                }

                // Direct match with a non-generic function — must match NAME too
                if (olderSibling instanceof Function && !olderSibling.isGeneric && olderSibling.name === name && paramTypesMatchArgTypes(olderSibling.params.map(t => t.type), argTypes)) {
                    return {
                        error: null,
                        result: {
                            referToByName: fullName,
                            callerType: olderSibling.getFuncType(),
                            rootType: olderSibling.returnType
                        }
                    };
                }

                // Generic function matching — attempt monomorphization
                if (olderSibling instanceof Function && olderSibling.isGeneric && olderSibling.params.length === argTypes.length) {
                    // Check if this generic function could match (same name)
                    if (olderSibling.name === name) {
                        const result = olderSibling.monomorphize(argTypes);
                        if (result !== null) {
                            // Monomorphization succeeded — resolve to the concrete function
                            return {
                                error: null,
                                result: {
                                    referToByName: result.fullName,
                                    callerType: result.funcType,
                                    rootType: result.returnType
                                }
                            };
                        }
                    }
                }

                // Variable-based callable (assignment)
                if (olderSibling instanceof Assignment && olderSibling.name === name) {
                    const varType = olderSibling.value.type;
                    if (varType instanceof FuncType) {
                        if (!paramTypesMatchArgTypes(varType.paramTypes, argTypes)) {
                            return { error: `most recent definition of variable ${name} has an incompatible type signature for this function call.`, result: null };
                        }
                        return {
                            error: null,
                            result: {
                                referToByName: name,
                                callerType: varType,
                                rootType: varType.returnType
                            }
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
                                rootType: varType.innerType
                            }
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
                                rootType: varType.innerType
                            }
                        };
                    }
                    // Struct types: fall through — might be struct field access handled by Call.cascadeTypes
                    if (varType instanceof CustomType && getStruct(varType.name)) {
                        break;
                    }
                    return { error: `most recent definition of variable ${name} is of type ${varType}, which is not a callable object.`, result: null };
                }
            }
        } else if (ancestor instanceof Function) {
            // Check both the function params and the function itself (in the case of recursive functions)
            for (const param of ancestor.params) {
                if (param.name === name) {
                    if (param.type instanceof FuncType) {
                        if (!paramTypesMatchArgTypes(param.type.paramTypes, argTypes)) {
                            return { error: `variable ${name} (parameter of function ${ancestor.name}) has an incompatible type signature for this function call.`, result: null };
                        }
                        return {
                            error: null,
                            result: {
                                referToByName: name,
                                callerType: param.type,
                                rootType: param.type.returnType
                            }
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
                                rootType: param.type.innerType
                            }
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
                                rootType: param.type.innerType
                            }
                        };
                    }
                    // Struct types: fall through — might be struct field access handled by Call.cascadeTypes
                    if (param.type instanceof CustomType && getStruct(param.type.name)) {
                        break;
                    }
                    return { error: `variable ${name} (parameter of function ${ancestor.name}) is not a function.`, result: null };
                }
            }
            if (ancestor.fullName === fullName) {
                // Recursive function
                return {
                    error: null,
                    result: {
                        referToByName: fullName,
                        callerType: ancestor.getFuncType(),
                        rootType: ancestor.returnType
                    }
                };
            }
        }
        lastAncestor = ancestor;
    }

    // Trait dispatch: if arg types are CustomTypes with trait bounds and the call name matches a trait method
    const traitCandidates: { traitName: string, selfType: Type }[] = [];
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
            const replacedParamTypes = tf.types.types.map(t => {
                if (t === "Self" || (t instanceof CustomType && t.name === "Self")) return selfType;
                return t;
            });
            if (paramTypesMatchArgTypes(replacedParamTypes, argTypes)) {
                const returnType = tf.types.returnType !== null
                    ? (tf.types.returnType === "Self" || (tf.types.returnType instanceof CustomType && tf.types.returnType.name === "Self") ? selfType : tf.types.returnType)
                    : "Null";
                return {
                    error: null,
                    result: {
                        referToByName: name,
                        callerType: new FuncType(argTypes, returnType),
                        rootType: returnType
                    }
                };
            }
        }
    }

    return { error: `function ${name}[${argTypes.map(t => t.toString()).join(", ")}: unknown] not found`, result: null };
}

export class Call extends Expression {
    name: string;
    args: Expression[];

    callerType?: CallableType;
    referToByName?: string;
    isStructFieldAccess: boolean = false;
    structFieldName: string = "";

    constructor(nameToken: Token, args: Expression[]) {
        if (nameToken.type !== TokenType.Identifier) {
            throw new Error("call name must be an identifier");
        }
        super(nameToken.line, nameToken.col);
        this.name = nameToken.text;
        this.args = args;
    }

    cascadeTypes(ancestors: Expression[]): void {
        const argTypes = this.args.map((arg, i) => {
            arg.cascadeTypes([...ancestors, this]);
            if (arg.type === null) {
                throw this.error(`unable to resolve type of argument ${i + 1} in call`);
            }
            return arg.type;
        });

        // search for the most recent caller definition with matching type, get name we should refer to it by
        // also set type of this to return type of found function
        const { error, result } = findCaller(this, ancestors, this.name, argTypes);
        if (error !== null) {
            // Check if this is a struct field access: varName("fieldName")
            if (argTypes.length === 1 && argTypes[0] === "Str" && this.args[0] instanceof Literal) {
                const fieldName = this.args[0].value.slice(1, -1);
                const structVar = findStructTypedVariable(this, ancestors, this.name);
                if (structVar !== null) {
                    const structInfo = structVar.structType instanceof CustomType ? getStruct(structVar.structType.name) : undefined;
                    if (structInfo) {
                        const field = structInfo.fields.find(f => f.name === fieldName);
                        if (field) {
                            this.type = field.type;
                            this.referToByName = structVar.varName;
                            this.callerType = new FuncType(argTypes, field.type);
                            this.isStructFieldAccess = true;
                            this.structFieldName = fieldName;
                            return;
                        }
                        throw this.error(`struct ${structInfo.name} has no field named "${fieldName}"`);
                    }
                }
            }
            throw this.error(error);
        }
        this.referToByName = result.referToByName;
        this.callerType = result.callerType;
        this.type = result.rootType;
    }

    clone(bindings?: Map<string, Type>): Expression {
        const cloned = new Call(
            { line: this.line, col: this.col, text: this.name, type: TokenType.Identifier },
            this.args.map(a => a.clone(bindings))
        );
        return cloned;
    }

    toJS(writer: JSWriter): void {
        if (this.referToByName === undefined) {
            throw new Error("caller name not resolved");
        }
        // Struct field access: p("x") → p.x
        if (this.isStructFieldAccess) {
            writer.write(this.referToByName!);
            writer.write(`.${this.structFieldName}`);
            return;
        }
        if (this.callerType instanceof FuncType) {
            // Check if this is a struct constructor (call name matches a registered struct name)
            const structInfo = this.type instanceof CustomType ? getStruct(this.type.name) : undefined;
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
                writer.write(this.referToByName);
                writer.write("(");
                this.args.forEach((arg, i) => {
                    if (i > 0) {
                        writer.write(", ");
                    }
                    arg.toJS(writer);
                });
                writer.write(")");
            }
        } else if (this.callerType instanceof IterType) {
            // Iterate up to the desired index and return that element
            writer.useBuiltin("__ITER_GET__");
            writer.write("__ITER_GET__(");
            writer.write(this.referToByName);
            writer.write(", ");
            this.args.forEach((arg, i) => {
                if (i > 0) {
                    writer.write(", ");
                }
                arg.toJS(writer);
            });
            writer.write(")");
        } else if (this.callerType instanceof ArrayType) {
            writer.write(this.referToByName);
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
                    throw this.error(`unable to resolve type of argument ${i + 1} in function call`);
                }
                return arg.type;
            });
            if (!paramTypesMatchArgTypes(this.caller.type.paramTypes, argTypes)) {
                throw this.error(`incompatible argument types in function call: expected ${this.caller.type.paramTypes}, got ${argTypes}`);
            }
            this.type = this.caller.type.returnType;
            return;
        }
        if (this.caller.type instanceof ArrayType) {
            const incompatible = this.caller.type.checkIndicesCompatible(this.args.map(arg => arg.type as Type));
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
            const incompatible = this.caller.type.checkIndicesCompatible(this.args.map(arg => arg.type as Type));
            if (incompatible !== null) {
                throw this.error(incompatible);
            }
            this.type = this.caller.type.innerType;
            return;
        }
        // Struct field access: instance("fieldName")
        if (this.caller.type instanceof CustomType) {
            const structInfo = getStruct(this.caller.type.name);
            if (structInfo) {
                if (this.args.length !== 1) {
                    throw this.error(`struct field access requires exactly one argument (the field name), got ${this.args.length}`);
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
                const cleanFieldName = fieldName.startsWith('"') ? fieldName.slice(1, -1) : fieldName;
                const field = structInfo.fields.find(f => f.name === cleanFieldName);
                if (!field) {
                    throw this.error(`struct ${this.caller.type.name} has no field named "${cleanFieldName}"`);
                }
                this.type = field.type;
                return;
            }
        }
        throw this.error(`cannot call non-callable object (expression of type ${this.caller.type})`);
    }

    clone(bindings?: Map<string, Type>): Expression {
        const cloned = new DirectCall(
            this.caller.clone(bindings),
            this.args.map(a => a.clone(bindings))
        );
        return cloned;
    }

    toJS(writer: JSWriter): void {
        if (this.caller.type instanceof CustomType && getStruct(this.caller.type.name)) {
            // Struct field access: p("x") → p.x
            const fieldName = this.args[0] instanceof Literal
                ? this.args[0].value.slice(1, -1)  // Strip quotes
                : "";
            writer.write("(");
            this.caller.toJS(writer);
            writer.write(`).${fieldName}`);
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
                throw this.error(`incompatible types in array: expected ${this.innerType}, got ${expr.type}`);
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
            this.expressions.map(e => e.clone(bindings)),
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
            throw this.error(`cannot map over non-iterable object (expression of type ${this.iterOver.type})`);
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
            throw this.error(`cannot map with non-callable object (expression of type ${mapFnType})`);
        }

        if (!deepEquals(iterInnerType, inputType)) {
            throw this.error(`incompatible types in map: expected ${inputType}, but iterable is over type ${iterInnerType}`);
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
            writer.write(this.referToMapFnByName);
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
    iterOver: Expression;
    initValue: Expression;

    iterOverIsArray: boolean = false;
    referToReduceFnByName: string | null = null;

    constructor(startToken: Token, reduceFn: Expression, iterOver: Expression, initValue: Expression) {
        super(startToken.line, startToken.col);
        this.reduceFn = reduceFn;
        this.iterOver = iterOver;
        this.initValue = initValue;
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
            throw this.error(`cannot reduce with non-iterable object (expression of type ${this.iterOver.type})`);
        }

        this.initValue.cascadeTypes(ancestors);
        if (this.initValue.type === null) {
            throw this.error("unable to resolve type of initial value");
        }

        // If filterFn is a Variable Expression, it may actually refer to a function, not to an extant variable
        let reduceFnType: Type;
        if (this.reduceFn instanceof Variable) {
            const { result, error } = findCaller(this, ancestors, this.reduceFn.name, [this.initValue.type, iterInnerType]);
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
                throw this.error("reduce function must take exactly two arguments (an accumulator and the current element)");
            }
            accType = reduceFnType.paramTypes[0];
            inputType = reduceFnType.paramTypes[1];
            if (!deepEquals(reduceFnType.returnType, accType)) {
                throw this.error("reduce function must return the same type as its accumulator (first argument)");
            }
        } else {
            throw this.error(`cannot reduce with non-function object (expression of type ${reduceFnType})`);
        }

        if (!deepEquals(iterInnerType, inputType)) {
            throw this.error(`incompatible types in reduce: expected ${inputType}, but iterable is over type ${iterInnerType}`);
        }
        if (!deepEquals(accType, this.initValue.type)) {
            throw this.error(`incompatible types in reduce: expected ${accType}, but initial value is of type ${this.initValue.type}`);
        }

        this.type = accType;
    }

    clone(bindings?: Map<string, Type>): Expression {
        const cloned = new Reduce(
            { line: this.line, col: this.col, text: "reduce", type: TokenType.Reduce },
            this.reduceFn.clone(bindings),
            this.iterOver.clone(bindings),
            this.initValue.clone(bindings)
        );
        return cloned;
    }

    toJS(writer: JSWriter): void {
        writer.useBuiltin("__REDUCE__");
        writer.write("__REDUCE__(");
        if (this.referToReduceFnByName !== null) {
            writer.write(this.referToReduceFnByName);
        } else {
            this.reduceFn.toJS(writer);
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
        writer.write(", ");
        this.initValue.toJS(writer);
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
            throw this.error(`cannot filter non-iterable object (expression of type ${this.iterOver.type})`);
        }

        // If filterFn is a Variable Expression, it may actually refer to a function, not to an extant variable
        let filterFnType: Type;
        if (this.filterFn instanceof Variable) {
            const { result, error } = findCaller(this, ancestors, this.filterFn.name, [iterInnerType]);
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
            throw this.error(`cannot filter with non-function object (expression of type ${filterFnType})`);
        }

        if (!deepEquals(iterInnerType, inputType)) {
            throw this.error(`incompatible types in filter: expected ${inputType}, but iterable is over type ${iterInnerType}`);
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
            writer.write(this.referToFilterFnByName);
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

export class StructDef extends Expression {
    name: string;
    fields: { name: string, type: Type }[];

    constructor(rootToken: Token, name: string, fields: { name: string, type: Type }[]) {
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
    requiredFunctions: { name: string, types: TemplateTypes }[];

    constructor(rootToken: Token, name: string, requiredFunctions: { name: string, types: TemplateTypes }[]) {
        super(rootToken.line, rootToken.col);
        this.name = name;
        this.requiredFunctions = requiredFunctions;

        // Check that requiredFunctions all have return types
        for (const { name, types } of requiredFunctions) {
            if (types.returnType === null) {
                throw new Error(`function ${name} for trait ${this.name} must have a return type`);
            }
        }

        this.type = "Null";

        // Register trait globally
        registerTrait(name, requiredFunctions);
    }

    getMatchingFunction(selfType: Type, argTypes: Type[]): { name: string, returnType: Type } | null {
        for (const { name, types } of this.requiredFunctions) {
            if (types.returnType === null) {
                continue;
            }
            const paramTypesReplaced = types.types.map(t => {
                if (t instanceof CustomType && t.name === "Self") {
                    return selfType;
                } else {
                    return t;
                }
            });
            if (paramTypesMatchArgTypes(paramTypesReplaced, argTypes)) {
                return { name, returnType: types.returnType };
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