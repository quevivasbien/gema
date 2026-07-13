// ---------------------------------------------------------------------------
// Precedence levels
// ---------------------------------------------------------------------------

use crate::token::TokenKind;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Precedence {
    None,
    Assignment,
    Pipe,
    Or,
    And,
    Range,
    Comparison,
    Term,
    Factor,
    Unary,
    Exponent,
    Call,
}

// ---------------------------------------------------------------------------
// Infix precedence lookup
// ---------------------------------------------------------------------------

pub fn token_precedence(kind: &TokenKind) -> Option<Precedence> {
    match kind {
        TokenKind::Equal
        | TokenKind::PlusEqual
        | TokenKind::MinusEqual
        | TokenKind::StarEqual
        | TokenKind::SlashEqual
        | TokenKind::SlashSlashEqual
        | TokenKind::PercentEqual
        | TokenKind::PercentPercentEqual
        | TokenKind::CaretEqual => Some(Precedence::Assignment),

        TokenKind::Pipe => Some(Precedence::Pipe),
        TokenKind::Or => Some(Precedence::Or),
        TokenKind::And => Some(Precedence::And),

        TokenKind::DotDot => Some(Precedence::Range),

        TokenKind::EqualEqual
        | TokenKind::BangEqual
        | TokenKind::Less
        | TokenKind::LessEqual
        | TokenKind::Greater
        | TokenKind::GreaterEqual => Some(Precedence::Comparison),

        TokenKind::Plus | TokenKind::Minus => Some(Precedence::Term),

        TokenKind::Star
        | TokenKind::Slash
        | TokenKind::Percent
        | TokenKind::SlashSlash
        | TokenKind::PercentPercent => Some(Precedence::Factor),

        TokenKind::Caret => Some(Precedence::Exponent),

        TokenKind::LParen | TokenKind::Dot | TokenKind::LBracket | TokenKind::ColonColon => {
            Some(Precedence::Call)
        }

        _ => None,
    }
}
