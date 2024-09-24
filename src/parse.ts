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
        parser.error("expected expression in parentheses.");
        return new AST.ErrorExpression("expected expression in parentheses.");
    }
    return expr;
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
        parser.error(`Expected expression after ${token.text}.`);
        return new AST.ErrorExpression(`Expected expression after ${token.text}.`);
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
        parser.error(`Expected expression after ${token.text}.`);
        return new AST.ErrorExpression(`Expected expression after ${token.text}.`);
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
    parser.error("Variable assignments are not allowed within expressions.");
    return new AST.ErrorExpression("Variable assignments are not allowed within expressions.");
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

    peek(offset: number = 1): Token | undefined {
        return this.tokens[this.index + offset];
    }

    atEnd(): boolean {
        return this.index >= this.tokens.length;
    }

    advance(offset: number = 1) {
        this.index += offset;
        this.previousIndex = this.index - 1;
    }
    
    error(message: string) {
        if (this.panicMode) {
            return;
        }
        this.panicMode = true;
        const token = this.previous();
        this.errors.push(`On line ${token.line + 1}, column ${token.col + 1}, ${message}`);
    }

    parseWithPrecedence(precedence: Precedence): AST.Expression | null {
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

    assignment(): AST.Expression | null {
        if (this.current().type !== TokenType.Identifier || this.peek()?.type !== TokenType.Equal) {
            return null;
        }
        const varName = this.current().text;
        this.advance(2);
        const value = this.parseWithPrecedence(Precedence.Assignment);
        if (!value) {
            this.error("Expected expression after =");
            return new AST.ErrorExpression("Expected expression after =");
        }
        let isDropped = false;
        if (!this.atEnd() && this.current().type === TokenType.Semicolon) {
            this.advance();
            isDropped = true;
        }
        return new AST.Assignment(varName, value, isDropped);
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
    if (parser.errors.length === 0) {
        block.cascadeLineage([]);
    }
    return { ast: block, errors: parser.errors };
}