/// Token types and the Token struct produced by the scanner.
use crate::source::Span;

/// Every kind of token the scanner can emit.
///
/// Most variants carry no data — the token's presence alone is enough.
/// Literals and identifiers carry their text value.
#[derive(Clone, Debug, PartialEq)]
pub enum TokenKind {
    // ── Identifiers ──
    Ident(String),

    // ── Literals ──
    /// Integer literal: `42i`.  The stored text is the numeric part
    /// only (the `i` suffix is stripped during scanning).
    Integer(String),
    /// Numeric (float) literal: `3.14`, `1e10`, `42.`
    Num(String),
    /// String literal content (without the surrounding quotes).
    Str(String),

    // ── Keywords ──
    Func,
    Struct,
    Trait,
    Enum,
    If,
    Else,
    Mut,
    For,
    Break,
    Continue,
    Return,
    Use,
    From,
    None,
    Match,
    Impl,
    True,
    False,
    And,
    Or,

    // ── Brackets / delimiters ──
    LParen,   // (
    RParen,   // )
    LBrace,   // {
    RBrace,   // }
    LBracket, // [
    RBracket, // ]

    // ── Punctuation ──
    Comma,      // ,
    Dot,        // .
    DotDot,     // ..
    Colon,      // :
    ColonColon, // ::
    Semicolon,  // ;
    Pipe,       // |

    // ── Single-character operators ──
    Bang,      // !
    Plus,      // +
    Minus,     // -
    Star,      // *
    Slash,     // /
    Percent,   // %
    Caret,     // ^
    At,        // @
    Backslash, // \

    // ── Two-character operators ──
    SlashSlash,     // //
    PercentPercent, // %%
    BangEqual,      // !=
    EqualEqual,     // ==
    Greater,        // >
    GreaterEqual,   // >=
    Less,           // <
    LessEqual,      // <=

    // ── Assignment operators ──
    Equal, // =

    // ── Sentinel ──
    /// Used by the scanner for truly unrecognizable input.
    Error,
    PlusEqual,           // +=
    MinusEqual,          // -=
    StarEqual,           // *=
    SlashEqual,          // /=
    PercentEqual,        // %=
    SlashSlashEqual,     // //=
    PercentPercentEqual, // %%=
    CaretEqual,          // ^=
}

/// A single token produced by the scanner.
#[derive(Clone, Debug, PartialEq)]
pub struct Token {
    pub kind: TokenKind,
    pub span: Span,
}

impl Token {
    pub fn new(kind: TokenKind, span: Span) -> Self {
        Self { kind, span }
    }

    /// The text of an identifier or literal token, if applicable.
    pub fn text(&self) -> Option<&str> {
        match &self.kind {
            TokenKind::Ident(s) | TokenKind::Integer(s) | TokenKind::Num(s) | TokenKind::Str(s) => {
                Some(s.as_str())
            }
            _ => Option::None,
        }
    }
}
