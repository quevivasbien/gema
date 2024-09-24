import * as AST from "./ast";
import { TokenType, type Token } from "./tokens";

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
    const condition = parser.expression();
    if (condition === null) {
        return parser.error("Expected expression after if.");
    }
    const thenBranch = parser.expression();
    if (thenBranch === null) {
        return parser.error("Expected expression after if.");
    }
    if (parser.current().type !== TokenType.Else) {
        return new AST.If(condition, thenBranch, null);
    }
    parser.advance();
    const elseBranch = parser.expression();
    if (elseBranch === null) {
        return parser.error("Expected expression after else.");
    }
    return new AST.If(condition, thenBranch, elseBranch);
}

function parseInt(parser: Parser): AST.Expression {
    const token = parser.previous();
    return new AST.Literal(AST.Type.Integer, token.text);
}

function parseFloat(parser: Parser): AST.Expression {
    const token = parser.previous();
    return new AST.Literal(AST.Type.Float, token.text);
}

function parseString(parser: Parser): AST.Expression {
    const token = parser.previous();
    return new AST.Literal(AST.Type.String, token.text.slice(1, -1));
}

function parseBoolean(parser: Parser): AST.Expression {
    const token = parser.previous();
    return new AST.Literal(AST.Type.Boolean, token.text);
}

function parseUnary(parser: Parser): AST.Expression {
    const token = parser.previous();
    const rightExpr = parser.parseWithPrecedence(Precedence.Unary);
    if (rightExpr === null) {
        return parser.error(`Expected expression after ${token.text}.`);
    }
    try {
        return new AST.Unary(rightExpr, token.type);
    } catch (e) {
        if (e instanceof Error) {
            parser.error(e.message);
            return new AST.ErrorExpression(e.message);
        }
        throw e;
    }
}

function parseBinary(parser: Parser, leftExpr: AST.Expression): AST.Expression {
    const token = parser.previous();
    const rule = PARSE_RULES[token.type];
    const precedence = rule.precedence + 1;
    const rightExpr = parser.parseWithPrecedence(precedence);
    if (rightExpr === null) {
        return parser.error(`Expected expression after ${token.text}.`);
    }
    try {
        return new AST.Binary(leftExpr, rightExpr, token.type);
    } catch (e) {
        if (e instanceof Error) {
            parser.error(e.message);
            return new AST.ErrorExpression(e.message);
        }
        throw e;
    }
}

function parseVariable(parser: Parser): AST.Expression {
    const text = parser.previous().text;
    if (parser.atEnd() || parser.current().type !== TokenType.Equal) {
        // Assume variable is already defined
        try {
            return new AST.Variable(text);
        }
        catch (e) {
            if (e instanceof Error) {
                parser.error(e.message);
                return new AST.ErrorExpression(e.message);
            }
            throw e;
        }
    }
    // This is a variable definition
    parser.advance();
    return parser.assignment(text);
}

class Parser {
    tokens: Token[];
    index: number = 0;
    previousIndex: number = 0;
    panicMode: boolean = false;
    errors: string[] = [];

    constructor(tokens: Token[]) {
        this.tokens = tokens;
    }

    current(): Token {
        return this.tokens[this.index];
    }

    previous(): Token {
        return this.tokens[this.previousIndex];
    }

    atEnd(): boolean {
        return this.index >= this.tokens.length;
    }

    advance() {
        this.previousIndex = this.index;
        this.index += 1;
    }
    
    error(message: string): AST.ErrorExpression {
        const errorExpr = new AST.ErrorExpression(message);
        if (this.panicMode) {
            return errorExpr;
        }
        this.panicMode = true;
        const token = this.previous();
        this.errors.push(`On line ${token.line}, column ${token.col}, ${message}`);
        return errorExpr;
    }

    parseWithPrecedence(precedence: Precedence): AST.Expression | null {
        if (this.atEnd()) {
            return null;
        }
        this.advance();
        const prefixRule = PARSE_RULES[this.previous().type].prefix;
        if (!prefixRule) {
            return this.error(`expected start of expression, but got ${this.current().text}`);
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

    assignment(name: string): AST.Expression {
        const value = this.parseWithPrecedence(Precedence.Assignment);
        if (!value) {
            return this.error("Expected expression after =");
        }
        return new AST.Assignment(name, value);
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

        const expressions: AST.Expression[] = [];
        while (!this.atEnd() && this.current().type !== TokenType.RBrace) {
            const expr = this.expression();
            if (expr !== null) {
                expressions.push(expr);
            }
        }
        if (!this.atEnd()) {
            this.index += 1;
        }
        try {
            return new AST.Block(expressions);
        } catch (e) {
            if (e instanceof Error) {
                this.error(e.message);
                return new AST.ErrorExpression(e.message);
            }
            throw e;
        }
    }
}

export function parse(tokens: Token[]): { ast: AST.Expression, errors: string[] } {
    const parser = new Parser(tokens);
    const block = parser.block();
    return { ast: block, errors: parser.errors };
}