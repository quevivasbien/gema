import type { JSWriter } from "./write-js";
import { TokenType, type Token } from "./tokens";
import { deepEquals, write } from "bun";  // If using Node.js, replace this with isDeepStrictEqual from "util" library

export class ASTError {
    constructor(public line: number, public col: number, public message: string) { }
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
        return `Array[${this.innerType}]`;
    }
}

export type Type =
    "Int" |
    "Float" |
    "Str" |
    "Bool" |
    "Null" |
    FuncType |
    ArrayType
    ;

export function getType(typeName: string, templateTypes: Type[]): Type {
    if ([
        "Int",
        "Float",
        "Str",
        "Bool",
        "Null",
    ].includes(typeName)) {
        if (templateTypes.length > 0) {
            throw new Error(`${typeName} cannot have template types`);
        }
        return typeName as Type;
    }
    if (typeName === "Func") {
        if (templateTypes.length === 0) {
            throw new Error(`Func type requires at least one template type (for the return type)`);
        }
        return new FuncType(templateTypes.slice(0, -1), templateTypes[templateTypes.length - 1]);
    }

    throw new Error(`Unknown type: ${typeName}`);
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
}

export class ErrorExpression extends Expression {

    constructor(token: Token, public message: string) {
        super(token.line, token.col);
    }

    cascadeTypes(ancestors: Expression[]): void {
        // noop
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

    toJS(writer: JSWriter): void {
        writer.write("(() => ");
        writer.beginScope();
        for (const expression of this.expressions.slice(0, -1)) {
            expression.toJS(writer);
            writer.write(";");
            writer.newLine();
        }
        const lastExpr = this.expressions[this.expressions.length - 1];
        if (lastExpr instanceof DropValue) {
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
        throw this.error(`cannot use token ${this.operator} on expression of type ${this.child.type}.`);
    }

    toJS(writer: JSWriter): void {
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
        }

        throw this.error(`cannot use operator ${this.operator} with left operand of type ${ltype} and right operand of type ${rtype}.`);
    }

    toJS(writer: JSWriter): void {
        if (this.left.type instanceof ArrayType) {
            this.left.toJS(writer);
            writer.write(".concat(");
            this.right.toJS(writer);
            writer.write(")");
            return;
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
    templateTypes: Type[];

    fullName?: string;

    constructor(token: Token, templateTypes: Type[] = []) {
        super(token.line, token.col);
        this.name = token.text;
        this.templateTypes = templateTypes;
    }

    toString(): string {
        if (this.templateTypes.length > 0) {
            return `${this.name}<${this.templateTypes.join(", ")}>`;
        }
        return this.name;
    }

    setTypeWithTemplateTypes(ancestors: Expression[]): void {
        this.fullName = functionNameWithParamTypes(this.name, this.templateTypes);
        let lastAncestor: Expression = this;
        for (let i = 0; i < ancestors.length; i++) {
            const ancestor = ancestors[ancestors.length - i - 1];
            if (!(ancestor instanceof Block)) {
                continue;
            }
            const olderSiblings = ancestor.expressions.slice(0, ancestor.expressions.indexOf(lastAncestor));
            for (let j = 0; j < olderSiblings.length; j++) {
                const olderSibling = olderSiblings[olderSiblings.length - j - 1];
                if (olderSibling instanceof Function && olderSibling.fullName === this.fullName) {
                    this.type = olderSibling.type;
                    return;
                }
            }
            lastAncestor = ancestor;
        }
        throw this.error(`cannot resolve type of variable ${this}`);
    }

    resolveAssignment(e: Expression): Type | null {
        if (e instanceof Assignment && (e as Assignment).name === this.name) {
            return (e as Assignment).value.type;
        }
        return null;
    }

    cascadeTypes(ancestors: Expression[]): void {
        if (this.templateTypes.length > 0) {
            this.setTypeWithTemplateTypes(ancestors);
            return;
        }
        let lastAncestor: Expression = this;
        for (let i = 0; i < ancestors.length; i++) {
            const ancestor = ancestors[ancestors.length - i - 1];
            if (ancestor instanceof Block) {
                const olderSiblings = ancestor.expressions.slice(0, ancestor.expressions.indexOf(lastAncestor));
                for (let j = 0; j < olderSiblings.length; j++) {
                    const olderSibling = olderSiblings[olderSiblings.length - j - 1];
                    const type = this.resolveAssignment(olderSibling);
                    if (type !== null) {
                        this.type = type;
                        this.fullName = this.name;
                        return;
                    }
                    // This could also refer to a function if the function has no params
                    if (olderSibling instanceof Function && olderSibling.name === this.name && olderSibling.params.length === 0 && olderSibling.fullName !== null) {
                        this.type = olderSibling.type;
                        this.fullName = olderSibling.fullName;
                        return;
                    }
                }
            } else if (ancestor instanceof Function) {
                for (const arg of (ancestor as Function).params) {
                    if (arg.name === this.name) {
                        this.type = arg.type;
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
            }
            lastAncestor = ancestor;
        }
        throw this.error(`unable to resolve type of variable ${this}`);
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

function functionNameWithParamTypes(name: string, paramTypes: Type[]): string {
    return `${name}$${paramTypes.join("$")}`.replaceAll(" ", "").replaceAll(/[^0-9a-zA-Z_$]/g, "_");
}

export class Function extends Expression {
    name: string | null;
    params: { name: string, type: Type }[];
    returnType: Type;
    body: Block;
    fullName: string | null;

    constructor(rootToken: Token, name: string | null, params: { name: string, type: Type }[], returnType: Type, body: Expression) {
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
        this.fullName = this.name !== null ? functionNameWithParamTypes(name as string, params.map(p => p.type)) : null;

        this.type = new FuncType(
            params.map(arg => arg.type),
            returnType
        );
    }

    cascadeTypes(ancestors: Expression[]): void {
        this.body.cascadeTypes([...ancestors, this]);

        if (!deepEquals(this.body.type, this.returnType)) {
            throw this.error(`function body should return ${this.returnType}, but found ${this.body.type}`);
        }
    }

    toJS(writer: JSWriter): void {
        if (this.fullName === undefined) {
            throw new Error("function name not resolved");
        }
        if (this.name !== null) {
            writer.write(`function ${this.fullName}(`);
        } else {
            writer.write(`(`);
        }
        writer.write(this.params.map(p => p.name).join(", "));
        if (this.name !== null) {
            writer.write(") ");
        } else {
            writer.write(") => ")
        }
        try {
            writer.beginFunction(this.fullName);
        } catch (e) {
            if (e instanceof Error) {
                throw this.error(e.message);
            }
            throw e;
        }
        this.body.expressions.slice(0, -1).forEach(expr => {
            expr.toJS(writer);
            writer.newLine();
        });
        const lastExpr = this.body.expressions[this.body.expressions.length - 1];
        if (lastExpr instanceof DropValue) {
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

export class FunctionCall extends Expression {
    name: string;
    args: Expression[];
    fullName?: string;

    referToByName?: "abbr" | "full";

    constructor(nameToken: Token, args: Expression[]) {
        if (nameToken.type !== TokenType.Identifier) {
            throw new Error("function call name must be an identifier");
        }
        super(nameToken.line, nameToken.col);
        this.name = nameToken.text;
        this.args = args;
    }

    cascadeTypes(ancestors: Expression[]): void {
        const argTypes = this.args.map((arg, i) => {
            arg.cascadeTypes([...ancestors, this]);
            if (arg.type === null) {
                throw this.error(`unable to resolve type of argument ${i + 1} in function call`);
            }
            return arg.type;
        });

        this.fullName = functionNameWithParamTypes(this.name, argTypes);

        // search for the most recent function definition with matching type, get name we should refer to it by
        // also set type of this to return type of found function
        this.findFunction(ancestors);
    }

    findFunction(ancestors: Expression[]) {
        if (this.fullName === undefined) {
            throw this.error("function name not resolved");
        }
        // The goal here is to figure out whether we should refer to this function by its name or fullName.
        // We want to find either function definitions with matching type signatures (matching fullName),
        // or variables with just matching names.
        // If we find a variable, we need to check that it's assigned to an appropriate function.
        let lastAncestor: Expression = this;
        for (let i = 0; i < ancestors.length; i++) {
            const ancestor = ancestors[ancestors.length - i - 1];
            if (ancestor instanceof Block) {
                const olderSiblings = ancestor.expressions.slice(0, ancestor.expressions.indexOf(lastAncestor));
                for (let j = 0; j < olderSiblings.length; j++) {
                    let olderSibling = olderSiblings[olderSiblings.length - j - 1];
                    while (olderSibling instanceof DropValue) {
                        olderSibling = olderSibling.child;
                    }
                    if (olderSibling instanceof Function && olderSibling.fullName === this.fullName) {
                        this.referToByName = "full";
                        this.type = olderSibling.returnType;
                        return;
                    } else if (olderSibling instanceof Assignment && olderSibling.name === this.name) {
                        const varType = olderSibling.value.type;
                        if (!(varType instanceof FuncType)) {
                            throw this.error(`most recent definition of variable ${this.name} is not a function.`);
                        }
                        const indirectFuncName = functionNameWithParamTypes(olderSibling.name, varType.paramTypes);
                        if (indirectFuncName !== this.fullName) {
                            throw this.error(`most recent definition of variable ${this.name} has an incompatible type signature for this function call.`);
                        }
                        this.referToByName = "abbr";
                        this.type = varType.returnType;
                        return;
                    }
                }
            } else if (ancestor instanceof Function) {
                // Check both the function params and the function itself (in the case of recursive functions)
                for (const param of ancestor.params) {
                    if (param.name === this.name) {
                        if (!(param.type instanceof FuncType)) {
                            throw this.error(`variable ${this.name} (parameter of function ${ancestor.name}) is not a function.`);
                        }
                        const indirectFuncName = functionNameWithParamTypes(param.name, param.type.paramTypes);
                        if (indirectFuncName !== this.fullName) {
                            throw this.error(`variable ${this.name} (parameter of function ${ancestor.name}) has an incompatible type signature for this function call.`);
                        }
                        this.referToByName = "abbr";
                        this.type = param.type.returnType;
                        return;
                    }
                }
                if (ancestor.fullName === this.fullName) {
                    this.referToByName = "full";
                    this.type = ancestor.returnType;
                    return;
                }
            }
            lastAncestor = ancestor;
        }
        throw this.error(`function ${this.name}<${this.args.map(arg => arg.type?.toString()).join(", ")}, unknown> not found`);
    }

    toJS(writer: JSWriter): void {
        if (this.fullName === undefined || this.referToByName === undefined) {
            throw new Error("function name not resolved");
        }
        const name = this.referToByName === "full" ? this.fullName : this.name;
        writer.write(name);
        writer.write("(");
        this.args.forEach((arg, i) => {
            if (i > 0) {
                writer.write(", ");
            }
            arg.toJS(writer);
        });
        writer.write(")");
    }
}

export class DirectFunctionCall extends Expression {
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
            throw this.error("unable to resolve type of function call");
        }
        if (!(this.caller.type instanceof FuncType)) {
            throw this.error(`cannot call non-function (expression of type ${this.caller.type})`);
        }
        const argTypes = this.args.map((arg, i) => {
            arg.cascadeTypes([...ancestors, this]);
            if (arg.type === null) {
                throw this.error(`unable to resolve type of argument ${i + 1} in function call`);
            }
            return arg.type;
        });
        if (this.caller.type.paramTypes.length !== argTypes.length) {
            throw this.error(`expected ${this.caller.type.paramTypes.length} arguments, got ${argTypes.length}`);
        }
        if (this.caller.type.paramTypes.some((type, i) => type !== argTypes[i])) {
            throw this.error(`incompatible argument types in function call: expected ${this.caller.type.paramTypes}, got ${argTypes}`);
        }
        this.type = this.caller.type.returnType;
    }

    toJS(writer: JSWriter): void {
        writer.write("(");
        this.caller.toJS(writer);
        writer.write(")(");
        this.args.forEach((arg, i) => {
            if (i > 0) {
                writer.write(", ");
            }
            arg.toJS(writer);
        });
        writer.write(")");
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
            } else if (this.innerType !== expr.type) {
                throw this.error(`incompatible types in array: expected ${this.innerType}, got ${expr.type}`);
            }
        });
        if (this.innerType === undefined) {
            throw this.error(`empty array must be annotated with a type`);
        }
        this.type = new ArrayType(this.innerType);
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