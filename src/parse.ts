import { Binary, Block, DropValue, ErrorExpression, Literal, Type, Unary, type Expression } from "./ast";
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
    prefix: ((parser: Parser) => Expression) | null,
    infix: ((parser: Parser, leftExpr: Expression) => Expression) | null,
    precedence: Precedence
}

const PARSE_RULES: Record<string, ParseRule> = {};
PARSE_RULES[TokenType.LParen] = {
    prefix: parseGrouping,
    infix: null,
    precedence: Precedence.Call
};
PARSE_RULES[TokenType.LBrace] = {
    prefix: (parser: Parser) => parser.block(),
    infix: null,
    precedence: Precedence.None
}

// Literals
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
PARSE_RULES[TokenType.Equal] = {
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

function parseGrouping(parser: Parser): Expression {
    const expr = parser.expression();
    parser.advance();
    if (parser.previous().type !== TokenType.RParen) {
        parser.error("missing closing parenthesis after expression.");
    }
    if (expr === null) {
        parser.error("expected expression in parentheses.");
        return new ErrorExpression("expected expression in parentheses.");
    }
    return expr;
}

function parseInt(parser: Parser): Expression {
    const token = parser.previous();
    return new Literal(Type.Integer, token.text);
}

function parseFloat(parser: Parser): Expression {
    const token = parser.previous();
    return new Literal(Type.Float, token.text);
}

function parseString(parser: Parser): Expression {
    const token = parser.previous();
    return new Literal(Type.String, token.text.slice(1, -1));
}

function parseBoolean(parser: Parser): Expression {
    const token = parser.previous();
    return new Literal(Type.Boolean, token.text);
}

function parseUnary(parser: Parser): Expression {
    const token = parser.previous();
    const rightExpr = parser.parseWithPrecedence(Precedence.Unary);
    if (rightExpr === null) {
        parser.error(`Expected expression after ${token.text}.`);
        return new ErrorExpression(`Expected expression after ${token.text}.`);
    }
    try {
        return new Unary(rightExpr, token.type);
    } catch (e) {
        if (e instanceof Error) {
            parser.error(e.message);
            return new ErrorExpression(e.message);
        }
        throw e;
    }
}

function parseBinary(parser: Parser, leftExpr: Expression): Expression {
    const token = parser.previous();
    const rule = PARSE_RULES[token.type];
    const precedence = rule.precedence + 1;
    const rightExpr = parser.parseWithPrecedence(precedence);
    if (rightExpr === null) {
        parser.error(`Expected expression after ${token.text}.`);
        return new ErrorExpression(`Expected expression after ${token.text}.`);
    }
    try {
        return new Binary(leftExpr, rightExpr, token.type);
    } catch (e) {
        if (e instanceof Error) {
            parser.error(e.message);
            return new ErrorExpression(e.message);
        }
        throw e;
    }
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
    
    error(message: string) {
        if (this.panicMode) {
            return;
        }
        this.panicMode = true;
        const token = this.previous();
        this.errors.push(`On line ${token.line}, column ${token.col}, ${message}`);
    }

    parseWithPrecedence(precedence: Precedence): Expression | null {
        if (this.atEnd()) {
            return null;
        }
        this.advance();
        const prefixRule = PARSE_RULES[this.previous().type].prefix;
        if (!prefixRule) {
            this.error(`expected start of expression, but got ${this.current().text}`);
            return null;
        }
        let expr = prefixRule(this);

        while (!this.atEnd() && precedence <= PARSE_RULES[this.current().type].precedence) {
            this.advance();
            const infixRule = PARSE_RULES[this.previous().type].infix;
            if (!infixRule) {
                this.error(`expected infix operator, but got ${this.previous().text}`);
                return null;
            }
            expr = infixRule(this, expr);
        }

        return expr;
    }

    expression(): Expression | null {
        const expr = this.parseWithPrecedence(Precedence.None + 1);
        if (expr !== null && !this.atEnd() && this.current().type === TokenType.Semicolon) {
            this.advance();
            return new DropValue(expr);
        }
        return expr;
    }

    block(): Expression {
        // We've started a new block context, so we can start reporting errors again
        this.panicMode = false;

        const expressions: Expression[] = [];
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
            return new Block(expressions);
        } catch (e) {
            if (e instanceof Error) {
                this.error(e.message);
                return new ErrorExpression(e.message);
            }
            throw e;
        }
    }
}

export function parse(tokens: Token[]): { ast: Expression, errors: string[] } {
    const parser = new Parser(tokens);
    const block = parser.block();
    return { ast: block, errors: parser.errors };
}