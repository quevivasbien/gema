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
    infix: parseDirectCall,
    precedence: Precedence.Call
};
PARSE_RULES[TokenType.LBrace] = {
    prefix: (parser: Parser) => parser.block(),
    infix: null,
    precedence: Precedence.None
};
PARSE_RULES[TokenType.LBracket] = {
    prefix: parseArray,
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
PARSE_RULES[TokenType.Trait] = {
    prefix: parseTrait,
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

// Functional ops
PARSE_RULES[TokenType.At] = {
    prefix: parseUnary,
    infix: null,
    precedence: Precedence.Unary
};
PARSE_RULES[TokenType.Range] = {
    prefix: parseRange,
    infix: null,
    precedence: Precedence.None
};
PARSE_RULES[TokenType.Map] = {
    prefix: parseMap,
    infix: null,
    precedence: Precedence.None
};
PARSE_RULES[TokenType.Reduce] = {
    prefix: parseReduce,
    infix: null,
    precedence: Precedence.None
};
PARSE_RULES[TokenType.Filter] = {
    prefix: parseFilter,
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
    if (parser.atEnd()) {
        // TODO: Allow anonymous functions
        return parser.error("Expected function name.");
    }
    let name: string | null = null;
    if (parser.current().type === TokenType.Identifier) {
        name = parser.current().text;
        parser.advance();
        if (parser.current().type !== TokenType.LParen) {
            return parser.error("Expected '(' after function name.");
        }
    } else {
        if (parser.current().type !== TokenType.LParen) {
            return parser.error("Expected function name or anonymous function arguments.");
        }
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

    if (parser.atEnd()) {
        return parser.error("Unterminated function definition.");
    }
    let typeTraits;
    try {
        typeTraits = parser.getTypeTraits();
    } catch (e) {
        if (e instanceof Error) {
            return parser.error(e.message);
        }
        throw e;
    }

    if (parser.atEnd()) {
        return parser.error("Unterminated function definition.");
    }
    if (parser.current().type !== TokenType.LBrace) {
        return parser.error("Expected '{' after function parameters.");
    }
    parser.advance();

    return parser.tryCreateASTExpression(() => new AST.Function(rootToken, name, params, returnType, typeTraits, parser.block()));
}

function parseTrait(parser: Parser): AST.Expression {
    const rootToken = parser.previous(); // should be 'trait'
    if (parser.atEnd()) {
        return parser.error("Expected trait name.");
    }
    const name = parser.current().text;
    parser.advance();
    if (parser.atEnd() || parser.current().type !== TokenType.LBrace) {
        return parser.error("Expected '{' after trait name.");
    }
    parser.advance();
    const requiredFunctions: { name: string, types: AST.TemplateTypes }[] = [];
    while (!parser.atEnd() && parser.current().type !== TokenType.RBrace) {
        // Expect inputs of form FuncName[ArgType1, ArgType2, ..., ArgTypeN : ReturnType]
        if (parser.current().type !== TokenType.Identifier) {
            return parser.error("Expected function name.");
        }
        const funcName = parser.current().text;
        parser.advance();
        const templateTypes = parser.getTemplateTypes();
        if (templateTypes.empty()) {
            return parser.error("expected function signature after function name.");
        }
        requiredFunctions.push({ name: funcName, types: templateTypes });
        if (!parser.atEnd() && parser.current().type === TokenType.Comma) {
            parser.advance();
        }
    }
    if (parser.atEnd()) {
        return parser.error("Unterminated trait definition.");
    }
    parser.advance();
    try {
        return parser.tryCreateASTExpression(() => new AST.Trait(rootToken, name, requiredFunctions));
    } catch (e) {
        if (e instanceof Error) {
            return parser.error(e.message);
        }
        throw e;
    }
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
        // This is a function (or similar) call
        return parseCall(parser);
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

function parseCall(parser: Parser): AST.Expression {
    const nameToken = parser.previous();
    if (parser.current().type !== TokenType.LParen) {
        return parser.error("Expected '(' after caller name.");
    }
    parser.advance();
    const args: AST.Expression[] = [];
    while (!parser.atEnd() && parser.current().type !== TokenType.RParen) {
        const arg = parser.expression();
        if (arg === null) {
            return parser.error("Unterminated call.");
        }
        args.push(arg);
        if (!parser.atEnd() && parser.current().type === TokenType.Comma) {
            parser.advance();
        }
    }
    if (parser.atEnd()) {
        return parser.error("Unterminated call.");
    }
    parser.advance();

    return parser.tryCreateASTExpression(() => new AST.Call(nameToken, args));
}

function parseDirectCall(parser: Parser, leftExpr: AST.Expression): AST.Expression {
    const args: AST.Expression[] = [];
    while (!parser.atEnd() && parser.current().type !== TokenType.RParen) {
        const arg = parser.expression();
        if (arg === null) {
            return parser.error("Unterminated call.");
        }
        args.push(arg);
        if (parser.current().type === TokenType.Comma) {
            parser.advance();
        }
    }
    if (parser.atEnd()) {
        return parser.error("Unterminated call.");
    }
    parser.advance();

    return parser.tryCreateASTExpression(() => new AST.DirectCall(leftExpr, args));
}

function parseArray(parser: Parser): AST.Expression {
    const startToken = parser.previous();
    const expressions: AST.Expression[] = [];
    while (!parser.atEnd() && parser.current().type !== TokenType.RBracket) {
        const expression = parser.expression();
        if (expression === null) {
            return parser.error("unterminated array.");
        }
        expressions.push(expression);
        if (parser.current().type === TokenType.Comma) {
            parser.advance();
        }
    }
    if (parser.atEnd()) {
        return parser.error("unterminated array.");
    }
    // consume closing bracket
    parser.advance();
    // Process optional type annotation
    let innerTypeAnnotation: AST.Type | undefined = undefined;
    if (!parser.atEnd() && parser.current().type === TokenType.Colon) {
        parser.advance();
        const typeName = parser.getTypeName();
        if (typeName === null) {
            return parser.error("expected type after ':'");
        }
        innerTypeAnnotation = typeName;
    }
    return parser.tryCreateASTExpression(() => new AST.Array(startToken, expressions, innerTypeAnnotation));
}

function parseRange(parser: Parser): AST.Expression {
    const startToken = parser.previous();
    if (!parser.atEnd() && parser.current().type !== TokenType.LParen) {
        return parser.error("Expected '(' after range.");
    }
    if (!parser.atEnd()) {
        parser.advance();
    }
    const start = parser.expression();
    if (start === null) {
        return parser.error("Expected start of range expression.");
    }
    if (!parser.atEnd() && parser.current().type === TokenType.Comma) {
        parser.advance();
    }
    if (parser.atEnd()) {
        return parser.error("Unterminated range expression.");
    }
    const end = parser.expression();
    if (end === null) {
        return parser.error("Expected end of range expression.");
    }
    if (!parser.atEnd() && parser.current().type === TokenType.Comma) {
        parser.advance();
    }
    let step = null;
    if (!parser.atEnd() && parser.current().type !== TokenType.RParen) {
        step = parser.expression();
        if (step === null) {
            return parser.error("Expected step of range expression.");
        }
    }
    if (!parser.atEnd() && parser.current().type === TokenType.Comma) {
        parser.advance();
    }
    if (parser.atEnd() || parser.current().type !== TokenType.RParen) {
        return parser.error("Expected closing ')' for range expression.");
    }
    parser.advance();
    return parser.tryCreateASTExpression(() => new AST.RangeIter(startToken, start, end, step));
}

function parseMap(parser: Parser): AST.Expression {
    const startToken = parser.previous();
    if (!parser.atEnd() && parser.current().type !== TokenType.LParen) {
        return parser.error("Expected '(' after map.");
    }
    if (!parser.atEnd()) {
        parser.advance();
    }
    const mapFn = parser.expression();
    if (mapFn === null) {
        return parser.error("Expected map function.");
    }
    if (!parser.atEnd() && parser.current().type === TokenType.Comma) {
        parser.advance();
    }
    if (parser.atEnd()) {
        return parser.error("Unterminated map expression.");
    }
    const iterOver = parser.expression();
    if (iterOver === null) {
        return parser.error("Expected iterable expression.");
    }
    if (parser.atEnd() || parser.current().type !== TokenType.RParen) {
        return parser.error("Expected closing ')' for map expression.");
    }
    parser.advance();
    return parser.tryCreateASTExpression(() => new AST.MapIter(startToken, mapFn, iterOver));
}

function parseReduce(parser: Parser): AST.Expression {
    const startToken = parser.previous();
    if (!parser.atEnd() && parser.current().type !== TokenType.LParen) {
        return parser.error("Expected '(' after reduce.");
    }
    if (!parser.atEnd()) {
        parser.advance();
    }
    const reduceFn = parser.expression();
    if (reduceFn === null) {
        return parser.error("Expected reduce function.");
    }
    if (!parser.atEnd() && parser.current().type === TokenType.Comma) {
        parser.advance();
    }
    if (parser.atEnd()) {
        return parser.error("Unterminated reduce expression.");
    }
    const iterOver = parser.expression();
    if (iterOver === null) {
        return parser.error("Expected iterable expression.");
    }
    if (!parser.atEnd() && parser.current().type === TokenType.Comma) {
        parser.advance();
    }
    if (parser.atEnd()) {
        return parser.error("Unterminated reduce expression.");
    }
    const initValue = parser.expression();
    if (initValue === null) {
        return parser.error("Expected initial value for reduce expression.");
    }
    if (parser.atEnd() || parser.current().type !== TokenType.RParen) {
        return parser.error("Expected closing ')' for reduce expression.");
    }
    parser.advance();
    return parser.tryCreateASTExpression(() => new AST.Reduce(startToken, reduceFn, iterOver, initValue));
}

function parseFilter(parser: Parser): AST.Expression {
    const startToken = parser.previous();
    if (!parser.atEnd() && parser.current().type !== TokenType.LParen) {
        return parser.error("Expected '(' after filter.");
    }
    if (!parser.atEnd()) {
        parser.advance();
    }
    const filterFn = parser.expression();
    if (filterFn === null) {
        return parser.error("Expected filter function.");
    }
    if (!parser.atEnd() && parser.current().type === TokenType.Comma) {
        parser.advance();
    }
    if (parser.atEnd()) {
        return parser.error("Unterminated filter expression.");
    }
    const iterOver = parser.expression();
    if (iterOver === null) {
        return parser.error("Expected iterable expression.");
    }
    if (parser.atEnd() || parser.current().type !== TokenType.RParen) {
        return parser.error("Expected closing ')' for filter expression.");
    }
    parser.advance();
    return parser.tryCreateASTExpression(() => new AST.FilterIter(startToken, filterFn, iterOver));
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

    getTemplateTypes(): AST.TemplateTypes {
        if (this.atEnd() || this.current().type !== TokenType.LBracket) {
            return new AST.TemplateTypes();
        }
        this.advance();
        const templateTypes = new AST.TemplateTypes();
        while (!this.atEnd() && this.current().type !== TokenType.RBracket) {
            if (this.current().type === TokenType.Colon) {
                // Separating return type for function
                this.advance();
                if (this.current().type !== TokenType.Identifier) {
                    throw this.error("Expected type identifier for function return type.");
                }
                const returnTypeName = this.current().text;
                this.advance();
                const nestedTemplateTypes = this.getTemplateTypes();
                templateTypes.returnType = AST.getType(returnTypeName, nestedTemplateTypes);
                break;
            }
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

    getTypeTraits(): { type: AST.Type, trait: AST.Type }[] {
        if (this.atEnd() || this.current().type !== TokenType.Where) {
            return [];
        }
        this.advance();
        const typeTraits: { type: AST.Type, trait: AST.Type }[] = [];
        while (!this.atEnd() && this.current().type !== TokenType.LBrace) {
            if (this.current().type !== TokenType.Identifier) {
                throw new Error("expected type alias after 'where'");
            }
            let typeName: AST.Type;
            try {
                typeName = AST.getType(this.current().text, new AST.TemplateTypes());
            } catch (e) {
                if (e instanceof Error) {
                    throw new Error(e.message);
                }
                throw e;
            }
            this.advance();
            if (this.atEnd() || this.current().type !== TokenType.Is) {
                throw new Error("expected 'is' after type alias");
            }
            this.advance();
            if (this.atEnd() || this.current().type !== TokenType.Identifier) {
                throw new Error("expected trait name after 'is'");
            }
            let traitName: AST.Type;
            try {
                traitName = AST.getType(this.current().text, new AST.TemplateTypes());
            } catch (e) {
                if (e instanceof Error) {
                    throw new Error(e.message);
                }
                throw e;
            }
            this.advance();
            if (!this.atEnd() && this.current().type === TokenType.Comma) {
                this.advance();
            }
            typeTraits.push({ type: typeName, trait: traitName });
        }
        return typeTraits;
    }

    getTypeName(): AST.Type | null {
        if (this.current().type !== TokenType.Identifier) {
            return null;
        }
        const paramType = this.current().text;
        this.advance();
        let templateTypes = this.getTemplateTypes();
        if (!this.atEnd() && this.current().type === TokenType.Comma) {
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
            const infixRule = PARSE_RULES[this.current().type].infix;
            if (!infixRule) {
                return this.error(`expected infix operator, but got ${this.current().text} -- you may have forgotten a semicolon to terminate the previous expression.`, 0);
            }
            this.advance();
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
        if (expr === null || this.atEnd()) {
            return expr;
        }
        if (this.current().type === TokenType.Semicolon) {
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
                    message: e.message
                });
            } else {
                throw e;
            }
        }
    }
    return { ast: block, errors: parser.errors };
}
