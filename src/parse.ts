import * as AST from "./ast";
import { TokenType, type Token } from "./tokens";

interface ParseError {
    line: number,
    col: number,
    message: string,
}

enum Precedence {
    None,
    Assignment,
    Or,
    And,
    Equality,
    Comparison,
    Term,
    Factor,
    Unary,
    Call,
}

interface ParseRule {
    prefix: ((parser: Parser) => AST.Expression) | null,
    infix: ((parser: Parser, leftExpr: AST.Expression) => AST.Expression) | null,
    precedence: Precedence
}

const PARSE_RULES: Record<string, ParseRule> = {};

// Groupings and control flow
PARSE_RULES[TokenType.LParen] = {
    prefix: parseGrouping,
    infix: null,
    precedence: Precedence.Call
};
PARSE_RULES[TokenType.LBrace] = {
    prefix: (parser: Parser) => parser.block(),
    infix: null,
    precedence: Precedence.None
};
PARSE_RULES[TokenType.If] = {
    prefix: parseIfStatement,
    infix: null,
    precedence: Precedence.None
};
PARSE_RULES[TokenType.Func] = {
    prefix: parseFunction,
    infix: null,
    precedence: Precedence.None
};

// AST.Literals
PARSE_RULES[TokenType.Integer] = {
    prefix: parseInt,
    infix: null,
    precedence: Precedence.None
};
PARSE_RULES[TokenType.Float] = {
    prefix: parseFloat,
    infix: null,
    precedence: Precedence.None
};
PARSE_RULES[TokenType.String] = {
    prefix: parseString,
    infix: null,
    precedence: Precedence.None
};
PARSE_RULES[TokenType.True] = {
    prefix: parseBoolean,
    infix: null,
    precedence: Precedence.None
};
PARSE_RULES[TokenType.False] = {
    prefix: parseBoolean,
    infix: null,
    precedence: Precedence.None
};

// Operators
PARSE_RULES[TokenType.Plus] = {
    prefix: null,
    infix: parseBinary,
    precedence: Precedence.Term
};
PARSE_RULES[TokenType.Minus] = {
    prefix: parseUnary,
    infix: parseBinary,
    precedence: Precedence.Term
};
PARSE_RULES[TokenType.Star] = {
    prefix: null,
    infix: parseBinary,
    precedence: Precedence.Factor
};
PARSE_RULES[TokenType.Slash] = {
    prefix: null,
    infix: parseBinary,
    precedence: Precedence.Factor
};
PARSE_RULES[TokenType.Percent] = {
    prefix: null,
    infix: parseBinary,
    precedence: Precedence.Factor
};
PARSE_RULES[TokenType.And] = {
    prefix: null,
    infix: parseBinary,
    precedence: Precedence.And
};
PARSE_RULES[TokenType.Or] = {
    prefix: null,
    infix: parseBinary,
    precedence: Precedence.Or
};
PARSE_RULES[TokenType.EqualEqual] = {
    prefix: null,
    infix: parseBinary,
    precedence: Precedence.Equality
};
PARSE_RULES[TokenType.BangEqual] = {
    prefix: null,
    infix: parseBinary,
    precedence: Precedence.Equality
};
PARSE_RULES[TokenType.Less] = {
    prefix: null,
    infix: parseBinary,
    precedence: Precedence.Comparison
};
PARSE_RULES[TokenType.LessEqual] = {
    prefix: null,
    infix: parseBinary,
    precedence: Precedence.Comparison
};
PARSE_RULES[TokenType.Greater] = {
    prefix: null,
    infix: parseBinary,
    precedence: Precedence.Comparison
};
PARSE_RULES[TokenType.GreaterEqual] = {
    prefix: null,
    infix: parseBinary,
    precedence: Precedence.Comparison
};
PARSE_RULES[TokenType.Identifier] = {
    prefix: parseVariable,
    infix: null,
    precedence: Precedence.None
};

// Define default rules
Object.values(TokenType).forEach(tokenType => {
    if (!PARSE_RULES[tokenType]) {
        PARSE_RULES[tokenType] = {
            prefix: null,
            infix: null,
            precedence: Precedence.None
        }
    }
});

function parseGrouping(parser: Parser): AST.Expression {
    const expr = parser.expression();
    parser.advance();
    if (parser.previous().type !== TokenType.RParen) {
        parser.error("missing closing parenthesis after expression.");
    }
    if (expr === null) {
        return parser.error("expected expression in parentheses.");
    }
    return expr;
}

function parseIfStatement(parser: Parser): AST.Expression {
    const rootToken = parser.previous(); // should be 'if'
    const condition = parser.expression();
    if (condition === null) {
        return parser.error("Expected expression after 'if'");
    }
    if (parser.current().type !== TokenType.LBrace) {
        return parser.error("Expected '{' after if condition.");
    }
    parser.advance();
    const branch = parser.block();
    const conditionalBranches = [{ condition, branch }];
    while (true) {
        if (parser.current()?.type !== TokenType.Else) {
            return parser.error("Expected 'else' or 'else if'");
        }
        parser.advance();
        if (parser.current()?.type === TokenType.If) {
            parser.advance();
        } else {
            break;
        }
        const condition = parser.expression();
        if (condition === null) {
            return parser.error("Expected expression after 'else if'")
        }
        if (parser.atEnd() || parser.current().type !== TokenType.LBrace) {
            return parser.error("Expected '{' after condition");
        }
        parser.advance();
        const branch = parser.block();
        conditionalBranches.push({ condition, branch })
    }
    if (parser.current()?.type !== TokenType.LBrace) {
        return parser.error("Expected '{' after 'else'");
    }
    parser.advance();
    const elseBranch = parser.block();
    return parser.tryCreateASTExpression(() => new AST.If(rootToken, conditionalBranches, elseBranch));
}

function parseFunction(parser: Parser): AST.Expression {
    const rootToken = parser.previous();  // should be 'func'
    if (parser.atEnd() || parser.current().type !== TokenType.Identifier) {
        // TODO: Allow anonymous functions
        return parser.error("Expected function name.");
    }
    const name = parser.current().text;
    parser.advance();
    if (parser.current().type !== TokenType.LParen) {
        return parser.error("Expected '(' after function name.");
    }
    parser.advance();
    const params: { name: string, type: AST.Type }[] = [];
    while (!parser.atEnd() && parser.current().type !== TokenType.RParen) {
        if (parser.current().type !== TokenType.Identifier) {
            return parser.error("Expected parameter name.");
        }
        const paramName = parser.current().text;
        parser.advance();
        if (parser.current().type !== TokenType.Colon) {
            return parser.error("Expected ':' after parameter name.");
        }
        parser.advance();
        const typeName = parser.getTypeName();  
        if (!typeName) {
            return new AST.ErrorExpression(rootToken, "Invalid type annotation.");
        }
        params.push({ name: paramName, type: typeName });
    }

    if (parser.atEnd()) {
        return parser.error("Unterminated function definition.");
    }
    parser.advance();

    if (parser.current().type !== TokenType.Colon) {
        return parser.error("Expected ':' after function parameters.");
    }
    parser.advance();
    const returnType = parser.getTypeName();
    if (!returnType) {
        return new AST.ErrorExpression(rootToken, "Invalid type annotation.");
    }

    if (parser.current().type !== TokenType.LBrace) {
        return parser.error("Expected '{' after function parameters.");
    }
    parser.advance();

    return parser.tryCreateASTExpression(() => new AST.Function(rootToken, name, params, returnType, parser.block()));
}

function parseInt(parser: Parser): AST.Expression {
    const token = parser.previous();
    return new AST.Literal(token, "Int");
}

function parseFloat(parser: Parser): AST.Expression {
    const token = parser.previous();
    return new AST.Literal(token, "Float");
}

function parseString(parser: Parser): AST.Expression {
    const token = parser.previous();
    return new AST.Literal(token, "Str");
}

function parseBoolean(parser: Parser): AST.Expression {
    const token = parser.previous();
    return new AST.Literal(token, "Bool");
}

function parseUnary(parser: Parser): AST.Expression {
    const token = parser.previous();
    const rightExpr = parser.parseWithPrecedence(Precedence.Unary);
    if (rightExpr === null) {
        return parser.error(`Expected expression after ${token.text}.`);
    }
    return parser.tryCreateASTExpression(() => new AST.Unary(token, rightExpr));
}

function parseBinary(parser: Parser, leftExpr: AST.Expression): AST.Expression {
    const token = parser.previous();
    const rule = PARSE_RULES[token.type];
    const precedence = rule.precedence + 1;
    const rightExpr = parser.parseWithPrecedence(precedence);
    if (rightExpr === null) {
        return parser.error(`Expected expression after ${token.text}.`);
    }
    return parser.tryCreateASTExpression(() => new AST.Binary(token, leftExpr, rightExpr));
}

function parseVariable(parser: Parser): AST.Expression {
    if (!parser.atEnd() && parser.current().type === TokenType.LParen) {
        // This is a function call
        return parseFunctionCall(parser);
    }
    if (parser.atEnd() || parser.current().type !== TokenType.Equal) {
        // Assume variable is already defined
        const variableToken = parser.previous();
        // Get template types if there are any attached
        const templateTypes = parser.getTemplateTypes();
        return parser.tryCreateASTExpression(() => new AST.Variable(variableToken, templateTypes));
    }
    return parser.error("variable assignments are not allowed within expressions.");
}

function parseFunctionCall(parser: Parser): AST.Expression {
    const nameToken = parser.previous();
    if (parser.current().type !== TokenType.LParen) {
        return parser.error("Expected '(' after function name.");
    }
    parser.advance();
    const args: AST.Expression[] = [];
    while (!parser.atEnd() && parser.current().type !== TokenType.RParen) {
        const arg = parser.parseWithPrecedence(Precedence.None + 1);
        if (arg === null) {
            return parser.error("Unterminated function call.");
        }
        args.push(arg);
        if (parser.current().type === TokenType.Comma) {
            parser.advance();
        }
    }
    if (parser.atEnd()) {
        return parser.error("Unterminated function call.");
    }
    parser.advance();

    return parser.tryCreateASTExpression(() => new AST.FunctionCall(nameToken, args));
}

class Parser {
    tokens: Token[];
    index: number = 0;
    previousIndex: number = 0;
    panicMode: boolean = false;
    errors: ParseError[] = [];

    constructor(tokens: Token[]) {
        this.tokens = tokens;
    }

    current(): Token {
        return this.tokens[this.index];
    }

    previous(): Token {
        return this.tokens[this.previousIndex];
    }

    peek(offset: number = 1): Token {
        return this.tokens[this.index + offset];
    }

    atEnd(): boolean {
        return this.index >= this.tokens.length;
    }

    advance(offset: number = 1) {
        this.index += offset;
        this.previousIndex = this.index - 1;
    }

    error(message: string, tokenOffset: number = -1): AST.ErrorExpression {
        const token = this.peek(tokenOffset);
        const errorExpr = new AST.ErrorExpression(token, message);
        if (this.panicMode) {
            return errorExpr;
        }
        this.panicMode = true;
        this.errors.push({
            line: token.line,
            col: token.col,
            message,
        });
        return errorExpr;
    }

    tryCreateASTExpression(cFunc: () => AST.Expression): AST.Expression {
        try {
            return cFunc();
        } catch (e) {
            if (e instanceof Error) {
                return this.error(e.message);
            }
            throw e;
        }
    }

    getTemplateTypes(): AST.Type[] {
        if (this.atEnd() || this.current().type !== TokenType.LBracket) {
            return [];
        }
        this.advance();
        const templateTypes: AST.Type[] = [];
        while (!this.atEnd() && this.current().type !== TokenType.RBracket) {
            if (this.current().type !== TokenType.Identifier) {
                throw this.error("Expected type identifier.");
            }
            const typeName = this.current().text;
            this.advance();
            let nestedTemplateTypes = this.getTemplateTypes();
            templateTypes.push(AST.getType(typeName, nestedTemplateTypes));
            if (this.current().type === TokenType.Comma) {
                this.advance();
            }
        }
        if (this.atEnd()) {
            throw this.error("Unterminated type template.");
        }
        this.advance();
        return templateTypes;
    }

    getTypeName(): AST.Type | null {
        if (this.current().type !== TokenType.Identifier) {
            return null;
        }
        const paramType = this.current().text;
        this.advance();
        let templateTypes: AST.Type[] = this.getTemplateTypes();
        if (this.current().type === TokenType.Comma) {
            this.advance();
        }
        try {
            return AST.getType(paramType, templateTypes);
        } catch (e) {
            if (e instanceof Error) {
                this.error(e.message);
                return null;
            }
            throw e;
        }
    }

    parseWithPrecedence(precedence: Precedence): AST.Expression | null {
        if (this.atEnd()) {
            return null;
        }
        this.advance();
        const prefixRule = PARSE_RULES[this.previous().type].prefix;
        if (!prefixRule) {
            return this.error(`expected start of expression, but got ${this.previous().text}`);
        }
        let expr = prefixRule(this);

        while (!this.atEnd() && precedence <= PARSE_RULES[this.current().type].precedence) {
            this.advance();
            const infixRule = PARSE_RULES[this.previous().type].infix;
            if (!infixRule) {
                return this.error(`expected infix operator, but got ${this.previous().text}`);
            }
            expr = infixRule(this, expr);
        }

        return expr;
    }

    assignment(): AST.Expression | null {
        if (this.current().type !== TokenType.Identifier || this.peek()?.type !== TokenType.Equal) {
            return null;
        }
        const variableToken = this.current();
        this.advance(2);
        const value = this.parseWithPrecedence(Precedence.Assignment);
        if (!value) {
            return this.error("Expected expression after =");
        }
        let isDropped = false;
        if (!this.atEnd() && this.current().type === TokenType.Semicolon) {
            this.advance();
            isDropped = true;
        }
        return new AST.Assignment(variableToken, value, isDropped);
    }

    expression(): AST.Expression | null {
        const expr = this.parseWithPrecedence(Precedence.None + 1);
        if (expr !== null && !this.atEnd() && this.current().type === TokenType.Semicolon) {
            this.advance();
            return new AST.DropValue(expr);
        }
        return expr;
    }

    block(): AST.Expression {
        // We've started a new block context, so we can start reporting errors again
        this.panicMode = false;

        const rootToken = this.previous();  // Should be LBrace
        const expressions: AST.Expression[] = [];
        while (!this.atEnd() && this.current().type !== TokenType.RBrace) {
            const assignment = this.assignment();
            if (assignment !== null) {
                expressions.push(assignment);
                continue;
            }
            const expr = this.expression();
            if (expr !== null) {
                expressions.push(expr);
            }
        }
        if (!this.atEnd()) {
            // Consume the closing brace
            this.advance();
        }
        try {
            return new AST.Block(rootToken, expressions);
        } catch (e) {
            if (e instanceof Error) {
                return this.error(e.message);
            }
            throw e;
        }
    }
}

export function parse(tokens: Token[]): { ast: AST.Expression, errors: ParseError[] } {
    const parser = new Parser(tokens);
    const block = parser.block();
    if (parser.errors.length === 0) {
        try {
            block.cascadeTypes([]);
        } catch (e) {
            if (e instanceof AST.ASTError) {
                parser.errors.push({
                    line: e.line,
                    col: e.col,
                    message: "(During type resolution) " + e.message
                });
            } else {
                throw e;
            }
        }
    }
    return { ast: block, errors: parser.errors };
}
