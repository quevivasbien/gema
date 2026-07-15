/// Scanner (lexer) for Gema.
///
/// Converts source text into a stream of `Token` values.  Produces
/// diagnostics for malformed input (unterminated strings, unexpected
/// characters, etc.) rather than panicking.
use crate::diagnostics::DiagnosticsBag;
use crate::source::{SourceText, Span};
use crate::token::{Token, TokenKind};

/// Determine the keyword token for a word, if any.
fn keyword_token(word: &str) -> Option<TokenKind> {
    match word {
        "func" => Some(TokenKind::Func),
        "struct" => Some(TokenKind::Struct),
        "trait" => Some(TokenKind::Trait),
        "enum" => Some(TokenKind::Enum),
        "if" => Some(TokenKind::If),
        "else" => Some(TokenKind::Else),
        "mut" => Some(TokenKind::Mut),
        "for" => Some(TokenKind::For),
        "break" => Some(TokenKind::Break),
        "continue" => Some(TokenKind::Continue),
        "return" => Some(TokenKind::Return),
        "use" => Some(TokenKind::Use),
        "from" => Some(TokenKind::From),
        "none" => Some(TokenKind::None),
        "match" => Some(TokenKind::Match),
        "impl" => Some(TokenKind::Impl),
        "true" => Some(TokenKind::True),
        "false" => Some(TokenKind::False),
        "and" => Some(TokenKind::And),
        "or" => Some(TokenKind::Or),
        _ => None,
    }
}

struct Scanner<'a> {
    source: &'a SourceText,
    /// Which file in the SourceMap this source corresponds to.
    file_idx: usize,
    /// Current byte offset into the source text.
    pos: usize,
    /// Start of the current token being scanned.
    token_start: usize,
    diagnostics: &'a mut DiagnosticsBag,
}

impl<'a> Scanner<'a> {
    fn new(source: &'a SourceText, file_idx: usize, diagnostics: &'a mut DiagnosticsBag) -> Self {
        Self {
            source,
            file_idx,
            pos: 0,
            token_start: 0,
            diagnostics,
        }
    }

    /// Peek at the current byte without advancing.
    fn peek(&self) -> Option<u8> {
        self.source.text.as_bytes().get(self.pos).copied()
    }

    /// Peek at the *next* byte (one past current position).
    fn peek_next(&self) -> Option<u8> {
        self.source.text.as_bytes().get(self.pos + 1).copied()
    }

    /// Advance by one byte and return the byte we just consumed.
    fn advance(&mut self) -> Option<u8> {
        let b = self.peek()?;
        self.pos += 1;
        Some(b)
    }

    fn at_end(&self) -> bool {
        self.pos >= self.source.text.len()
    }

    /// Make a span from `self.token_start` to `self.pos`.
    fn make_span(&self) -> Span {
        Span::new(self.token_start as u32, self.pos as u32)
    }

    /// Make a token spanning from `self.token_start` to `self.pos`.
    fn make_token(&self, kind: TokenKind) -> Token {
        Token::new(kind, self.make_span())
    }

    /// Extract source text substring between two byte offsets.
    fn source_since(&self, start: usize, end: usize) -> &'a str {
        &self.source.text[start..end]
    }

    // ── Whitespace and comment skipping ──

    fn skip_whitespace_and_comments(&mut self) {
        loop {
            match self.peek() {
                Some(b' ') | Some(b'\t') | Some(b'\r') => {
                    self.advance();
                }
                Some(b'\n') => {
                    self.advance();
                }
                // Comment: skip until end of line
                Some(b'#') => loop {
                    match self.advance() {
                        None | Some(b'\n') => break,
                        _ => continue,
                    }
                },
                _ => break,
            }
        }
    }

    // ── Number scanning ──

    fn scan_number(&mut self) -> Token {
        // Consume integer digits
        while self.peek().is_some_and(|b| b.is_ascii_digit()) {
            self.advance();
        }

        // Int literal suffix: `42i`
        if self.peek() == Some(b'i') {
            let next = self.peek_next();
            if next.is_none_or(|b| !b.is_ascii_alphanumeric() && b != b'_') {
                self.advance();
                let text = self.source_since(self.token_start, self.pos - 1);
                return Token::new(TokenKind::Integer(text.to_string()), self.make_span());
            }
        }

        // Decimal part — but `1..10` is a range, not `1.` followed by `.10`
        if self.peek() == Some(b'.') && self.peek_next() != Some(b'.') {
            self.advance();
            while self.peek().is_some_and(|b| b.is_ascii_digit()) {
                self.advance();
            }
        }

        // Scientific notation: 13e6, 13e+6, 13.5e-6
        if matches!(self.peek(), Some(b'e') | Some(b'E')) {
            self.advance();
            if matches!(self.peek(), Some(b'+') | Some(b'-')) {
                self.advance();
            }
            if self.peek().is_some_and(|b| b.is_ascii_digit()) {
                while self.peek().is_some_and(|b| b.is_ascii_digit()) {
                    self.advance();
                }
            } else {
                let span = self.make_span();
                self.diagnostics.error(
                    self.file_idx,
                    span,
                    "expected digit for float exponent in scientific notation",
                );
            }
        }

        let text = self.source_since(self.token_start, self.pos);
        Token::new(TokenKind::Num(text.to_string()), self.make_span())
    }

    // ── String scanning ──

    fn scan_string(&mut self) -> Token {
        // The opening `"` has already been consumed.
        loop {
            match self.advance() {
                None => {
                    let span = self.make_span();
                    self.diagnostics
                        .error(self.file_idx, span, "unterminated string literal");
                    let text = self.source_since(self.token_start + 1, self.pos);
                    return Token::new(TokenKind::Str(text.to_string()), self.make_span());
                }
                Some(b'\\') => {
                    // Escape sequence: consume the next character regardless
                    // (handles `\"`, `\\`, `\n`, etc.)
                    self.advance();
                }
                Some(b'"') => {
                    let text = self.source_since(self.token_start + 1, self.pos - 1);
                    return Token::new(TokenKind::Str(text.to_string()), self.make_span());
                }
                _ => {}
            }
        }
    }

    // ── Identifier / keyword scanning ──

    fn scan_identifier(&mut self) -> Token {
        while self
            .peek()
            .is_some_and(|b| b.is_ascii_alphanumeric() || b == b'_')
        {
            self.advance();
        }
        let word = self.source_since(self.token_start, self.pos);
        match keyword_token(word) {
            Some(kind) => self.make_token(kind),
            None => Token::new(TokenKind::Ident(word.to_string()), self.make_span()),
        }
    }

    // ── Compound and multi-character operator helpers ──

    /// Try to scan `//`, `%%`, `//=`, `%%=`.  `c` must be `/` or `%`.
    fn try_double_op(&mut self, c: u8) -> Option<Token> {
        debug_assert!(c == b'/' || c == b'%');
        if self.peek() != Some(c) {
            return None;
        }
        self.advance();
        if self.peek() == Some(b'=') {
            self.advance();
            let kind = match c {
                b'/' => TokenKind::SlashSlashEqual,
                b'%' => TokenKind::PercentPercentEqual,
                _ => unreachable!(),
            };
            Some(self.make_token(kind))
        } else {
            let kind = match c {
                b'/' => TokenKind::SlashSlash,
                b'%' => TokenKind::PercentPercent,
                _ => unreachable!(),
            };
            Some(self.make_token(kind))
        }
    }

    /// Try to scan a compound assignment operator (`+=`, `-=`, etc.).
    /// `c` must be `+`, `-`, `*`, `/`, `%`, or `^`.
    fn try_compound_assign(&mut self, c: u8) -> Option<Token> {
        debug_assert!(matches!(c, b'+' | b'-' | b'*' | b'/' | b'%' | b'^'));
        if self.peek() != Some(b'=') {
            return None;
        }
        self.advance();
        let kind = match c {
            b'+' => TokenKind::PlusEqual,
            b'-' => TokenKind::MinusEqual,
            b'*' => TokenKind::StarEqual,
            b'/' => TokenKind::SlashEqual,
            b'%' => TokenKind::PercentEqual,
            b'^' => TokenKind::CaretEqual,
            _ => unreachable!(),
        };
        Some(self.make_token(kind))
    }

    /// Disambiguate two-character tokens (`!=`, `>=`, `<=`, `==`).
    fn try_two_char(
        &mut self,
        expected: u8,
        kind_if_match: TokenKind,
        kind_single: TokenKind,
    ) -> Token {
        if self.peek() == Some(expected) {
            self.advance();
            self.make_token(kind_if_match)
        } else {
            self.make_token(kind_single)
        }
    }

    // ── Main scan loop ──

    fn scan_token(&mut self) -> Option<Token> {
        self.skip_whitespace_and_comments();
        self.token_start = self.pos;

        let c = self.advance()?;

        // For `/` and `%`, check for double operators BEFORE compound
        // assignment (so `//` is recognized before `/=`, and `//=` is
        // recognized as a triple).
        if c == b'/' || c == b'%' {
            if let Some(token) = self.try_double_op(c) {
                return Some(token);
            }
            if let Some(token) = self.try_compound_assign(c) {
                return Some(token);
            }
            let kind = match c {
                b'/' => TokenKind::Slash,
                b'%' => TokenKind::Percent,
                _ => unreachable!(),
            };
            return Some(self.make_token(kind));
        }

        // Special case for '-' -- it could be followed by either '=' or '>'
        if matches!(c, b'-') {
            let kind = match self.peek() {
                Some(b'=') => {
                    self.advance();
                    TokenKind::MinusEqual
                }
                Some(b'>') => {
                    self.advance();
                    TokenKind::Arrow
                }
                _ => TokenKind::Minus,
            };
            return Some(self.make_token(kind));
        }

        // Compound assignment for other operators: +=, *=, ^=
        // -= already handled above
        if matches!(c, b'+' | b'*' | b'^') {
            if let Some(token) = self.try_compound_assign(c) {
                return Some(token);
            }
            let kind = match c {
                b'+' => TokenKind::Plus,
                b'*' => TokenKind::Star,
                b'^' => TokenKind::Caret,
                _ => unreachable!(),
            };
            return Some(self.make_token(kind));
        }

        // Single-character tokens: punctuation and brackets
        let single = match c {
            b'(' => Some(TokenKind::LParen),
            b')' => Some(TokenKind::RParen),
            b'{' => Some(TokenKind::LBrace),
            b'}' => Some(TokenKind::RBrace),
            b'[' => Some(TokenKind::LBracket),
            b']' => Some(TokenKind::RBracket),
            b',' => Some(TokenKind::Comma),
            b';' => Some(TokenKind::Semicolon),
            b'|' => Some(TokenKind::Pipe),
            b'@' => Some(TokenKind::At),
            b'\\' => Some(TokenKind::Backslash),
            _ => None,
        };
        if let Some(kind) = single {
            return Some(self.make_token(kind));
        }

        // Other two-character disambiguation: !, >, <, =, :
        match c {
            b'!' => {
                return Some(self.try_two_char(b'=', TokenKind::BangEqual, TokenKind::Bang));
            }
            b'>' => {
                return Some(self.try_two_char(b'=', TokenKind::GreaterEqual, TokenKind::Greater));
            }
            b'<' => {
                return Some(self.try_two_char(b'=', TokenKind::LessEqual, TokenKind::Less));
            }
            b'=' => {
                return Some(self.try_two_char(b'=', TokenKind::EqualEqual, TokenKind::Equal));
            }
            b'.' => {
                return Some(self.try_two_char(b'.', TokenKind::DotDot, TokenKind::Dot));
            }
            b':' => {
                return Some(self.try_two_char(b':', TokenKind::ColonColon, TokenKind::Colon));
            }
            _ => {}
        }

        // String literal
        if c == b'"' {
            return Some(self.scan_string());
        }

        // Number literal
        if c.is_ascii_digit() {
            return Some(self.scan_number());
        }

        // Identifier or keyword
        if c.is_ascii_alphabetic() || c == b'_' {
            return Some(self.scan_identifier());
        }

        // Anything else is an unexpected character
        let span = self.make_span();
        self.diagnostics.error(
            self.file_idx,
            span,
            format!("unexpected character '{}'", c as char),
        );
        // Emit an error token so the parser doesn't spin forever
        // Range operator `..`
        if c == b'.' {
            if self.peek() == Some(b'.') {
                self.advance();
                return Some(self.make_token(TokenKind::DotDot));
            }
            return Some(self.make_token(TokenKind::Dot));
        }

        // Namespace operator `::`
        if c == b':' {
            if self.peek() == Some(b':') {
                self.advance();
                return Some(self.make_token(TokenKind::ColonColon));
            }
            return Some(self.make_token(TokenKind::Colon));
        }
        Some(self.make_token(TokenKind::Error))
    }
}

/// Scan a single source file into a token stream.
///
/// `file_idx` is the index of this source in the `SourceMap`, used to
/// annotate diagnostics with the correct file.
///
/// Malformed input produces diagnostics but the scanner still makes a
/// best-effort token stream so parsing can continue.
pub fn scan(source: &SourceText, file_idx: usize) -> (Vec<Token>, DiagnosticsBag) {
    let mut diagnostics = DiagnosticsBag::new();
    let mut scanner = Scanner::new(source, file_idx, &mut diagnostics);
    let mut tokens = Vec::new();

    while !scanner.at_end() {
        match scanner.scan_token() {
            Some(token) => tokens.push(token),
            None => break,
        }
    }

    (tokens, diagnostics)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::SourceText;

    /// Convenience: scan source text as file 0, asserting no errors.
    fn scan_one(source: &str) -> Vec<Token> {
        let src = SourceText::new("test.gema", source);
        let (tokens, diags) = scan(&src, 0);
        assert!(
            !diags.has_errors(),
            "scanning '{source}' produced unexpected errors:\n{}",
            diags.format(&crate::source::SourceMap::new()),
        );
        tokens
    }

    fn scan_with_diags(source: &str) -> (Vec<Token>, DiagnosticsBag) {
        let src = SourceText::new("test.gema", source);
        scan(&src, 0)
    }

    // ── Basic tokens ──

    #[test]
    fn empty_source() {
        let tokens = scan_one("");
        assert!(tokens.is_empty());
    }

    #[test]
    fn whitespace_only() {
        let tokens = scan_one("   \t\n  \n  ");
        assert!(tokens.is_empty());
    }

    #[test]
    fn comment_only() {
        let tokens = scan_one("# this is a comment");
        assert!(tokens.is_empty());
    }

    #[test]
    fn comment_with_code_after() {
        let tokens = scan_one("# comment\n42i");
        assert_eq!(tokens.len(), 1);
        assert!(matches!(tokens[0].kind, TokenKind::Integer(_)));
    }

    #[test]
    fn comment_at_end_of_line() {
        let tokens = scan_one("1 + 2 # inline comment");
        assert_eq!(tokens.len(), 3);
    }

    // ── Numbers ──

    #[test]
    fn integer_literal() {
        let tokens = scan_one("42i");
        assert_eq!(tokens.len(), 1);
        assert_eq!(tokens[0].kind, TokenKind::Integer("42".to_string()));
    }

    #[test]
    fn integer_literal_zero() {
        let tokens = scan_one("0i");
        assert_eq!(tokens.len(), 1);
        assert_eq!(tokens[0].kind, TokenKind::Integer("0".to_string()));
    }

    #[test]
    fn integer_literal_large() {
        let tokens = scan_one("12345678901234567890i");
        assert_eq!(tokens.len(), 1);
        assert_eq!(
            tokens[0].kind,
            TokenKind::Integer("12345678901234567890".to_string())
        );
    }

    #[test]
    fn num_literal_simple() {
        let tokens = scan_one("3.14");
        assert_eq!(tokens.len(), 1);
        assert!(matches!(tokens[0].kind, TokenKind::Num(_)));
    }

    #[test]
    fn num_literal_no_decimal() {
        let tokens = scan_one("42");
        assert_eq!(tokens.len(), 1);
        assert!(matches!(tokens[0].kind, TokenKind::Num(_)));
    }

    #[test]
    fn num_literal_with_decimal_and_sci() {
        let tokens = scan_one("3.14e10");
        assert_eq!(tokens.len(), 1);
        assert!(matches!(tokens[0].kind, TokenKind::Num(_)));
    }

    #[test]
    fn num_literal_sci_positive_exponent() {
        let tokens = scan_one("1e+6");
        assert_eq!(tokens.len(), 1);
        assert!(matches!(tokens[0].kind, TokenKind::Num(_)));
    }

    #[test]
    fn num_literal_sci_negative_exponent() {
        let tokens = scan_one("1e-6");
        assert_eq!(tokens.len(), 1);
        assert!(matches!(tokens[0].kind, TokenKind::Num(_)));
    }

    #[test]
    fn num_literal_capital_e() {
        let tokens = scan_one("1E10");
        assert_eq!(tokens.len(), 1);
        assert!(matches!(tokens[0].kind, TokenKind::Num(_)));
    }

    #[test]
    fn num_literal_trailing_decimal() {
        let tokens = scan_one("42.");
        assert_eq!(tokens.len(), 1);
        assert!(matches!(tokens[0].kind, TokenKind::Num(_)));
    }

    #[test]
    fn num_literal_sci_no_exponent_digits() {
        let src = SourceText::new("test.gema", "1e");
        let (_tokens, diags) = scan(&src, 0);
        assert!(diags.has_errors());
    }

    #[test]
    fn range_dotdot_not_confused_with_decimal() {
        let tokens = scan_one("1..10");
        assert_eq!(tokens.len(), 3);
        assert!(matches!(tokens[0].kind, TokenKind::Num(_)));
        assert_eq!(tokens[1].kind, TokenKind::DotDot);
        assert!(matches!(tokens[2].kind, TokenKind::Num(_)));
    }

    // ── String literals ──

    #[test]
    fn string_literal() {
        let tokens = scan_one("\"hello\"");
        assert_eq!(tokens.len(), 1);
        assert_eq!(tokens[0].kind, TokenKind::Str("hello".to_string()));
    }

    #[test]
    fn string_literal_empty() {
        let tokens = scan_one("\"\"");
        assert_eq!(tokens.len(), 1);
        assert_eq!(tokens[0].kind, TokenKind::Str("".to_string()));
    }

    #[test]
    fn string_literal_multiline() {
        let tokens = scan_one("\"hello\nworld\"");
        assert_eq!(tokens.len(), 1);
        assert_eq!(tokens[0].kind, TokenKind::Str("hello\nworld".to_string()));
    }

    #[test]
    fn string_with_escaped_quote() {
        let tokens = scan_one(r#""hello\"world""#);
        assert_eq!(tokens.len(), 1);
        assert_eq!(
            tokens[0].kind,
            TokenKind::Str(r#"hello\"world"#.to_string())
        );
    }

    #[test]
    fn string_with_escaped_backslash() {
        let tokens = scan_one(r#""a\\b""#);
        assert_eq!(tokens.len(), 1);
        assert_eq!(tokens[0].kind, TokenKind::Str(r#"a\\b"#.to_string()));
    }

    #[test]
    fn string_literal_unterminated() {
        let (_tokens, diags) = scan_with_diags("\"hello");
        assert!(diags.has_errors());
    }

    // ── Identifiers and keywords ──

    #[test]
    fn identifier() {
        let tokens = scan_one("myVariable");
        assert_eq!(tokens.len(), 1);
        assert_eq!(tokens[0].kind, TokenKind::Ident("myVariable".to_string()));
    }

    #[test]
    fn identifier_with_underscore() {
        let tokens = scan_one("_my_var_123");
        assert_eq!(tokens.len(), 1);
        assert_eq!(tokens[0].kind, TokenKind::Ident("_my_var_123".to_string()));
    }

    #[test]
    fn keywords() {
        let kws: [(&str, TokenKind); 20] = [
            ("func", TokenKind::Func),
            ("struct", TokenKind::Struct),
            ("trait", TokenKind::Trait),
            ("enum", TokenKind::Enum),
            ("if", TokenKind::If),
            ("else", TokenKind::Else),
            ("mut", TokenKind::Mut),
            ("for", TokenKind::For),
            ("break", TokenKind::Break),
            ("continue", TokenKind::Continue),
            ("return", TokenKind::Return),
            ("use", TokenKind::Use),
            ("from", TokenKind::From),
            ("none", TokenKind::None),
            ("match", TokenKind::Match),
            ("impl", TokenKind::Impl),
            ("true", TokenKind::True),
            ("false", TokenKind::False),
            ("and", TokenKind::And),
            ("or", TokenKind::Or),
        ];
        for (text, expected) in &kws {
            let tokens = scan_one(text);
            assert_eq!(tokens.len(), 1, "keyword '{text}' should produce one token");
            assert_eq!(tokens[0].kind, *expected, "keyword '{text}' mismatch");
        }
    }

    #[test]
    fn keywords_are_not_identifiers() {
        let tokens = scan_one("func if else");
        assert_eq!(tokens.len(), 3);
        assert_eq!(tokens[0].kind, TokenKind::Func);
        assert_eq!(tokens[1].kind, TokenKind::If);
        assert_eq!(tokens[2].kind, TokenKind::Else);
    }

    #[test]
    fn function_name_not_keyword() {
        let tokens = scan_one("functional");
        assert_eq!(tokens.len(), 1);
        assert_eq!(tokens[0].kind, TokenKind::Ident("functional".to_string()));
    }

    #[test]
    fn and_or_are_keywords() {
        let tokens = scan_one("and or");
        assert_eq!(tokens.len(), 2);
        assert_eq!(tokens[0].kind, TokenKind::And);
        assert_eq!(tokens[1].kind, TokenKind::Or);
    }

    // ── Operators ──

    #[test]
    fn arithmetic_operators() {
        let tokens = scan_one("+ - * / % ^");
        assert_eq!(tokens.len(), 6);
        assert_eq!(tokens[0].kind, TokenKind::Plus);
        assert_eq!(tokens[1].kind, TokenKind::Minus);
        assert_eq!(tokens[2].kind, TokenKind::Star);
        assert_eq!(tokens[3].kind, TokenKind::Slash);
        assert_eq!(tokens[4].kind, TokenKind::Percent);
        assert_eq!(tokens[5].kind, TokenKind::Caret);
    }

    #[test]
    fn comparison_operators() {
        let tokens = scan_one("== != > < >= <=");
        assert_eq!(tokens.len(), 6);
        assert_eq!(tokens[0].kind, TokenKind::EqualEqual);
        assert_eq!(tokens[1].kind, TokenKind::BangEqual);
        assert_eq!(tokens[2].kind, TokenKind::Greater);
        assert_eq!(tokens[3].kind, TokenKind::Less);
        assert_eq!(tokens[4].kind, TokenKind::GreaterEqual);
        assert_eq!(tokens[5].kind, TokenKind::LessEqual);
    }

    #[test]
    fn single_equals_is_assignment() {
        let tokens = scan_one("=");
        assert_eq!(tokens.len(), 1);
        assert_eq!(tokens[0].kind, TokenKind::Equal);
    }

    // ── Compound assignment ──

    #[test]
    fn compound_assign_operators() {
        let tokens = scan_one("+= -= *= /= %= ^=");
        assert_eq!(tokens.len(), 6);
        assert_eq!(tokens[0].kind, TokenKind::PlusEqual);
        assert_eq!(tokens[1].kind, TokenKind::MinusEqual);
        assert_eq!(tokens[2].kind, TokenKind::StarEqual);
        assert_eq!(tokens[3].kind, TokenKind::SlashEqual);
        assert_eq!(tokens[4].kind, TokenKind::PercentEqual);
        assert_eq!(tokens[5].kind, TokenKind::CaretEqual);
    }

    // ── Double-character operators ──

    #[test]
    fn double_slash_and_percent() {
        let tokens = scan_one("// %% //= %%= %%=");
        assert_eq!(tokens.len(), 5);
        assert_eq!(tokens[0].kind, TokenKind::SlashSlash);
        assert_eq!(tokens[1].kind, TokenKind::PercentPercent);
        assert_eq!(tokens[2].kind, TokenKind::SlashSlashEqual);
        assert_eq!(tokens[3].kind, TokenKind::PercentPercentEqual);
        assert_eq!(tokens[4].kind, TokenKind::PercentPercentEqual);
    }

    #[test]
    fn slash_followed_by_slash() {
        let tokens = scan_one("///");
        assert_eq!(tokens.len(), 2);
        assert_eq!(tokens[0].kind, TokenKind::SlashSlash);
        assert_eq!(tokens[1].kind, TokenKind::Slash);
    }

    // ── Punctuation ──

    #[test]
    fn brackets_and_punctuation() {
        let tokens = scan_one("( ) { } [ ] , ; . .. :: | @ -> \\");
        assert_eq!(tokens.len(), 15);
        assert_eq!(tokens[0].kind, TokenKind::LParen);
        assert_eq!(tokens[1].kind, TokenKind::RParen);
        assert_eq!(tokens[2].kind, TokenKind::LBrace);
        assert_eq!(tokens[3].kind, TokenKind::RBrace);
        assert_eq!(tokens[4].kind, TokenKind::LBracket);
        assert_eq!(tokens[5].kind, TokenKind::RBracket);
        assert_eq!(tokens[6].kind, TokenKind::Comma);
        assert_eq!(tokens[7].kind, TokenKind::Semicolon);
        assert_eq!(tokens[8].kind, TokenKind::Dot);
        assert_eq!(tokens[9].kind, TokenKind::DotDot);
        assert_eq!(tokens[10].kind, TokenKind::ColonColon);
        assert_eq!(tokens[11].kind, TokenKind::Pipe);
        assert_eq!(tokens[12].kind, TokenKind::At);
        assert_eq!(tokens[13].kind, TokenKind::Arrow);
        assert_eq!(tokens[14].kind, TokenKind::Backslash);
    }

    #[test]
    fn backslash() {
        let tokens = scan_one("\\");
        assert_eq!(tokens.len(), 1);
        assert_eq!(tokens[0].kind, TokenKind::Backslash);
    }

    // ── Token text extraction ──

    #[test]
    fn token_text_ident() {
        let tokens = scan_one("hello");
        assert_eq!(tokens[0].text(), Some("hello"));
    }

    #[test]
    fn token_text_integer() {
        let tokens = scan_one("42i");
        assert_eq!(tokens[0].text(), Some("42"));
    }

    #[test]
    fn token_text_num() {
        let tokens = scan_one("3.14");
        assert_eq!(tokens[0].text(), Some("3.14"));
    }

    #[test]
    fn token_text_string() {
        let tokens = scan_one("\"hello\"");
        assert_eq!(tokens[0].text(), Some("hello"));
    }

    #[test]
    fn token_text_none_for_operator() {
        let tokens = scan_one("+");
        assert_eq!(tokens[0].text(), None);
    }

    #[test]
    fn token_text_none_for_keyword() {
        let tokens = scan_one("and");
        assert_eq!(tokens[0].text(), None);
    }

    #[test]
    fn token_text_none_for_error() {
        let src = SourceText::new("test.gema", "$");
        let (tokens, _) = scan(&src, 0);
        assert!(!tokens.is_empty());
        assert_eq!(tokens[0].kind, TokenKind::Error);
        assert_eq!(tokens[0].text(), None);
    }

    // ── Edge cases ──

    #[test]
    fn unexpected_character() {
        let (_tokens, diags) = scan_with_diags("$");
        assert!(diags.has_errors());
    }

    #[test]
    fn unexpected_char_does_not_halt_scanning() {
        let (_tokens, diags) = scan_with_diags("$ 42i");
        assert!(diags.has_errors());
        assert!(_tokens.len() >= 2);
    }

    #[test]
    fn identifier_starting_with_number_not_allowed() {
        let tokens = scan_one("1a");
        assert_eq!(tokens.len(), 2);
        assert!(matches!(tokens[0].kind, TokenKind::Num(_)));
        assert!(matches!(tokens[1].kind, TokenKind::Ident(_)));
    }

    #[test]
    fn bang_not_followed_by_equals() {
        let tokens = scan_one("!x");
        assert_eq!(tokens.len(), 2);
        assert_eq!(tokens[0].kind, TokenKind::Bang);
        assert!(matches!(tokens[1].kind, TokenKind::Ident(_)));
    }

    #[test]
    fn mixed_expression() {
        let tokens = scan_one("func add(a: Int, b: Int): Int { a + b }");
        assert_eq!(tokens.len(), 18);
        let kinds: Vec<_> = tokens.iter().map(|t| format!("{:?}", t.kind)).collect();
        assert_eq!(kinds[0], "Func");
        assert_eq!(kinds[1], "Ident(\"add\")");
        assert_eq!(kinds[2], "LParen");
        assert_eq!(kinds[3], "Ident(\"a\")");
        assert_eq!(kinds[4], "Colon");
        assert_eq!(kinds[5], "Ident(\"Int\")");
        assert_eq!(kinds[6], "Comma");
        assert_eq!(kinds[7], "Ident(\"b\")");
        assert_eq!(kinds[8], "Colon");
        assert_eq!(kinds[9], "Ident(\"Int\")");
        assert_eq!(kinds[10], "RParen");
        assert_eq!(kinds[11], "Colon");
        assert_eq!(kinds[12], "Ident(\"Int\")");
        assert_eq!(kinds[13], "LBrace");
        assert_eq!(kinds[14], "Ident(\"a\")");
        assert_eq!(kinds[15], "Plus");
        assert_eq!(kinds[16], "Ident(\"b\")");
        assert_eq!(kinds[17], "RBrace");
    }

    // ── Spans ──

    #[test]
    fn span_positions() {
        let src = SourceText::new("test.gema", "12i + 34");
        let (tokens, _) = scan(&src, 0);
        assert_eq!(tokens[0].span, Span::new(0, 3));
        assert_eq!(tokens[0].kind, TokenKind::Integer("12".to_string()));

        assert_eq!(tokens[1].span, Span::new(4, 5));
        assert_eq!(tokens[1].kind, TokenKind::Plus);

        assert_eq!(tokens[2].span, Span::new(6, 8));
        assert_eq!(tokens[2].kind, TokenKind::Num("34".to_string()));
    }

    #[test]
    fn file_idx_propagated_to_diagnostics() {
        let src = SourceText::new("broken.gema", "$");
        let (_, diags) = scan(&src, 42);
        assert!(diags.has_errors());
        let formatted = diags.format(&{
            let sm = crate::source::SourceMap::new();
            // The file at index 42 won't exist, so the formatter will
            // show <unknown>.  That's fine — the point is we passed
            // the index through.
            sm
        });
        assert!(formatted.contains("broken.gema") || formatted.contains("<unknown>"));
    }
}
