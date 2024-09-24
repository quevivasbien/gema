import type { JSWriter } from "./write-js";
import { TokenType, type Token } from "./tokens";
import { deepEquals } from "bun";  // If using Node.js, replace this with isDeepStrictEqual from "util" library

export class ASTError {
    constructor(public line: number, public col: number, public message: string) {}
}

class FuncType {
    constructor(
        public paramTypes : Type[],
        public returnType: Type
    ) {}

    toString(): string {
        return `Func<${this.paramTypes.join(", ")}, ${this.returnType}>`;
    }
}

export type Type =
    "Int" |
    "Float" |
    "Str" |
    "Bool" |
    "Null" |
    FuncType
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

    constructor(public line: number, public col: number) {}

    error(message: string): ASTError {
        return new ASTError(this.line, this.col, message);
    }

    abstract cascadeLineage(ancestors: Expression[]): void;

    toJS(writer: JSWriter): void {
        throw new Error(`\`toJS\` not implemented for ${this.constructor.name}.`)
    }
}

export class ErrorExpression extends Expression {

    constructor(token: Token, public message: string) {
        super(token.line, token.col);
    }

    cascadeLineage(ancestors: Expression[]): void {
        // noop
    }
}

export class DropValue extends Expression {
    constructor(public child: Expression) {
        super(child.line, child.col);
        this.type = "Null";
    }
    
    cascadeLineage(ancestors: Expression[]): void {
        // Type is already resolved as null, so just pass to children
        this.child.cascadeLineage([...ancestors, this]);
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

    cascadeLineage(ancestors: Expression[]): void {
        for (const expression of this.expressions) {
            expression.cascadeLineage([...ancestors, this]);
        }
        // Resolve type based on last child
        this.type = this.expressions[this.expressions.length - 1].type;
    }

    toJS(writer: JSWriter): void {
        writer.write("(() => {");
        writer.indentIn();
        writer.newLine();
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
        writer.indentOut();
        writer.newLine();
        writer.write("})()");
    }
}

export class Literal extends Expression {
    value: string;

    constructor(token: Token, type: Type) {
        super(token.line, token.col);
        this.value = token.text;
        this.type = type;
    }

    cascadeLineage(ancestors: Expression[]): void {
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

    cascadeLineage(ancestors: Expression[]): void {
        this.child.cascadeLineage([...ancestors, this]);

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
    [TokenType.EqualEqual]: "===",
    [TokenType.BangEqual]: "!==",
    [TokenType.And]: "&&",
    [TokenType.Or]: "||",
};

export class Binary extends Expression {
    operator: TokenType;

    constructor(operatorToken: Token, public left: Expression, public right: Expression) {
        super(operatorToken.line, operatorToken.col);
        this.operator = operatorToken.type;
    }

    cascadeLineage(ancestors: Expression[]): void {
        this.left.cascadeLineage([...ancestors, this]);
        this.right.cascadeLineage([...ancestors, this]);

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
        throw this.error(`cannot use operator ${this.operator} with left operand of type ${ltype} and right operand of type ${rtype}.`);
    }

    toJS(writer: JSWriter): void {
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

    constructor(token: Token) {
        super(token.line, token.col);
        this.name = token.text;
    }

    resolveAssignment(e: Expression): Type | null {
        if (e instanceof Assignment && (e as Assignment).name === this.name) {
            return (e as Assignment).value.type;
        }
        return null;
    }

    cascadeLineage(ancestors: Expression[]): void {
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
                        return;
                    }
                }
            } else if (ancestor instanceof Function) {
                for (const arg of (ancestor as Function).params) {
                    if (arg.name === this.name) {
                        this.type = arg.type;
                        return;
                    }
                }
            }
            lastAncestor = ancestor;
        }
        throw this.error(`unable to resolve type of variable ${this.name}`);
     }

    toJS(writer: JSWriter): void {
        writer.write(this.name);
    }
}

export class Assignment extends Expression {
    name: string;

    constructor(variableToken: Token, public value: Expression, public isDropped: boolean) {
        super(variableToken.line, variableToken.col);
        this.name = variableToken.text;
    }

    cascadeLineage(ancestors: Expression[]): void {
        // Don't include self in children's lineage, to avoid problems with recursive definitions
        this.value.cascadeLineage([...ancestors]);

        this.type = this.isDropped ? "Null" : this.value.type;
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
    condition: Expression;
    thenBranch: Block;
    elseBranch: Block | null;

    constructor(rootToken: Token, condition: Expression, thenBranch: Expression, elseBranch: Expression | null) {
        super(rootToken.line, rootToken.col);
        if (!(thenBranch instanceof Block)) {
            throw new Error("then branch of if statement must be a block");
        }
        if (elseBranch !== null && !(elseBranch instanceof Block)) {
            throw new Error("else branch of if statement must be a block");
        }

        this.condition = condition;
        this.thenBranch = thenBranch;
        this.elseBranch = elseBranch === null ? null : elseBranch;
    }

    cascadeLineage(ancestors: Expression[]): void {
        // Don't include self in children's lineage, since they shouldn't look for variable definitions within their siblings
        this.condition.cascadeLineage(ancestors);

        if (this.condition.type !== "Bool") {
            throw this.error(`if condition must be boolean, but found ${this.condition.type}`);
        }

        this.thenBranch.cascadeLineage(ancestors);
        this.elseBranch?.cascadeLineage(ancestors);

        if (this.elseBranch === null) {
            if (this.thenBranch.type !== "Null") {
                throw this.error(`the block of an if statement with no else branch must have type Null, but got type ${this.thenBranch.type}. Hint: try adding a semicolon to the last expression in the block.`);
            }
            this.type = "Null";
            return;
        }
        if (!deepEquals(this.elseBranch.type, this.thenBranch.type)) {
            throw this.error(`then and else branches must have the same type, but found ${this.thenBranch.type} and ${this.elseBranch.type}`);
        }
        this.type = this.elseBranch.type;
        return;
    }

    toJS(writer: JSWriter): void {
        if (this.elseBranch === null) {
            writer.write("(() => {");
            writer.indentIn();
            writer.newLine();
            writer.write("if (");
            this.condition.toJS(writer);
            writer.write(") {");
            writer.indentIn();
            this.thenBranch.expressions.forEach(expr => {
                writer.newLine();
                expr.toJS(writer); 
            });
            writer.indentOut();
            writer.newLine();
            writer.write("}");
            writer.newLine();
            writer.write("return null;");
            writer.indentOut();
            writer.newLine();
            writer.write("})()");
            return;
        }

        writer.write("(() => {");
        writer.indentIn();
        writer.newLine();
        writer.write("if (");
        this.condition.toJS(writer);
        writer.write(") {");
        writer.indentIn();
        this.thenBranch.expressions.forEach((expr, i) => {
            writer.newLine();
            if (i === this.thenBranch.expressions.length - 1) {
                writer.write("return ");
            }
            expr.toJS(writer);
            writer.write(";");
        });
        writer.indentOut();
        writer.newLine();
        writer.write("} else {");
        writer.indentIn();
        this.elseBranch.expressions.forEach((expr, i) => {
            writer.newLine();
            if (i === this.elseBranch!.expressions.length - 1) {
                writer.write("return ");
            }
            expr.toJS(writer);
            writer.write(";");
        });
        writer.indentOut();
        writer.newLine();
        writer.write("}");
        writer.indentOut();
        writer.newLine();
        writer.write("})()");
    }
}

export class Function extends Expression {
    name: string;
    params: { name: string, type: Type }[];
    returnType: Type;
    body: Block;

    constructor(rootToken: Token, name: string, params: { name: string, type: Type }[], returnType: Type, body: Expression) {
        if (!(body instanceof Block)) {
            throw new Error("function body must be a Block expression");
        }
        super(rootToken.line, rootToken.col);
        this.name = name;
        this.params = params;
        this.returnType = returnType;
        this.body = body;

        this.type = new FuncType(
            params.map(arg => arg.type),
            returnType
        );
    }

    cascadeLineage(ancestors: Expression[]): void {
        this.body.cascadeLineage([...ancestors, this]);

        if (!deepEquals(this.body.type, this.returnType)) {
            throw this.error(`function body should return ${this.returnType}, but found ${this.body.type}`);
        }
    }

    toJS(writer: JSWriter): void {
        const fullName = this.fullName();
        try {
            writer.beginFunction(fullName);
        } catch (e) {
            if (e instanceof Error) {
                throw this.error(e.message);
            }
            throw e;
        }
        writer.write(`function ${fullName}(`);
        writer.write(this.params.map(p => p.name).join(", "));
        writer.write(") {");
        writer.indentIn();
        this.body.expressions.slice(0, -1).forEach(expr => {
            writer.newLine();
            expr.toJS(writer);
        });
        const lastExpr = this.body.expressions[this.body.expressions.length - 1];
        writer.newLine();
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
        writer.indentOut();
        writer.newLine();
        writer.write("}");
        writer.endFunction();
    }

    fullName(): string {
        return `${this.name}$${this.params.map(arg => arg.type).join("$")}`.replaceAll(" ", "").replaceAll(/[^0-9a-zA-Z_$]/g, "_");
    }
}
