use crate::{ast::BinaryOp, token::TokenKind};

pub fn compound_op(kind: &TokenKind) -> Option<BinaryOp> {
    match kind {
        TokenKind::PlusEqual => Some(BinaryOp::Add),
        TokenKind::MinusEqual => Some(BinaryOp::Sub),
        TokenKind::StarEqual => Some(BinaryOp::Mul),
        TokenKind::SlashEqual => Some(BinaryOp::Div),
        TokenKind::SlashSlashEqual => Some(BinaryOp::IntDiv),
        TokenKind::PercentEqual => Some(BinaryOp::Mod),
        TokenKind::PercentPercentEqual => Some(BinaryOp::EucMod),
        TokenKind::CaretEqual => Some(BinaryOp::Pow),
        _ => None,
    }
}

pub fn token_to_binary_op(kind: &TokenKind) -> BinaryOp {
    match kind {
        TokenKind::Plus => BinaryOp::Add,
        TokenKind::Minus => BinaryOp::Sub,
        TokenKind::Star => BinaryOp::Mul,
        TokenKind::Slash => BinaryOp::Div,
        TokenKind::SlashSlash => BinaryOp::IntDiv,
        TokenKind::Percent => BinaryOp::Mod,
        TokenKind::PercentPercent => BinaryOp::EucMod,
        TokenKind::Caret => BinaryOp::Pow,
        TokenKind::EqualEqual => BinaryOp::Eq,
        TokenKind::BangEqual => BinaryOp::Ne,
        TokenKind::Less => BinaryOp::Lt,
        TokenKind::LessEqual => BinaryOp::Le,
        TokenKind::Greater => BinaryOp::Gt,
        TokenKind::GreaterEqual => BinaryOp::Ge,
        TokenKind::And => BinaryOp::And,
        TokenKind::Or => BinaryOp::Or,
        _ => unreachable!(),
    }
}
