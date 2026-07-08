import * as AST from "./ast/index";
import { type Type, FuncType, GenericType, TemplateTypes, getType } from "./ast/types";
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
PARSE_RULES[TokenType.Num] = {
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
PARSE_RULES[TokenType.SlashSlash] = {
    prefix: null,
    infix: parseBinary,
    precedence: Precedence.Factor,
};
PARSE_RULES[TokenType.Percent] = {
    prefix: null,
    infix: parseBinary,
    precedence: Precedence.Factor,
};
PARSE_RULES[TokenType.PercentPercent] = {
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
    prefix: null,
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
        elseBranch = null;
    }
    return parser.tryCreateASTExpression(
        () => new AST.If(rootToken, conditionalBranches, elseBranch)
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
    const requiredFunctions: { name: string; signature: FuncType }[] = [];
    while (!parser.atEnd() && parser.current().type !== TokenType.RBrace) {
        // Expect inputs of form:
        //   funcName[Type, ...: ReturnType]
        //   Type::funcName[Type, ...: ReturnType]  (type-associated function)
        if (parser.current().type !== TokenType.Identifier) {
            return parser.error("Expected function name.");
        }
        // If current identifier is not immediately followed by "[",
        // assume this is a signature for a TAF
        let associatedType: Type | null = null;
        if (parser.peek().type !== TokenType.LBracket) {
            associatedType = parser.getTypeName();
            if (associatedType === null) {
                return parser.error("Expected function name or associated type");
            }
            if (parser.current().type !== TokenType.ColonColon) {
                return parser.error("Expected '::' after type name");
            }
            parser.advance(); // consume '::'
            if (parser.current().type !== TokenType.Identifier) {
                return parser.error("Expected function name.");
            }
        }

        let funcName = parser.current().text;
        parser.advance();

        // Expect '[' after function name
        if (parser.atEnd() || parser.current().type !== TokenType.LBracket) {
            return parser.error("Expected '[' after function name in trait.");
        }
        parser.advance();

        // Parse parameter list: Type1, Type2, ...
        const paramTypes: Type[] = [];
        while (
            !parser.atEnd() &&
            parser.current().type !== TokenType.Colon &&
            parser.current().type !== TokenType.RBracket
        ) {
            const paramType = parser.getTypeName();
            if (!paramType) {
                return parser.error("Invalid type for parameter.");
            }
            paramTypes.push(paramType);

            if (!parser.atEnd() && parser.current().type === TokenType.Comma) {
                parser.advance();
            }
        }
        if (parser.atEnd()) {
            return parser.error("Unterminated parameter list in trait function signature.");
        }

        // Expect ':'
        if (parser.atEnd() || parser.current().type !== TokenType.Colon) {
            return parser.error("Expected ':' after parameters for return type.");
        }
        parser.advance();

        // Parse return type
        if (parser.atEnd() || parser.current().type !== TokenType.Identifier) {
            return parser.error("Expected return type.");
        }
        const returnType = parser.getTypeName();
        if (!returnType) {
            return parser.error("Invalid type for parameter.");
        }

        // Expect ']'
        if (parser.atEnd() || parser.current().type !== TokenType.RBracket) {
            return parser.error("Expected ']' to close trait function signature.");
        }
        parser.advance();

        requiredFunctions.push({
            name: funcName,
            signature: new FuncType(paramTypes, returnType, associatedType),
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

    // Parse optional type parameter list: enum Result[T, E] { ... }
    // We will use the same mechanism used for generic function definitions to parse
    // the type parameters, although for now we won't accept trait bounds
    const typeParams: Record<string, { traits: []; used: false }> = {};
    if (!parser.atEnd() && parser.current().type === TokenType.LBracket) {
        parser.advance(); // consume '['
        while (!parser.atEnd() && parser.current().type !== TokenType.RBracket) {
            if (parser.current().type !== TokenType.Identifier) {
                return parser.error("Expected type parameter name.");
            }
            const tpName = parser.current().text;
            if (tpName in typeParams) {
                return parser.error(`Duplicate type parameter '${tpName}'.`);
            }
            typeParams[tpName] = { traits: [], used: false };
            parser.advance();
            if (parser.current().type === TokenType.Comma) {
                parser.advance();
            }
        }
        if (parser.atEnd()) {
            return parser.error("Unterminated type parameter list.");
        }
        parser.advance(); // consume ']'
    }

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
            variantType = parser.getTypeName(typeParams);
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

    // Check that we've actually used all the generic types that we created
    for (const name of Object.keys(typeParams)) {
        if (!typeParams[name].used) {
            return parser.error(`Generic type ${name} is not used as a parameter type`);
        }
    }

    return parser.tryCreateASTExpression(
        () =>
            new AST.EnumDef(
                rootToken,
                name,
                variants,
                Object.keys(typeParams).map(
                    (name) => new GenericType(name, typeParams[name].traits)
                )
            )
    );
}

function parseInt(parser: Parser): AST.Expression {
    const token = parser.previous();
    return new AST.Literal(token, "Int");
}

function parseFloat(parser: Parser): AST.Expression {
    const token = parser.previous();
    return new AST.Literal(token, "Num");
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
        while (!parser.atEnd() && parser.current().type !== TokenType.RParen) {
            const arg = parser.expression();
            if (arg === null) {
                return parser.error("Expected expression.");
            }
            args.push(arg);
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
            return new AST.Call(nameToken, args);
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
    if (parser.current()?.type === TokenType.ColonColon) {
        // This is something like Foo[T]::bar or Foo::baz(bim)
        parser.advance(); // consume '::'
        return parseTypeAssociatedVariable(parser, variableToken, templateTypes);
    }
    return parser.tryCreateASTExpression(() => new AST.Variable(variableToken, templateTypes));
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

    return parser.tryCreateASTExpression(() => {
        return new AST.Call(nameToken, args);
    });
}

function parseTypeAssociatedVariable(
    parser: Parser,
    variableToken: Token,
    templateTypes: TemplateTypes
): AST.Expression {
    if (parser.atEnd() || parser.current().type !== TokenType.Identifier) {
        return parser.error("Expected identifier after '::'");
    }
    parser.advance();
    const innerExpr = parseVariable(parser);
    if (innerExpr instanceof AST.ASTError) {
        return innerExpr;
    }
    return parser.tryCreateASTExpression(
        () => new AST.TypeAssociatedExpr(variableToken, templateTypes, innerExpr)
    );
}

function parseDirectCall(
    parser: Parser,
    leftExpr: AST.Expression,
    isUnsafe: boolean = false
): AST.Expression {
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

    return parser.tryCreateASTExpression(() => {
        return new AST.DirectCall(leftExpr, args, isUnsafe);
    });
}

function parseUnsafeCall(parser: Parser, leftExpr: AST.Expression): AST.Expression {
    // After parsing !, check for ( to make an unsafe call
    if (parser.atEnd() || parser.current().type !== TokenType.LParen) {
        return parser.error("Expected '(' after '!' for unsafe call.");
    }
    parser.advance(); // skip '('

    return parseDirectCall(parser, leftExpr, true);
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
        return parser.error("Expected expression after `return`");
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

    getTemplateTypes(
        generics: Record<string, { traits: string[]; used: boolean }> | null = null
    ): TemplateTypes {
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
                templateTypes.returnType = getType(returnTypeName, nestedTemplateTypes, generics);
                break;
            }
            if (this.current().type !== TokenType.Identifier) {
                throw this.error("Expected type identifier.");
            }
            const typeName = this.current().text;
            this.advance();
            const nestedTemplateTypes = this.getTemplateTypes();
            templateTypes.push(getType(typeName, nestedTemplateTypes, generics));
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

    getTypeName(
        generics: Record<string, { traits: string[]; used: boolean }> | null = null
    ): Type | null {
        if (this.current().type !== TokenType.Identifier) {
            return null;
        }
        const paramType = this.current().text;
        this.advance();
        const templateTypes = this.getTemplateTypes(generics);
        if (!this.atEnd() && this.current().type === TokenType.Comma) {
            this.advance();
        }
        try {
            return getType(paramType, templateTypes, generics);
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
        [TokenType.SlashSlashEqual]: TokenType.SlashSlash,
        [TokenType.PercentEqual]: TokenType.Percent,
        [TokenType.PercentPercentEqual]: TokenType.PercentPercent,
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
            const varRef = new AST.Variable(variableToken, null);
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

    /**
     * Gets a record of "generic name": ["trait name", ...] from sequence of tokens like
     * [T, U: Trait1 + Trait 2, V: Trait3] or [T, U: Trait1, U: Trait2, V: Trait3]
     * Returns null if the following sequence of tokens does not match this pattern
     */
    getGenerics(): {
        error: string | null;
        result: Record<string, { traits: string[]; used: false }> | null;
    } {
        if (this.current()?.type !== TokenType.LBracket) {
            return { error: null, result: null };
        }
        this.advance(); // Consume "["
        if (this.current().type === TokenType.RBracket) {
            return { error: "Cannot have empty generic type list", result: null };
        }
        const generics: Record<string, { traits: string[]; used: false }> = {};
        while (!this.atEnd() && this.current().type !== TokenType.RBracket) {
            if (this.current().type !== TokenType.Identifier) {
                return { error: "Expected generic type name", result: null };
            }
            const name = this.current().text;
            const traits: string[] = [];
            this.advance();
            if (this.current()?.type === TokenType.Colon) {
                this.advance();
                // Parse trait names associated with generic
                while (true) {
                    if (this.current()?.type !== TokenType.Identifier) {
                        return { error: "Expected trait name", result: null };
                    }
                    traits.push(this.current().text);
                    this.advance();
                    if (this.current()?.type === TokenType.Plus) {
                        this.advance();
                    } else {
                        break;
                    }
                }
            }
            if (name in generics) {
                // Add any new traits to existing generic
                for (const trait of traits) {
                    if (!generics[name].traits.includes(trait)) {
                        generics[name].traits.push(trait);
                    }
                }
            } else {
                // Add a new generic
                generics[name] = { traits, used: false };
            }
            if (this.current()?.type === TokenType.Comma) {
                this.advance();
            }
        }
        if (!this.atEnd()) {
            this.advance(); // Consume "]"
        }
        return { error: null, result: generics };
    }

    functionDef(): AST.Expression | null {
        if (
            this.current().type !== TokenType.Func ||
            (this.peek().type !== TokenType.Identifier && this.peek().type !== TokenType.LBracket)
        ) {
            return null;
        }
        const rootToken = this.current();
        this.advance();

        // Check for generic types
        const genericsResult = this.getGenerics();
        if (genericsResult.error !== null) {
            return this.error(genericsResult.error);
        }
        const generics = genericsResult.result;

        let name: string;
        let associatedType: Type | null = null;
        if (this.peek()?.type !== TokenType.LParen) {
            // Assume this must be a type-associated function
            associatedType = this.getTypeName(generics);
            if (associatedType === null) {
                return this.error("Expected function name or associated type name");
            }
            if (
                this.current()?.type !== TokenType.ColonColon ||
                this.peek()?.type !== TokenType.Identifier
            ) {
                return this.error("Expected function name after associated type name");
            }
            this.advance(); // consume "::"
        }
        name = this.current().text;
        this.advance();

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
            if (paramName === name) {
                return this.error("Parameter name cannot be the same as the function name");
            }
            this.advance();
            if (this.current().type !== TokenType.Colon) {
                return this.error("Expected ':' after parameter name.");
            }
            this.advance();
            const typeName = this.getTypeName(generics);
            if (!typeName) {
                return new AST.ErrorExpression(rootToken, "Invalid type annotation.");
            }
            params.push({ name: paramName, type: typeName });
        }

        // If this is a generic function definition, make sure we have used all the generic types as either (part of) an associated type or (part of) a param type
        // Otherwise, we won't be able to resolve the type when we try to call this function
        if (generics !== null) {
            for (const genericName of Object.keys(generics)) {
                if (!generics[genericName].used) {
                    return this.error(
                        `Generic type ${genericName} is not used as either an associated type or as a parameter type`
                    );
                }
            }
        }

        if (this.atEnd()) {
            return this.error("Unterminated function definition.");
        }
        this.advance();

        let returnType: Type | null = null;
        if (this.current().type === TokenType.Colon) {
            this.advance();
            const explicitReturnType = this.getTypeName(generics);
            if (!explicitReturnType) {
                return new AST.ErrorExpression(rootToken, "Invalid type annotation.");
            }
            returnType = explicitReturnType;
        }
        // If no return type is specified, it is set to null for now and will be inferred
        // from the body during cascadeTypes

        if (this.atEnd()) {
            return this.error("Unterminated function definition.");
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
                    associatedType,
                    params,
                    returnType,
                    this.block(),
                    generics === null
                        ? null
                        : Object.keys(generics).map((k) => new GenericType(k, generics[k].traits))
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

        // Parse the optional symbol list: (foo, bar) or foo, bar or (foo: Type, bar: Type)
        const symbols: string[] = [];
        const typedSymbols: AST.JSImportSymbol[] = [];
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
            // Parse comma-separated identifier list, optionally with type annotations
            while (!this.atEnd() && this.current().type === TokenType.Identifier) {
                const symName = this.current().text;
                this.advance(); // consume the identifier

                // Check for type annotation (name: Type)
                if (!this.atEnd() && this.current().type === TokenType.Colon) {
                    // Type-annotated symbol
                    if (symbols.length > 0) {
                        return this.error(
                            "Cannot mix typed and un-typed imports in the same list."
                        );
                    }
                    this.advance(); // consume ':'
                    const typeAnnotation = this.getTypeName();
                    if (!typeAnnotation) {
                        return this.error("Expected type annotation after ':'.");
                    }
                    typedSymbols.push({ name: symName, typeAnnotation });
                    // getTypeName already consumed trailing comma if present
                } else {
                    // Plain symbol name (existing behavior)
                    if (typedSymbols.length > 0) {
                        return this.error(
                            "Cannot mix typed and un-typed imports in the same list."
                        );
                    }
                    symbols.push(symName);
                    if (this.current().type === TokenType.Comma) {
                        this.advance(); // consume ','
                    } else {
                        break;
                    }
                }
            }

            if (hasParens) {
                if (this.atEnd() || this.current().type !== TokenType.RParen) {
                    return this.error("Expected ')' after symbol list.");
                }
                this.advance(); // consume ')'
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

        // Determine if this is a JS module import
        const isJSModule = path.endsWith(".js") || path.endsWith(".mjs");

        if (isJSModule) {
            // JS module import: require parens and type annotations
            if (!hasParens) {
                return this.error("JS module imports require parentheses around the symbol list.");
            }
            if (typedSymbols.length > 0 && symbols.length > 0) {
                return this.error("Cannot mix typed and un-typed imports in the same list.");
            }
            // If symbols list was provided but without type annotations, that's an error
            if (symbols.length > 0 && typedSymbols.length === 0) {
                return this.error("Type annotations are required for JS module imports.");
            }
            // Empty import lists are not allowed for JS modules
            if (typedSymbols.length === 0) {
                return this.error("JS module imports require at least one symbol.");
            }
            return this.tryCreateASTExpression(
                () => new AST.UseJSModule(rootToken, path, typedSymbols)
            );
        }

        // ── Gema module import (existing behavior) ──

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

        // Parse optional type parameter list: struct Pair[T, U] { ... }
        const typeParams: string[] = [];
        if (!this.atEnd() && this.current().type === TokenType.LBracket) {
            this.advance(); // consume '['
            while (!this.atEnd() && this.current().type !== TokenType.RBracket) {
                if (this.current().type !== TokenType.Identifier) {
                    return this.error("Expected type parameter name.");
                }
                const tpName = this.current().text;
                if (typeParams.includes(tpName)) {
                    return this.error(`Duplicate type parameter '${tpName}'.`);
                }
                typeParams.push(tpName);
                this.advance();
                if (this.current().type === TokenType.Comma) {
                    this.advance();
                }
            }
            if (this.atEnd()) {
                return this.error("Unterminated type parameter list.");
            }
            this.advance(); // consume ']'
        }

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
        return this.tryCreateASTExpression(
            () => new AST.StructDef(rootToken, name, fields, typeParams)
        );
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
