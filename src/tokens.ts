export enum TokenType {
    Identifier = "<IDENT>",
    // Literals
    Integer = "<INT>",
    Num = "<NUM>",
    String = "<STR>",
    // Brackets
    LParen = "(",
    RParen = ")",
    LBrace = "{",
    RBrace = "}",
    LBracket = "[",
    RBracket = "]",
    // Punctuation
    Comma = ",",
    Dot = ".",
    DotDot = "..",
    Colon = ":",
    Semicolon = ";",
    // Unary operators
    Bang = "!",
    At = "@",
    Backslash = "\\",
    // Binary operators
    And = "and",
    Or = "or",
    Plus = "+",
    Minus = "-",
    Star = "*",
    Slash = "/",
    Percent = "%",
    SlashSlash = "//",
    PercentPercent = "%%",
    Caret = "^",
    BangEqual = "!=",
    Equal = "=",
    EqualEqual = "==",
    Greater = ">",
    GreaterEqual = ">=",
    Less = "<",
    LessEqual = "<=",
    // Other keywords
    Func = "func",
    Struct = "struct",
    Trait = "trait",
    Enum = "enum",
    Where = "where",
    Is = "is",
    If = "if",
    Else = "else",
    Mut = "mut",
    For = "for",
    Break = "break",
    Continue = "continue",
    Return = "return",
    Use = "use",
    From = "from",
    None = "none",
    Match = "match",
    Pipe = "|",
    // In-place assignment operators
    PlusEqual = "+=",
    MinusEqual = "-=",
    StarEqual = "*=",
    SlashEqual = "/=",
    PercentEqual = "%=",
    SlashSlashEqual = "//=",
    PercentPercentEqual = "%%=",
    CaretEqual = "^=",
    // Literals
    True = "true",
    False = "false",
}

// Will store all tokens that have unique starting characters
export const SINGLE_CHAR_TOKENS = new Set<string>();
export const KEYWORDS = new Set<string>();
for (const tt of Object.values(TokenType)) {
    if (
        tt.length === 1 &&
        Object.values(TokenType).reduce((acc, x) => acc && (x === tt || x[0] !== tt), true)
    ) {
        SINGLE_CHAR_TOKENS.add(tt);
    } else if (/^[A-Za-z]+$/.test(tt)) {
        KEYWORDS.add(tt);
    }
}
// console.log("single char tokens", SINGLE_CHAR_TOKENS);
// console.log("keywords", KEYWORDS)

export const STRING_TO_TOKEN_MAP = Object.fromEntries(
    Object.values(TokenType).map((k) => [k, k as TokenType])
);

// console.log("string to token map", STRING_TO_TOKEN_MAP);

export interface Token {
    type: TokenType;
    text: string;
    line: number;
    col: number;
}
