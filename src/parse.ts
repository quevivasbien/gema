import * as AST from "./ast/index";
import { type Type, TemplateTypes, getType } from "./ast/types";
import { TokenType, KEYWORDS, type Token } from "./tokens";

interface ParseError {
    line: number;
    col: number;
    message: string;
}

enum Precedence {
    None,
    Assignment,
    Pipe,
    Or,
    And,
    Equality,
    Range,
    Comparison,
    Term,
    Factor,
    Unary,
    Exponent,
    Call,
}

interface ParseRule {
    prefix: ((parser: Parser) => AST.Expression) | null;
    infix: ((parser: Parser, leftExpr: AST.Expression) => AST.Expression) | null;
    precedence: Precedence;
}

const PARSE_RULES: Record<string, ParseRule> = {};

// Groupings and control flow
PARSE_RULES[TokenType.LParen] = {
    prefix: parseGrouping,
    infix: parseDirectCall,
    precedence: Precedence.Call,
};
PARSE_RULES[TokenType.LBrace] = {
    prefix: (parser: Parser) => parser.block(),
    infix: null,
    precedence: Precedence.None,
};
PARSE_RULES[TokenType.LBracket] = {
    prefix: parseArray,
    infix: null,
    precedence: Precedence.None,
};
PARSE_RULES[TokenType.If] = {
    prefix: parseIfStatement,
    infix: null,
    precedence: Precedence.None,
};
PARSE_RULES[TokenType.Func] = {
    prefix: parseAnonymousFunction,
    infix: null,
    precedence: Precedence.None,
};
PARSE_RULES[TokenType.Backslash] = {
    prefix: parseLambda,
    infix: null,
    precedence: Precedence.None,
};
PARSE_RULES[TokenType.Trait] = {
    prefix: parseTrait,
    infix: null,
    precedence: Precedence.None,
};
PARSE_RULES[TokenType.Enum] = {
    prefix: parseEnum,
    infix: null,
    precedence: Precedence.None,
};

// AST.Literals
PARSE_RULES[TokenType.Integer] = {
    prefix: parseInt,
    infix: null,
    precedence: Precedence.None,
};
PARSE_RULES[TokenType.Float] = {
    prefix: parseFloat,
    infix: null,
    precedence: Precedence.None,
};
PARSE_RULES[TokenType.String] = {
    prefix: parseString,
    infix: null,
    precedence: Precedence.None,
};
PARSE_RULES[TokenType.True] = {
    prefix: parseBoolean,
    infix: null,
    precedence: Precedence.None,
};
PARSE_RULES[TokenType.False] = {
    prefix: parseBoolean,
    infix: null,
    precedence: Precedence.None,
};

// Operators
PARSE_RULES[TokenType.Plus] = {
    prefix: null,
    infix: parseBinary,
    precedence: Precedence.Term,
};
PARSE_RULES[TokenType.Minus] = {
    prefix: parseUnary,
    infix: parseBinary,
    precedence: Precedence.Term,
};
PARSE_RULES[TokenType.Star] = {
    prefix: null,
    infix: parseBinary,
    precedence: Precedence.Factor,
};
PARSE_RULES[TokenType.Slash] = {
    prefix: null,
    infix: parseBinary,
    precedence: Precedence.Factor,
};
PARSE_RULES[TokenType.Percent] = {
    prefix: null,
    infix: parseBinary,
    precedence: Precedence.Factor,
};
PARSE_RULES[TokenType.Caret] = {
    prefix: null,
    infix: parseExponentiation,
    precedence: Precedence.Exponent,
};
PARSE_RULES[TokenType.Bang] = {
    prefix: parseUnary,
    infix: parseUnsafeCall,
    precedence: Precedence.Call,
};
PARSE_RULES[TokenType.DotDot] = {
    prefix: parseRangePrefix,
    infix: parseRange,
    precedence: Precedence.Range,
};
PARSE_RULES[TokenType.And] = {
    prefix: null,
    infix: parseBinary,
    precedence: Precedence.And,
};
PARSE_RULES[TokenType.Pipe] = {
    prefix: null,
    infix: parsePipe,
    precedence: Precedence.Pipe,
};
PARSE_RULES[TokenType.Or] = {
    prefix: null,
    infix: parseBinary,
    precedence: Precedence.Or,
};
PARSE_RULES[TokenType.EqualEqual] = {
    prefix: null,
    infix: parseBinary,
    precedence: Precedence.Equality,
};
PARSE_RULES[TokenType.BangEqual] = {
    prefix: null,
    infix: parseBinary,
    precedence: Precedence.Equality,
};
PARSE_RULES[TokenType.Less] = {
    prefix: null,
    infix: parseBinary,
    precedence: Precedence.Comparison,
};
PARSE_RULES[TokenType.LessEqual] = {
    prefix: null,
    infix: parseBinary,
    precedence: Precedence.Comparison,
};
PARSE_RULES[TokenType.Greater] = {
    prefix: null,
    infix: parseBinary,
    precedence: Precedence.Comparison,
};
PARSE_RULES[TokenType.GreaterEqual] = {
    prefix: null,
    infix: parseBinary,
    precedence: Precedence.Comparison,
};
PARSE_RULES[TokenType.Dot] = {
    prefix: null,
    infix: parseFieldAccess,
    precedence: Precedence.Call,
};
PARSE_RULES[TokenType.Identifier] = {
    prefix: parseVariable,
    infix: null,
    precedence: Precedence.None,
};

PARSE_RULES[TokenType.For] = {
    prefix: parseFor,
    infix: null,
    precedence: Precedence.None,
};
PARSE_RULES[TokenType.Break] = {
    prefix: parseBreak,
    infix: null,
    precedence: Precedence.None,
};
PARSE_RULES[TokenType.Continue] = {
    prefix: parseContinue,
    infix: null,
    precedence: Precedence.None,
};
PARSE_RULES[TokenType.Return] = {
    prefix: parseReturn,
    infix: null,
    precedence: Precedence.None,
};
PARSE_RULES[TokenType.None] = {
    prefix: parseNone,
    infix: null,
    precedence: Precedence.None,
};
PARSE_RULES[TokenType.Match] = {
    prefix: parseMatchExpression,
    infix: null,
    precedence: Precedence.None,
};

// Define default rules
Object.values(TokenType).forEach((tokenType) => {
    if (!PARSE_RULES[tokenType]) {
        PARSE_RULES[tokenType] = {
            prefix: null,
            infix: null,
            precedence: Precedence.None,
        };
    }
});

function parseGrouping(parser: Parser): AST.Expression {
    const startToken = parser.previous();
    const first = parser.expression();

    // Check for tuple: (expr, expr, ...)
    if (!parser.atEnd() && parser.current().type === TokenType.Comma) {
        const elements: AST.Expression[] = [];
        if (first === null) {
            return parser.error("expected expression in tuple");
        }
        elements.push(first);
        parser.advance(); // consume comma

        while (!parser.atEnd() && parser.current().type !== TokenType.RParen) {
            const elem = parser.expression();
            if (elem === null) {
                return parser.error("expected expression in tuple");
            }
            elements.push(elem);
            if (!parser.atEnd() && parser.current().type === TokenType.Comma) {
                parser.advance();
            }
        }
        if (parser.atEnd() || parser.current().type !== TokenType.RParen) {
            return parser.error("missing closing parenthesis after tuple");
        }
        parser.advance();
        return parser.tryCreateASTExpression(() => new AST.TupleLit(startToken, elements));
    }

    // Parenthesized assignment: (y = 2)
    if (
        first instanceof AST.Variable &&
        !parser.atEnd() &&
        parser.current().type === TokenType.Equal
    ) {
        parser.advance(); // skip '='
        const rhs = parser.parseWithPrecedence(Precedence.Assignment);
        if (rhs === null) {
            return parser.error("Expected expression after =");
        }
        if (parser.atEnd() || parser.current().type !== TokenType.RParen) {
            return parser.error("missing closing parenthesis after assignment.");
        }
        parser.advance(); // skip ')'
        return parser.tryCreateASTExpression(() => {
            const varToken = {
                line: startToken.line,
                col: startToken.col,
                text: (first as AST.Variable).name,
                type: TokenType.Identifier,
            };
            return new AST.Assignment(varToken, rhs, false, false);
        });
    }

    if (parser.atEnd() || parser.current().type !== TokenType.RParen) {
        parser.error("missing closing parenthesis after expression.");
    }
    parser.advance();
    if (first === null) {
        return parser.error("expected expression in parentheses.");
    }
    return first;
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
    let hasElse = true;
    let elseBranch: AST.Expression | null = null;
    while (true) {
        if (parser.current()?.type !== TokenType.Else) {
            // No else — this is a statement-only if
            hasElse = false;
            break;
        }
        parser.advance();
        if (parser.current()?.type === TokenType.If) {
            parser.advance();
        } else {
            break;
        }
        const condition = parser.expression();
        if (condition === null) {
            return parser.error("Expected expression after 'else if'");
        }
        if (parser.atEnd() || parser.current().type !== TokenType.LBrace) {
            return parser.error("Expected '{' after condition");
        }
        parser.advance();
        const branch = parser.block();
        conditionalBranches.push({ condition, branch });
    }
    if (hasElse && elseBranch === null) {
        if (parser.current()?.type !== TokenType.LBrace) {
            return parser.error("Expected '{' after 'else'");
        }
        parser.advance();
        elseBranch = parser.block();
    } else if (!hasElse) {
        // Dummy else branch — will not be type-checked since hasElse=false
        const nullToken = {
            line: rootToken.line,
            col: rootToken.col,
            text: "null",
            type: TokenType.Integer,
        };
        elseBranch = new AST.Block(
            { line: rootToken.line, col: rootToken.col, text: "{", type: TokenType.LBrace },
            [new AST.Literal(nullToken, "Null")]
        );
    }
    return parser.tryCreateASTExpression(
        () => new AST.If(rootToken, conditionalBranches, elseBranch!, hasElse)
    );
}

function parseAnonymousFunction(parser: Parser): AST.Expression {
    const rootToken = parser.previous(); // should be 'func'
    if (parser.atEnd()) {
        return parser.error("Unterminated function definition.");
    }
    if (parser.current().type !== TokenType.LParen) {
        return parser.error("Expected parameters for anonymous function.", 0);
    }
    parser.advance();
    const params: { name: string; type: Type }[] = [];
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
    parser.advance(); // Advance past closing parenthesis

    // Optional return type annotation
    let returnType: Type | null = null;
    if (!parser.atEnd() && parser.current().type === TokenType.Colon) {
        parser.advance();
        returnType = parser.getTypeName();
        if (!returnType) {
            return parser.error("Invalid return type for anonymous function.");
        }
    }

    if (parser.atEnd()) {
        return parser.error("Unterminated function definition.");
    }
    if (parser.current().type !== TokenType.LBrace) {
        return parser.error("Expected '{' after function parameters.");
    }
    parser.advance();

    return parser.tryCreateASTExpression(
        () => new AST.AnonymousFunction(rootToken, params, parser.block(), returnType)
    );
}

function parseLambda(parser: Parser): AST.Expression {
    const rootToken = parser.previous(); // should be '\'
    const params: { name: string; type: Type }[] = [];

    // Parenthesized params: \(x, y) { body }
    if (!parser.atEnd() && parser.current().type === TokenType.LParen) {
        parser.advance(); // skip '('
        while (!parser.atEnd() && parser.current().type !== TokenType.RParen) {
            if (parser.current().type !== TokenType.Identifier) {
                return parser.error("Expected parameter name after '\\'.");
            }
            const paramName = parser.current().text;
            parser.advance();
            params.push({ name: paramName, type: null as unknown as Type });
            if (!parser.atEnd() && parser.current().type === TokenType.Comma) {
                parser.advance();
            }
        }
        if (parser.atEnd()) {
            return parser.error("Unterminated lambda parameter list.");
        }
        parser.advance(); // skip ')'
    }
    // Single param without parens: \x { body }
    else if (!parser.atEnd() && parser.current().type === TokenType.Identifier) {
        const paramName = parser.current().text;
        parser.advance();
        params.push({ name: paramName, type: null as unknown as Type });
    }
    // Zero params: \ { body }
    // — params stays empty, body parsing follows below

    if (parser.atEnd()) {
        return parser.error("Expected function body after lambda parameters.");
    }
    // Case when curly brace-enclosed block follows
    if (parser.current().type === TokenType.LBrace) {
        parser.advance(); // advance past '{'
        return parser.tryCreateASTExpression(
            () => new AST.AnonymousFunction(rootToken, params, parser.block(), null)
        );
    }
    // Otherwise, assume the following expression is the function body (no braces).
    // Parse at Pipe+1 precedence so | and similar low-precedence operators
    // bind to the outer expression rather than the lambda body.
    const bodyExpr = parser.parseWithPrecedence(Precedence.Pipe + 1);
    if (bodyExpr === null) {
        return parser.error("Expected expression after lambda parameters.");
    }
    const blockToken = {
        line: rootToken.line,
        col: rootToken.col,
        text: "{",
        type: TokenType.LBrace,
    };
    return parser.tryCreateASTExpression(
        () =>
            new AST.AnonymousFunction(
                rootToken,
                params,
                new AST.Block(blockToken, [bodyExpr]),
                null
            )
    );
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
    const requiredFunctions: { name: string; paramNames: string[]; types: TemplateTypes }[] = [];
    while (!parser.atEnd() && parser.current().type !== TokenType.RBrace) {
        // Expect inputs of form:
        //   FuncName[(name: Type, ...): ReturnType]
        //   Self.funcName[(name: Type, ...): ReturnType]  (type-associated function)
        if (parser.current().type !== TokenType.Identifier) {
            return parser.error("Expected function name.");
        }
        let funcName = parser.current().text;
        parser.advance();

        // Detect Self.funcName pattern
        if (
            funcName === "Self" &&
            parser.current().type === TokenType.Dot &&
            parser.peek()?.type === TokenType.Identifier
        ) {
            parser.advance(); // skip '.'
            funcName = "Self." + parser.current().text;
            parser.advance(); // skip funcName
        }

        // Expect '[' after function name
        if (parser.atEnd() || parser.current().type !== TokenType.LBracket) {
            return parser.error("Expected '[' after function name in trait.");
        }
        parser.advance();

        // Expect '(' for parameter list
        if (parser.atEnd() || parser.current().type !== TokenType.LParen) {
            return parser.error("Expected '(' for parameter list in trait function signature.");
        }
        parser.advance();

        // Parse parameter list: name: Type, name: Type, ...
        const paramNames: string[] = [];
        const paramTypes: Type[] = [];
        while (!parser.atEnd() && parser.current().type !== TokenType.RParen) {
            if (parser.current().type !== TokenType.Identifier) {
                return parser.error("Expected parameter name.");
            }
            const paramName = parser.current().text;
            parser.advance();

            if (parser.atEnd() || parser.current().type !== TokenType.Colon) {
                return parser.error("Expected ':' after parameter name.");
            }
            parser.advance();

            const paramType = parser.getTypeName();
            if (!paramType) {
                return parser.error("Invalid type for parameter.");
            }

            paramNames.push(paramName);
            paramTypes.push(paramType);

            if (!parser.atEnd() && parser.current().type === TokenType.Comma) {
                parser.advance();
            }
        }
        if (parser.atEnd()) {
            return parser.error("Unterminated parameter list in trait function signature.");
        }
        parser.advance(); // consume ')'

        // Expect ':'
        if (parser.atEnd() || parser.current().type !== TokenType.Colon) {
            return parser.error("Expected ':' after parameters for return type.");
        }
        parser.advance();

        // Parse return type
        if (parser.atEnd() || parser.current().type !== TokenType.Identifier) {
            return parser.error("Expected return type.");
        }
        const returnTypeName = parser.current().text;
        parser.advance();
        const nestedTemplateTypes = parser.getTemplateTypes();
        const returnType = getType(returnTypeName, nestedTemplateTypes);

        // Expect ']'
        if (parser.atEnd() || parser.current().type !== TokenType.RBracket) {
            return parser.error("Expected ']' to close trait function signature.");
        }
        parser.advance();

        requiredFunctions.push({
            name: funcName,
            paramNames,
            types: new TemplateTypes(paramTypes, returnType),
        });

        if (!parser.atEnd() && parser.current().type === TokenType.Comma) {
            parser.advance();
        }
    }
    if (parser.atEnd()) {
        return parser.error("Unterminated trait definition.");
    }
    parser.advance();
    try {
        return parser.tryCreateASTExpression(
            () => new AST.Trait(rootToken, name, requiredFunctions)
        );
    } catch (e) {
        if (e instanceof Error) {
            return parser.error(e.message);
        }
        throw e;
    }
}

function parseEnum(parser: Parser): AST.Expression {
    const rootToken = parser.previous(); // should be 'enum'
    if (parser.atEnd() || parser.current().type !== TokenType.Identifier) {
        return parser.error("Expected enum name after 'enum'");
    }
    const name = parser.current().text;
    parser.advance(); // consume enum name

    if (parser.atEnd() || parser.current().type !== TokenType.LBrace) {
        return parser.error("Expected '{' after enum name.");
    }
    parser.advance(); // consume '{'

    const variants: { name: string; type: Type | null }[] = [];
    const seenNames = new Set<string>();

    while (!parser.atEnd() && parser.current().type !== TokenType.RBrace) {
        if (parser.current().type !== TokenType.Identifier) {
            return parser.error("Expected variant name.");
        }
        const variantName = parser.current().text;
        if (seenNames.has(variantName)) {
            return parser.error(`Duplicate variant name '${variantName}' in enum ${name}.`);
        }
        seenNames.add(variantName);
        parser.advance(); // consume variant name

        let variantType: Type | null = null;
        // Check for optional type annotation: variant: Type
        if (!parser.atEnd() && parser.current().type === TokenType.Colon) {
            parser.advance(); // consume ':'
            variantType = parser.getTypeName();
            if (!variantType) {
                return parser.error("Invalid type annotation for enum variant.");
            }
        }

        variants.push({ name: variantName, type: variantType });

        if (!parser.atEnd() && parser.current().type === TokenType.Comma) {
            parser.advance();
        }
    }

    if (parser.atEnd()) {
        return parser.error("Unterminated enum definition.");
    }
    parser.advance(); // consume '}'

    return parser.tryCreateASTExpression(() => new AST.EnumDef(rootToken, name, variants));
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

function parseExponentiation(parser: Parser, leftExpr: AST.Expression): AST.Expression {
    const token = parser.previous();
    // Right-associative: use same precedence level for right operand instead of higher
    const rightExpr = parser.parseWithPrecedence(Precedence.Exponent);
    if (rightExpr === null) {
        return parser.error(`Expected expression after ${token.text}.`);
    }
    return parser.tryCreateASTExpression(() => new AST.Binary(token, leftExpr, rightExpr));
}

function parseRange(parser: Parser, leftExpr: AST.Expression): AST.Expression {
    const token = parser.previous(); // '..'
    // Try to parse the end expression (may be absent for infinite range)
    let endExpr: AST.Expression | null = null;
    if (
        !parser.atEnd() &&
        parser.current().type !== TokenType.RParen &&
        parser.current().type !== TokenType.Semicolon &&
        parser.current().type !== TokenType.RBrace &&
        parser.current().type !== TokenType.RBracket &&
        parser.current().type !== TokenType.Comma &&
        parser.current().type !== TokenType.Pipe &&
        parser.current().type !== TokenType.Colon
    ) {
        endExpr = parser.parseWithPrecedence(Precedence.Range + 1);
    }
    return parser.tryCreateASTExpression(() => new AST.RangeIter(token, leftExpr, endExpr, null));
}

function parseRangePrefix(parser: Parser): AST.Expression {
    const token = parser.previous(); // '..'
    // Check for open-ended: just '..' with no following expression
    if (
        parser.atEnd() ||
        parser.current().type === TokenType.RParen ||
        parser.current().type === TokenType.Semicolon ||
        parser.current().type === TokenType.RBrace ||
        parser.current().type === TokenType.RBracket ||
        parser.current().type === TokenType.Comma ||
        parser.current().type === TokenType.Pipe ||
        parser.current().type === TokenType.Colon
    ) {
        // No end expression specified — range from 0 to infinity
        return parser.tryCreateASTExpression(() => new AST.RangeIter(token, null, null, null));
    }
    // Parse the end expression
    const endExpr = parser.parseWithPrecedence(Precedence.Range + 1);
    if (endExpr === null) {
        return parser.error(`Expected expression after '..'.`);
    }
    // Start from 0, go to endExpr
    return parser.tryCreateASTExpression(() => new AST.RangeIter(token, null, endExpr, null));
}

function parsePipe(parser: Parser, leftExpr: AST.Expression): AST.Expression {
    if (parser.atEnd()) {
        return parser.error("Expected function after '|'");
    }
    const tt = parser.current().type;

    // Backslash lambda: 5 | \x { x + 1 }
    if (tt === TokenType.Backslash) {
        parser.advance();
        const lambda = parseLambda(parser);
        return new AST.DirectCall(lambda, [leftExpr]);
    }

    // func anonymous function: 5 | func(x: Int) { x + 1 }
    if (tt === TokenType.Func) {
        parser.advance();
        const anonFn = parseAnonymousFunction(parser);
        return new AST.DirectCall(anonFn, [leftExpr]);
    }

    // Parenthesized expression: 3 | (func(x: Int) { x + 1 })
    if (tt === TokenType.LParen) {
        parser.advance();
        const expr = parser.expression();
        if (expr === null || parser.atEnd() || parser.current().type !== TokenType.RParen) {
            return parser.error("Expected ')' after expression.");
        }
        parser.advance();
        return new AST.DirectCall(expr, [leftExpr]);
    }

    // Existing: identifier or keyword function/builtin name
    if (tt !== TokenType.Identifier && !KEYWORDS.has(tt as string)) {
        return parser.error("Expected function after '|'");
    }
    const nameToken = {
        ...parser.current(),
        type: TokenType.Identifier as TokenType,
    };
    parser.advance();
    // If followed by "(", parse call arguments and append the piped value as last arg
    if (!parser.atEnd() && parser.current().type === TokenType.LParen) {
        parser.advance();
        const args: AST.Expression[] = [];
        const keywordArgs: { name: string; value: AST.Expression }[] = [];
        let seenKeyword = false;
        while (!parser.atEnd() && parser.current().type !== TokenType.RParen) {
            if (
                parser.current().type === TokenType.Identifier &&
                parser.peek()?.type === TokenType.Equal
            ) {
                if (seenKeyword) {
                    return parser.error("Duplicate keyword argument.");
                }
                seenKeyword = true;
                const kwName = parser.current().text;
                parser.advance();
                parser.advance(); // skip '='
                const kwValue = parser.expression();
                if (kwValue === null) {
                    return parser.error("Expected value for keyword argument.");
                }
                keywordArgs.push({ name: kwName, value: kwValue });
            } else {
                if (seenKeyword) {
                    return parser.error("Cannot mix positional and keyword arguments.");
                }
                const arg = parser.expression();
                if (arg === null) {
                    return parser.error("Expected expression.");
                }
                args.push(arg);
            }
            if (parser.atEnd()) {
                return parser.error("Unterminated call.");
            }
            if (parser.current().type === TokenType.Comma) {
                parser.advance();
            }
        }
        if (parser.atEnd()) {
            return parser.error("Unterminated call.");
        }
        parser.advance(); // advance past ')'
        // Append the piped value as the last argument
        args.push(leftExpr);
        return parser.tryCreateASTExpression(() => {
            const call = new AST.Call(nameToken, args);
            call.keywordArgs = keywordArgs;
            return call;
        });
    }
    return parser.tryCreateASTExpression(() => new AST.Call(nameToken, [leftExpr]));
}

function parseFieldAccess(parser: Parser, leftExpr: AST.Expression): AST.Expression {
    if (parser.atEnd() || parser.current().type !== TokenType.Identifier) {
        return parser.error("Expected field name after '.'");
    }
    const fieldName = parser.current().text;
    parser.advance();
    return new AST.FieldAccess(leftExpr, fieldName);
}

function parseVariable(parser: Parser): AST.Expression {
    if (!parser.atEnd() && parser.current().type === TokenType.LParen) {
        // This is a function (or similar) call
        return parseCall(parser);
    }
    // Assume variable is already defined
    const variableToken = parser.previous();
    // Get template types if there are any attached
    const templateTypes = parser.getTemplateTypes();
    return parser.tryCreateASTExpression(() => new AST.Variable(variableToken, templateTypes));
}

function parseCall(parser: Parser): AST.Expression {
    const nameToken = parser.previous();
    if (parser.current().type !== TokenType.LParen) {
        return parser.error("Expected '(' after caller name.");
    }
    parser.advance();
    const args: AST.Expression[] = [];
    const keywordArgs: { name: string; value: AST.Expression }[] = [];
    let seenKeyword = false;
    while (!parser.atEnd() && parser.current().type !== TokenType.RParen) {
        // Detect keyword argument: Identifier =
        if (
            parser.current().type === TokenType.Identifier &&
            parser.peek()?.type === TokenType.Equal
        ) {
            if (args.length > 0) {
                return parser.error("Cannot mix positional and keyword arguments.");
            }
            seenKeyword = true;
            const name = parser.current().text;
            parser.advance(2); // skip Identifier and =
            const value = parser.expression();
            if (value === null) {
                return parser.error("Expected value for keyword argument.");
            }
            // Check for duplicate keywords
            if (keywordArgs.some((k) => k.name === name)) {
                return parser.error(`Duplicate keyword argument '${name}'.`);
            }
            keywordArgs.push({ name, value });
        } else {
            if (seenKeyword) {
                return parser.error("Cannot mix positional and keyword arguments.");
            }
            const arg = parser.expression();
            if (arg === null) {
                return parser.error("Unterminated call.");
            }
            args.push(arg);
        }
        if (!parser.atEnd() && parser.current().type === TokenType.Comma) {
            parser.advance();
        }
    }
    if (parser.atEnd()) {
        return parser.error("Unterminated call.");
    }
    parser.advance();

    return parser.tryCreateASTExpression(() => {
        const call = new AST.Call(nameToken, args);
        call.keywordArgs = keywordArgs;
        return call;
    });
}

function parseDirectCall(parser: Parser, leftExpr: AST.Expression): AST.Expression {
    const args: AST.Expression[] = [];
    const keywordArgs: { name: string; value: AST.Expression }[] = [];
    let seenKeyword = false;
    while (!parser.atEnd() && parser.current().type !== TokenType.RParen) {
        // Detect keyword argument: Identifier =
        if (
            parser.current().type === TokenType.Identifier &&
            parser.peek()?.type === TokenType.Equal
        ) {
            seenKeyword = true;
            const name = parser.current().text;
            parser.advance(2); // skip Identifier and =
            const value = parser.expression();
            if (value === null) {
                return parser.error("Expected value for keyword argument.");
            }
            if (keywordArgs.some((k) => k.name === name)) {
                return parser.error(`Duplicate keyword argument '${name}'.`);
            }
            keywordArgs.push({ name, value });
        } else {
            if (seenKeyword) {
                return parser.error("Cannot mix positional and keyword arguments.");
            }
            const arg = parser.expression();
            if (arg === null) {
                return parser.error("Unterminated call.");
            }
            args.push(arg);
        }
        if (parser.current().type === TokenType.Comma) {
            parser.advance();
        }
    }
    if (parser.atEnd()) {
        return parser.error("Unterminated call.");
    }
    parser.advance();

    return parser.tryCreateASTExpression(() => {
        const call = new AST.DirectCall(leftExpr, args);
        call.keywordArgs = keywordArgs;
        return call;
    });
}

function parseUnsafeCall(parser: Parser, leftExpr: AST.Expression): AST.Expression {
    // After parsing !, check for ( to make an unsafe call
    if (parser.atEnd() || parser.current().type !== TokenType.LParen) {
        return parser.error("Expected '(' after '!' for unsafe call.");
    }
    parser.advance(); // skip '('

    const args: AST.Expression[] = [];
    while (!parser.atEnd() && parser.current().type !== TokenType.RParen) {
        const arg = parser.expression();
        if (arg === null) {
            return parser.error("Unterminated unsafe call.");
        }
        args.push(arg);
        if (parser.current().type === TokenType.Comma) {
            parser.advance();
        }
    }
    if (parser.atEnd()) {
        return parser.error("Unterminated unsafe call.");
    }
    parser.advance(); // skip ')'

    return parser.tryCreateASTExpression(() => {
        const call = new AST.DirectCall(leftExpr, args);
        call.isUnsafe = true;
        return call;
    });
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
    let innerTypeAnnotation: Type | undefined = undefined;
    if (!parser.atEnd() && parser.current().type === TokenType.Colon) {
        parser.advance();
        const typeName = parser.getTypeName();
        if (typeName === null) {
            return parser.error("expected type after ':'");
        }
        innerTypeAnnotation = typeName;
    }
    return parser.tryCreateASTExpression(
        () => new AST.ArrLit(startToken, expressions, innerTypeAnnotation)
    );
}

function parseFor(parser: Parser): AST.Expression {
    const startToken = parser.previous(); // should be 'for'
    // Check for infinite loop: for { ... } (no variable or iterator)
    if (!parser.atEnd() && parser.current().type === TokenType.LBrace) {
        parser.advance();
        const body = parser.block();
        return parser.tryCreateASTExpression(
            () => new AST.ForLoop(startToken, null, null, body as AST.Block)
        );
    }
    // Normal for loop: for Identifier = Expression { ... }
    if (parser.atEnd() || parser.current().type !== TokenType.Identifier) {
        return parser.error("Expected loop variable name after 'for'");
    }
    const varName = parser.current().text;
    parser.advance();
    if (parser.atEnd() || parser.current().type !== TokenType.Equal) {
        return parser.error("Expected '=' after loop variable name");
    }
    parser.advance();
    const iter = parser.expression();
    if (iter === null) {
        return parser.error("Expected iterator expression after '='");
    }
    if (parser.atEnd() || parser.current().type !== TokenType.LBrace) {
        return parser.error("Expected '{' for for loop body");
    }
    parser.advance();
    const body = parser.block();
    return parser.tryCreateASTExpression(
        () => new AST.ForLoop(startToken, varName, iter, body as AST.Block)
    );
}

function parseBreak(parser: Parser): AST.Expression {
    const startToken = parser.previous();
    return new AST.Break(startToken);
}

function parseContinue(parser: Parser): AST.Expression {
    const startToken = parser.previous();
    return new AST.Continue(startToken);
}

function parseReturn(parser: Parser): AST.Expression {
    const startToken = parser.previous();
    const next = parser.atEnd() ? undefined : parser.current().type;
    // If next token is a statement terminator, return has no value
    if (next === undefined || next === TokenType.Semicolon || next === TokenType.RBrace) {
        const nullToken: Token = {
            line: startToken.line,
            col: startToken.col,
            text: "null",
            type: TokenType.LParen,
        };
        return new AST.Return(startToken, new AST.Literal(nullToken, "Null"));
    }
    // Use parseWithPrecedence instead of expression() so the value isn't
    // wrapped in a DropValue when followed by a semicolon (e.g., "return 99;").
    const value = parser.parseWithPrecedence(Precedence.None + 1);
    if (value === null) {
        throw new Error("Expected expression after `return`");
    }
    return new AST.Return(startToken, value);
}

function parseNone(parser: Parser): AST.Expression {
    const token = parser.previous(); // should be 'none'
    if (parser.atEnd() || parser.current().type !== TokenType.Colon) {
        return parser.error("Expected ':Type' after 'none'");
    }
    parser.advance(); // consume ':'
    const annotatedType = parser.getTypeName();
    if (!annotatedType) {
        return parser.error("Expected type annotation after 'none:'");
    }
    return parser.tryCreateASTExpression(() => new AST.NoneLit(token, annotatedType));
}

function parseMatchExpression(parser: Parser): AST.Expression {
    const rootToken = parser.previous(); // should be 'match'

    // Parse the scrutinee expression
    const scrutinee = parser.expression();
    if (scrutinee === null) {
        return parser.error("Expected expression after 'match'");
    }

    // Expect '{'
    if (parser.atEnd() || parser.current().type !== TokenType.LBrace) {
        return parser.error("Expected '{' after match scrutinee");
    }
    parser.advance(); // consume '{'

    const arms: AST.MatchArm[] = [];

    while (!parser.atEnd() && parser.current().type !== TokenType.RBrace) {
        // Skip leading commas (allow trailing comma after last arm)
        if (parser.current().type === TokenType.Comma) {
            parser.advance();
            continue;
        }

        if (parser.current().type === TokenType.None) {
            // `none` arm (Maybe)
            parser.advance(); // consume 'none'
            const body = parser.expression();
            if (body === null) {
                return parser.error("Expected expression after 'none' in match arm");
            }
            arms.push({ kind: "none", body });
        } else if (parser.current().type === TokenType.Else) {
            // `else` arm (catch-all for enums)
            parser.advance(); // consume 'else'
            const body = parser.expression();
            if (body === null) {
                return parser.error("Expected expression after 'else' in match arm");
            }
            arms.push({ kind: "else", body });
        } else if (
            parser.current().type === TokenType.Identifier &&
            parser.peek()?.type === TokenType.LParen
        ) {
            // Arm with binding: variantName(ident) body  — or  some(ident) body for Maybe
            const variantName = parser.current().text;
            parser.advance(); // consume identifier
            parser.advance(); // consume '('

            if (parser.atEnd() || parser.current().type !== TokenType.Identifier) {
                return parser.error("Expected variable name after '('");
            }
            const binding = parser.current().text;
            parser.advance(); // consume binding name

            if (parser.atEnd() || parser.current().type !== TokenType.RParen) {
                return parser.error("Expected ')' after binding name");
            }
            parser.advance(); // consume ')'

            const body = parser.expression();
            if (body === null) {
                return parser.error("Expected expression after arm pattern");
            }
            arms.push({ kind: "variant", variantName, binding, bindingType: null, body });
        } else if (parser.current().type === TokenType.Identifier) {
            // Plain arm without binding: variantName body  (or { block })
            const variantName = parser.current().text;
            parser.advance(); // consume identifier

            const body = parser.expression();
            if (body === null) {
                return parser.error("Expected expression after arm name");
            }
            arms.push({ kind: "variant", variantName, binding: null, bindingType: null, body });
        } else {
            return parser.error(
                "Expected match arm: 'name body', 'name(ident) body', 'none body', or 'else body'"
            );
        }

        // Optional comma after arm
        if (!parser.atEnd() && parser.current().type === TokenType.Comma) {
            parser.advance();
        }
    }

    if (parser.atEnd()) {
        return parser.error("Unterminated match expression");
    }
    parser.advance(); // consume '}'

    if (arms.length === 0) {
        return parser.error("Match expression must have at least one arm");
    }

    return parser.tryCreateASTExpression(() => new AST.Match(rootToken, scrutinee, arms));
}

class Parser {
    tokens: Token[];
    index: number = 0;
    previousIndex: number = 0;
    panicMode: boolean = false;
    errors: ParseError[] = [];
    visitedModules: Set<string>;
    moduleTokens: Record<string, Token[]>;

    constructor(
        tokens: Token[],
        visitedModules: Set<string> = new Set(),
        moduleTokens: Record<string, Token[]> = {}
    ) {
        this.tokens = tokens;
        this.visitedModules = visitedModules;
        this.moduleTokens = moduleTokens;
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
            if (e instanceof AST.ASTError) {
                return this.error(e.message);
            }
            if (e instanceof Error) {
                return this.error(e.message);
            }
            throw e;
        }
    }

    getTemplateTypes(): TemplateTypes {
        if (this.atEnd() || this.current().type !== TokenType.LBracket) {
            return new TemplateTypes();
        }
        this.advance();
        const templateTypes = new TemplateTypes();
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
                templateTypes.returnType = getType(returnTypeName, nestedTemplateTypes);
                break;
            }
            if (this.current().type !== TokenType.Identifier) {
                throw this.error("Expected type identifier.");
            }
            const typeName = this.current().text;
            this.advance();
            const nestedTemplateTypes = this.getTemplateTypes();
            templateTypes.push(getType(typeName, nestedTemplateTypes));
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

    getTypeTraits(): { type: Type; trait: Type }[] {
        if (this.atEnd() || this.current().type !== TokenType.Where) {
            return [];
        }
        this.advance();
        const typeTraits: { type: Type; trait: Type }[] = [];
        while (!this.atEnd() && this.current().type !== TokenType.LBrace) {
            if (this.current().type !== TokenType.Identifier) {
                throw new Error("expected type alias after 'where'");
            }
            let typeName: Type;
            try {
                typeName = getType(this.current().text, new TemplateTypes());
            } catch (e) {
                if (e instanceof Error) {
                    throw new Error(e.message, { cause: e });
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
            let traitName: Type;
            try {
                traitName = getType(this.current().text, new TemplateTypes());
            } catch (e) {
                if (e instanceof Error) {
                    throw new Error(e.message, { cause: e });
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

    getTypeName(): Type | null {
        if (this.current().type !== TokenType.Identifier) {
            return null;
        }
        const paramType = this.current().text;
        this.advance();
        const templateTypes = this.getTemplateTypes();
        if (!this.atEnd() && this.current().type === TokenType.Comma) {
            this.advance();
        }
        try {
            return getType(paramType, templateTypes);
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
                return this.error(
                    `expected infix operator, but got ${this.current().text} -- you may have forgotten a semicolon to terminate the previous expression.`,
                    0
                );
            }
            this.advance();
            expr = infixRule(this, expr);
        }

        return expr;
    }

    // Map compound assignment token types to the corresponding binary operator type
    static readonly COMPOUND_OPS: Record<string, string> = {
        [TokenType.PlusEqual]: TokenType.Plus,
        [TokenType.MinusEqual]: TokenType.Minus,
        [TokenType.StarEqual]: TokenType.Star,
        [TokenType.SlashEqual]: TokenType.Slash,
        [TokenType.PercentEqual]: TokenType.Percent,
        [TokenType.CaretEqual]: TokenType.Caret,
    };

    /**
     * Finish parsing a field assignment: obj.field = value or obj.field += value.
     * The FieldAccess expression has already been parsed; we're positioned at = or a compound op.
     */
    finishFieldAssignment(
        fieldAccess: AST.FieldAccess,
        isCompound: boolean
    ): AST.FieldAssignment | null {
        const compoundOp = isCompound ? Parser.COMPOUND_OPS[this.current().type] : null;
        this.advance(); // consume = or compound op

        const rhs = this.parseWithPrecedence(Precedence.Assignment);
        if (!rhs) {
            this.error("Expected expression after =");
            return null;
        }

        let value: AST.Expression = rhs;
        if (isCompound && compoundOp) {
            // Desugar p.x += expr → p.x = p.x + expr
            const opToken = {
                line: fieldAccess.line,
                col: fieldAccess.col,
                text: compoundOp,
                type: compoundOp as TokenType,
            };
            const fieldRead = new AST.FieldAccess(fieldAccess.obj, fieldAccess.fieldName);
            value = new AST.Binary(opToken, fieldRead, rhs);
        }

        let isDropped = false;
        if (!this.atEnd() && this.current().type === TokenType.Semicolon) {
            this.advance();
            isDropped = true;
        }
        return new AST.FieldAssignment(fieldAccess.obj, fieldAccess.fieldName, value, isDropped);
    }

    assignment(): AST.Expression | null {
        // Tuple unpacking: (a, b, mut c) = expr
        // Only match if we see LParen followed by an Identifier (or mut) and eventually =.
        // This avoids conflicting with parenthesized expressions like (1 + 2).
        if (this.current().type === TokenType.LParen) {
            // Peek ahead to see if this looks like a tuple unpacking pattern.
            // A tuple unpacking must have at least one identifier (or mut + identifier)
            // followed by either comma or = after the closing paren.
            let offset = 1;
            let seenComma = false;
            let sawIdent = false;
            let foundEq = false;
            while (true) {
                const t = this.peek(offset);
                if (t === undefined) {
                    break;
                }
                if (t.type === TokenType.RParen) {
                    // Check if next after ')' is '='
                    const afterParen = this.peek(offset + 1);
                    if (afterParen?.type === TokenType.Equal && (sawIdent || seenComma)) {
                        foundEq = true;
                    }
                    break;
                }
                if (t.type === TokenType.LParen) {
                    // Skip nested parenthesized sub-pattern (e.g. (a, (b, c)) = ...)
                    let depth = 1;
                    let innerOffset = offset + 1;
                    while (depth > 0) {
                        const inner = this.peek(innerOffset);
                        if (inner === undefined) break;
                        if (inner.type === TokenType.LParen) depth++;
                        else if (inner.type === TokenType.RParen) depth--;
                        innerOffset++;
                    }
                    offset = innerOffset;
                    continue;
                }
                if (t.type === TokenType.Identifier) {
                    sawIdent = true;
                } else if (t.type === TokenType.Mut) {
                    // mut keyword is fine
                } else if (t.type === TokenType.Comma) {
                    seenComma = true;
                } else {
                    break; // Not a valid tuple unpacking pattern
                }
                offset++;
            }
            if (foundEq) {
                // This IS a tuple unpacking. Parse it.
                const startToken = this.current();
                this.advance(); // skip '('
                const bindings: { name: string; isMutable: boolean }[] = [];

                while (!this.atEnd() && this.current().type !== TokenType.RParen) {
                    let isMut = false;
                    if (this.current().type === TokenType.Mut) {
                        isMut = true;
                        this.advance();
                    }
                    if (this.current().type !== TokenType.Identifier) {
                        return this.error("expected variable name in tuple unpacking");
                    }
                    bindings.push({ name: this.current().text, isMutable: isMut });
                    this.advance();
                    if (this.current().type === TokenType.Comma) {
                        this.advance();
                    }
                }
                if (this.atEnd() || this.current().type !== TokenType.RParen) {
                    return this.error("missing closing parenthesis in tuple unpacking");
                }
                this.advance(); // skip ')'

                if (this.atEnd() || this.current().type !== TokenType.Equal) {
                    return this.error("expected '=' after tuple unpacking pattern");
                }
                this.advance(); // skip '='

                const rhs = this.parseWithPrecedence(Precedence.Assignment);
                if (!rhs) {
                    return this.error("Expected expression after = in tuple unpacking");
                }

                let isDropped = false;
                if (!this.atEnd() && this.current().type === TokenType.Semicolon) {
                    this.advance();
                    isDropped = true;
                }
                return this.tryCreateASTExpression(
                    () => new AST.TupleUnpack(startToken, bindings, rhs, isDropped)
                );
            }
            // Not a tuple unpacking; fall through to let parseGrouping handle it.
        }

        let isMutable = false;
        // Check for optional 'mut' keyword before the variable name
        const afterMut =
            this.current().type === TokenType.Mut &&
            this.peek()?.type === TokenType.Identifier &&
            (this.peek(2)?.type === TokenType.Equal || this.peek(2)?.type in Parser.COMPOUND_OPS);
        if (afterMut) {
            isMutable = true;
            this.advance(); // skip 'mut'
        }
        if (this.current().type !== TokenType.Identifier) {
            return null;
        }
        const nextType = this.peek()?.type;
        if (nextType !== TokenType.Equal && !(nextType && nextType in Parser.COMPOUND_OPS)) {
            return null;
        }
        const variableToken = this.current();
        const isCompound = nextType !== TokenType.Equal;
        const compoundOp = isCompound ? Parser.COMPOUND_OPS[nextType!] : null;
        this.advance(2); // skip Identifier and = or += etc.

        // Try chained assignment (x = y = 2) first, fall back to expression.
        let rhs = this.assignment();
        if (rhs instanceof AST.Assignment && rhs.isDropped) {
            // The recursive call consumed a semicolon that belongs to the outer
            // assignment. Undrop the inner assignment so the semicolon is not
            // consumed twice and the inner assignment is treated as an expression.
            rhs.isDropped = false;
        }
        if (rhs === null) {
            rhs = this.parseWithPrecedence(Precedence.Assignment);
        }
        if (!rhs) {
            return this.error("Expected expression after =");
        }

        let value: AST.Expression = rhs;
        if (isCompound && compoundOp) {
            // Desugar x += expr → x = x + expr by creating a Binary node
            const varRef = new AST.Variable(variableToken, new TemplateTypes());
            value = this.tryCreateASTExpression(() => {
                // Build the binary operation token
                const opToken = {
                    line: variableToken.line,
                    col: variableToken.col,
                    text: compoundOp,
                    type: compoundOp as TokenType,
                };
                return new AST.Binary(opToken, varRef, rhs);
            });
        }

        let isDropped = false;
        if (!this.atEnd() && this.current().type === TokenType.Semicolon) {
            this.advance();
            isDropped = true;
        }
        return new AST.Assignment(variableToken, value, isDropped, isMutable);
    }

    functionDef(): AST.Expression | null {
        if (this.current().type !== TokenType.Func || this.peek()?.type !== TokenType.Identifier) {
            return null;
        }
        const rootToken = this.current();
        this.advance();
        let name = this.current().text;
        let typeAssociatedName: string | null = null;
        let typeAssociatedTemplates: TemplateTypes = new TemplateTypes();
        this.advance();

        // Check for template types on the type name: Arr[Int].funcName
        if (this.current().type === TokenType.LBracket) {
            typeAssociatedTemplates = this.getTemplateTypes();
        }

        // Check for type-associated function: func TypeName.funcName(...)
        if (this.current().type === TokenType.Dot && this.peek()?.type === TokenType.Identifier) {
            const templateStr = typeAssociatedTemplates.empty()
                ? ""
                : typeAssociatedTemplates.toString();
            typeAssociatedName = name + templateStr;
            this.advance(); // skip '.'
            name = this.current().text;
            this.advance(); // skip funcName
        }

        if (this.current().type !== TokenType.LParen) {
            return this.error("Expected '(' after function name.");
        }
        this.advance();
        const params: { name: string; type: Type }[] = [];
        while (!this.atEnd() && this.current().type !== TokenType.RParen) {
            if (this.current().type !== TokenType.Identifier) {
                return this.error("Expected parameter name.");
            }
            const paramName = this.current().text;
            this.advance();
            if (this.current().type !== TokenType.Colon) {
                return this.error("Expected ':' after parameter name.");
            }
            this.advance();
            const typeName = this.getTypeName();
            if (!typeName) {
                return new AST.ErrorExpression(rootToken, "Invalid type annotation.");
            }
            params.push({ name: paramName, type: typeName });
        }

        if (this.atEnd()) {
            return this.error("Unterminated function definition.");
        }
        this.advance();

        let returnType: Type = "Null";
        if (this.current().type === TokenType.Colon) {
            this.advance();
            const explicitReturnType = this.getTypeName();
            if (!explicitReturnType) {
                return new AST.ErrorExpression(rootToken, "Invalid type annotation.");
            }
            returnType = explicitReturnType;
        }
        // If no return type is specified, it defaults to "Null" and will be inferred
        // from the body during cascadeTypes

        if (this.atEnd()) {
            return this.error("Unterminated function definition.");
        }
        let typeTraits;
        try {
            typeTraits = this.getTypeTraits();
        } catch (e) {
            if (e instanceof Error) {
                return this.error(e.message);
            }
            throw e;
        }

        if (this.atEnd()) {
            return this.error("Unterminated function definition.");
        }
        if (this.current().type !== TokenType.LBrace) {
            return this.error("Expected '{' after function parameters.");
        }
        this.advance();

        return this.tryCreateASTExpression(
            () =>
                new AST.FunctionDef(
                    rootToken,
                    name,
                    params,
                    returnType,
                    typeTraits,
                    this.block(),
                    false,
                    typeAssociatedName,
                    typeAssociatedTemplates
                )
        );
    }

    parseUse(): AST.Expression | null {
        if (this.current().type !== TokenType.Use) {
            return null;
        }
        const rootToken = this.current();
        this.advance(); // consume 'use'
        if (this.atEnd()) {
            return this.error("Expected module path or symbol list after 'use'.");
        }

        // Parse the optional symbol list: (foo, bar) or foo, bar
        const symbols: string[] = [];
        let hasParens = false;
        let hasSymbolList = false;

        if (this.current().type === TokenType.LParen) {
            hasParens = true;
            this.advance(); // consume '('
        }

        // Check if we're looking at identifiers (a symbol list) or a string (bare import)
        if (!hasParens && this.current().type !== TokenType.String) {
            // Could be a bare identifier list without parens
            // Peek ahead: if we see Identifier [Comma Identifier]* [From] String, it's a symbol list
            if (this.current().type === TokenType.Identifier && !this.atEnd()) {
                hasSymbolList = true;
            }
        }

        if (hasParens || hasSymbolList) {
            // Parse comma-separated identifier list
            while (!this.atEnd() && this.current().type === TokenType.Identifier) {
                symbols.push(this.current().text);
                this.advance(); // consume the identifier
                if (this.current().type === TokenType.Comma) {
                    this.advance(); // consume ','
                } else {
                    break;
                }
            }

            if (hasParens) {
                if (this.atEnd() || this.current().type !== TokenType.RParen) {
                    return this.error("Expected ')' after symbol list.");
                }
                this.advance(); // consume ')'
            }

            if (symbols.length === 0) {
                return this.error("Expected at least one symbol name.");
            }

            if (this.atEnd() || this.current().type !== TokenType.From) {
                return this.error("Expected 'from' after symbol list.");
            }
            this.advance(); // consume 'from'
        }

        // Now parse the module path string
        if (this.atEnd() || this.current().type !== TokenType.String) {
            return this.error("Expected module path string.");
        }
        let path = this.current().text;
        if (path.length >= 2 && path.startsWith('"') && path.endsWith('"')) {
            path = path.slice(1, -1);
        }
        this.advance(); // consume the string

        // Check for circular imports
        if (this.visitedModules.has(path)) {
            return this.error(
                `Circular dependency detected: module '${path}' is already being compiled.`
            );
        }

        // Look up the module's pre-scanned tokens
        const moduleTokens = this.moduleTokens[path];
        if (!moduleTokens) {
            return this.error(
                `Module '${path}' not found. Make sure it is included in the provided files.`
            );
        }

        // Create a child parser to parse the imported module
        const childVisited = new Set(this.visitedModules);
        childVisited.add(path);
        const childParser = new Parser(moduleTokens, childVisited, this.moduleTokens);
        const moduleBlock = childParser.block();

        // Propagate any parse errors from the child parser
        for (const err of childParser.errors) {
            this.errors.push(err);
        }

        // If the child had errors, return an error expression
        if (childParser.errors.length > 0 || moduleBlock instanceof AST.ErrorExpression) {
            return new AST.ErrorExpression(rootToken, `Error parsing module '${path}'`);
        }

        return this.tryCreateASTExpression(
            () =>
                new AST.UseModule(
                    rootToken,
                    path,
                    moduleBlock as AST.Block,
                    symbols.length > 0 ? symbols : undefined
                )
        );
    }

    structDef(): AST.Expression | null {
        if (
            this.current().type !== TokenType.Struct ||
            this.peek()?.type !== TokenType.Identifier
        ) {
            return null;
        }
        const rootToken = this.current();
        this.advance(); // consume 'struct'
        const name = this.current().text;
        this.advance(); // consume struct name
        if (this.atEnd() || this.current().type !== TokenType.LBrace) {
            return this.error("Expected '{' after struct name.");
        }
        this.advance(); // consume '{'
        const fields: { name: string; type: Type; mutable: boolean }[] = [];
        while (!this.atEnd() && this.current().type !== TokenType.RBrace) {
            // Check for optional 'mut' before field name
            let fieldMutable = false;
            if (
                this.current().type === TokenType.Mut &&
                this.peek()?.type === TokenType.Identifier
            ) {
                fieldMutable = true;
                this.advance(); // skip 'mut'
            }
            if (this.current().type !== TokenType.Identifier) {
                return this.error("Expected field name.");
            }
            const fieldName = this.current().text;
            this.advance();
            if (this.current().type !== TokenType.Colon) {
                return this.error("Expected ':' after field name.");
            }
            this.advance();
            const fieldType = this.getTypeName();
            if (!fieldType) {
                return new AST.ErrorExpression(rootToken, "Invalid type annotation for field.");
            }
            // Check for duplicate field names
            if (fields.some((f) => f.name === fieldName)) {
                return this.error(`Duplicate field name '${fieldName}' in struct ${name}.`);
            }
            fields.push({ name: fieldName, type: fieldType, mutable: fieldMutable });
            if (!this.atEnd() && this.current().type === TokenType.Comma) {
                this.advance();
            }
        }
        if (this.atEnd()) {
            return this.error("Unterminated struct definition.");
        }
        this.advance(); // consume '}'
        return this.tryCreateASTExpression(() => new AST.StructDef(rootToken, name, fields));
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

        const rootToken = this.previous(); // Should be LBrace
        const expressions: AST.Expression[] = [];
        while (!this.atEnd() && this.current().type !== TokenType.RBrace) {
            if (this.current().type === TokenType.Semicolon) {
                this.advance();
                continue;
            }
            if (this.current().type === TokenType.Use) {
                const useModule = this.parseUse();
                if (useModule !== null) {
                    expressions.push(useModule);
                    continue;
                }
            }
            const assignment = this.assignment();
            if (assignment !== null) {
                expressions.push(assignment);
                continue;
            }
            const structDef = this.structDef();
            if (structDef !== null) {
                expressions.push(structDef);
                continue;
            }
            const functionDef = this.functionDef();
            if (functionDef !== null) {
                expressions.push(functionDef);
                continue;
            }
            const expr = this.expression();
            if (expr !== null) {
                // Check for field assignment: obj.field = value or obj.field += value etc.
                if (expr instanceof AST.FieldAccess && !this.atEnd()) {
                    const nextType = this.current().type;
                    if (nextType === TokenType.Equal) {
                        const fa = this.finishFieldAssignment(expr, false);
                        if (fa !== null) {
                            expressions.push(fa);
                            continue;
                        }
                    } else if (nextType in Parser.COMPOUND_OPS) {
                        const fa = this.finishFieldAssignment(expr, true);
                        if (fa !== null) {
                            expressions.push(fa);
                            continue;
                        }
                    }
                }
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
            if (e instanceof AST.ASTError) {
                return this.error(e.message);
            }
            if (e instanceof Error) {
                return this.error(e.message);
            }
            throw e;
        }
    }
}

export function parse(
    tokens: Token[],
    allowNullType: boolean = false,
    skipCascadeTypes: boolean = false,
    moduleTokens: Record<string, Token[]> = {},
    visitedModules: Set<string> = new Set()
): { ast: AST.Expression; errors: ParseError[] } {
    const parser = new Parser(tokens, visitedModules, moduleTokens);
    const block = parser.block();
    if (parser.errors.length === 0) {
        if (!skipCascadeTypes) {
            try {
                block.cascadeTypes(null, true);
            } catch (e) {
                if (e instanceof AST.ASTError) {
                    parser.errors.push({
                        line: e.line,
                        col: e.col,
                        message: e.message,
                    });
                } else {
                    // Non-ASTError (e.g. from Function constructor validation).
                    // Report it without line/col info.
                    parser.errors.push({
                        line: 0,
                        col: 0,
                        message: e instanceof Error ? e.message : String(e),
                    });
                }
            }
        }
    }
    if (block.type === "Null" && !allowNullType && !skipCascadeTypes) {
        parser.errors.push({
            line: tokens[tokens.length - 1].line,
            col: tokens[tokens.length - 1].col,
            message:
                "Top-level expression cannot have Null type (program cannot end with a value-less statement, including any statement concluded with a semicolon)",
        });
    }
    return { ast: block, errors: parser.errors };
}
