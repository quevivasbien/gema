/// Pratt parser for Gema.
///
/// Parses a token stream into an `AstArena` of `Expr` nodes.
/// Produces diagnostics for syntax errors but always returns a
/// best-effort AST (with `ErrorExpr` sentinels where needed).
use crate::ast::*;
use crate::diagnostics::DiagnosticsBag;
use crate::interner::{IdentId, Interner};
use crate::source::Span;
use crate::token::{Token, TokenKind};

// ---------------------------------------------------------------------------
// Precedence levels
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
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

// ---------------------------------------------------------------------------
// Compound operator table
// ---------------------------------------------------------------------------

fn compound_op(kind: &TokenKind) -> Option<BinaryOp> {
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

// ---------------------------------------------------------------------------
// Infix precedence lookup
// ---------------------------------------------------------------------------

fn token_precedence(kind: &TokenKind) -> Option<Precedence> {
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

        TokenKind::EqualEqual | TokenKind::BangEqual => Some(Precedence::Equality),
        TokenKind::DotDot => Some(Precedence::Range),

        TokenKind::Less | TokenKind::LessEqual | TokenKind::Greater | TokenKind::GreaterEqual => {
            Some(Precedence::Comparison)
        }

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

// ---------------------------------------------------------------------------
// Operator-to-BinaryOp mapping
// ---------------------------------------------------------------------------

fn token_to_binary_op(kind: &TokenKind) -> BinaryOp {
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

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

pub struct Parser<'a> {
    tokens: &'a [Token],
    pos: usize,
    arena: &'a mut AstArena,
    interner: &'a mut Interner,
    diagnostics: &'a mut DiagnosticsBag,
    file_idx: usize,
}

/// Helper for extracting assignment target data from the arena
/// without holding a borrow across mutable operations.
enum AssignResult {
    Var {
        name: IdentId,
        span: Span,
    },
    Field {
        obj: NodeId,
        field: IdentId,
        span: Span,
    },
    Error,
}

fn extract_assign_target(arena: &AstArena, target: NodeId) -> AssignResult {
    match &arena[target] {
        Expr::Var(v) => AssignResult::Var {
            name: v.name,
            span: v.span,
        },
        Expr::FieldAccess(fa) => AssignResult::Field {
            obj: fa.obj,
            field: fa.field,
            span: fa.span,
        },
        _ => AssignResult::Error,
    }
}

impl<'a> Parser<'a> {
    pub fn new(
        tokens: &'a [Token],
        arena: &'a mut AstArena,
        interner: &'a mut Interner,
        diagnostics: &'a mut DiagnosticsBag,
        file_idx: usize,
    ) -> Self {
        Self {
            tokens,
            pos: 0,
            arena,
            interner,
            diagnostics,
            file_idx,
        }
    }

    pub fn finish(mut self) -> NodeId {
        // Top-level block — no surrounding braces.
        let mut stmts: Vec<NodeId> = Vec::new();

        while !self.at_end() {
            // Skip stray semicolons
            if self.consume_semi() {
                continue;
            }

            let stmt = self.parse_block_statement();
            match stmt {
                Some(id) => {
                    let is_item = matches!(
                        self.arena[id],
                        Expr::FuncDef(_)
                            | Expr::StructDef(_)
                            | Expr::EnumDef(_)
                            | Expr::TraitDef(_)
                            | Expr::ImplBlock(_)
                    );

                    if is_item {
                        self.consume_semi();
                        stmts.push(id);
                        continue;
                    }

                    let has_semi = self.consume_semi();
                    let at_end = self.at_end();

                    if has_semi || !at_end {
                        stmts.push(self.alloc(Expr::DropValue(DropValue {
                            span: self.span_of(id),
                            child: id,
                        })));
                    } else {
                        stmts.push(id);
                    }
                }
                None => {
                    self.recover_to_boundary();
                }
            }
        }

        let end_span = if self.pos > 0 {
            self.previous().span
        } else {
            Span::new(0, 0)
        };
        self.alloc(Expr::Block(Block {
            span: Span::new(0, end_span.end),
            stmts,
        }))
    }

    // ── Token helpers ──

    fn at_end(&self) -> bool {
        self.pos >= self.tokens.len()
    }

    fn peek(&self) -> &Token {
        &self.tokens[self.pos]
    }

    fn next(&self, offset: usize) -> Option<&Token> {
        self.tokens.get(self.pos + offset)
    }

    fn peek_kind(&self) -> &TokenKind {
        &self.peek().kind
    }

    fn previous(&self) -> &Token {
        &self.tokens[self.pos - 1]
    }

    fn advance(&mut self) -> Token {
        let t = self.tokens[self.pos].clone();
        self.pos += 1;
        t
    }

    /// Consume the current token if its kind matches the pattern
    /// (by discriminant — ignores data-carrying variants).
    fn consume_discriminant(&mut self, expected: &TokenKind) -> bool {
        if self.at_end() {
            return false;
        }
        if std::mem::discriminant(self.peek_kind()) == std::mem::discriminant(expected) {
            self.advance();
            true
        } else {
            false
        }
    }

    fn consume_semi(&mut self) -> bool {
        self.consume_discriminant(&TokenKind::Semicolon)
    }

    fn consume_comma(&mut self) -> bool {
        self.consume_discriminant(&TokenKind::Comma)
    }

    /// Check if the current token matches an operator kind that is
    /// a compound assignment.
    fn check_compound(&self) -> Option<BinaryOp> {
        if self.at_end() {
            return None;
        }
        compound_op(self.peek_kind())
    }

    // ── Utilities ──

    fn alloc(&mut self, expr: Expr) -> NodeId {
        self.arena.alloc(expr)
    }

    fn span_of(&self, id: NodeId) -> Span {
        self.arena[id].span()
    }

    fn intern_str(&mut self, s: &str) -> IdentId {
        self.interner.intern(s)
    }

    // ── Diagnostics ──

    fn error_raw(&mut self, span: Span, msg: impl Into<String>) {
        self.diagnostics.error(self.file_idx, span, msg);
    }

    fn error_here(&mut self, msg: impl Into<String>) {
        self.error_raw(self.peek().span, msg);
    }

    fn error_node(&mut self) -> NodeId {
        self.arena.alloc(Expr::ErrorExpr)
    }

    /// Advance past tokens until we hit a statement or structural
    /// boundary, so error recovery can continue.
    fn recover_to_boundary(&mut self) {
        while !self.at_end() {
            match self.peek_kind() {
                TokenKind::Semicolon
                | TokenKind::RBrace
                | TokenKind::RBracket
                | TokenKind::RParen => break,
                _ => {
                    self.advance();
                }
            }
        }
    }

    // ==================================================================
    // Pratt core loop
    // ==================================================================

    fn parse_precedence(&mut self, min_prec: Precedence) -> NodeId {
        // ── Prefix (nud) ──
        let left = match self.peek_kind() {
            TokenKind::Integer(_) => self.parse_int_lit(),
            TokenKind::Num(_) => self.parse_num_lit(),
            TokenKind::Str(_) => self.parse_str_lit(),
            TokenKind::True | TokenKind::False => self.parse_bool_lit(),
            TokenKind::None => self.parse_none_lit(),
            TokenKind::Ident(_) => self.parse_var_or_type_associated(),
            TokenKind::LParen => self.parse_grouping_or_tuple(),
            TokenKind::LBracket => self.parse_array_lit(),
            TokenKind::LBrace => self.parse_block_expr(),
            TokenKind::Minus => self.parse_unary(UnaryOp::Neg, Precedence::Unary),
            TokenKind::Bang => self.parse_unary(UnaryOp::Not, Precedence::Unary),
            TokenKind::Backslash => self.parse_lambda(),
            TokenKind::If => self.parse_if_expr(),
            TokenKind::For => self.parse_for_loop(),
            TokenKind::Break => self.parse_break(),
            TokenKind::Continue => self.parse_continue(),
            TokenKind::Return => self.parse_return(),
            TokenKind::Match => self.parse_match(),
            // `func` keyword at expression level is invalid — it's
            // statement-level only.  Report and recover.
            TokenKind::Func => {
                self.error_here("function definitions are not allowed in expression position");
                self.recover_to_boundary();
                return self.error_node();
            }
            _ => {
                self.error_here(format!("expected expression"));
                self.recover_to_boundary();
                return self.error_node();
            }
        };

        // ── Infix (led) ──
        self.parse_infix_loop(left, min_prec)
    }

    /// Continue parsing infix operators for a left-hand side,
    /// respecting the minimum precedence.
    fn parse_infix_loop(&mut self, mut left: NodeId, min_prec: Precedence) -> NodeId {
        loop {
            if self.at_end() {
                break;
            }
            let prec = match token_precedence(self.peek_kind()) {
                Some(p) if p >= min_prec => p,
                _ => break,
            };

            // --- Assignment operators ---
            // `=`, `+=`, `-=`, etc. are handled at the lowest precedence
            // and are only valid when the left side is a variable or
            // field access.
            match self.peek_kind() {
                TokenKind::Equal => {
                    self.advance();
                    let value = self.parse_precedence(Precedence::Assignment);
                    let value_span = self.span_of(value);

                    match extract_assign_target(self.arena, left) {
                        AssignResult::Var { name, span } => {
                            left = self.alloc(Expr::Assign(Assign {
                                span: span.union(value_span),
                                name,
                                value,
                                is_mut: false,
                            }));
                        }
                        AssignResult::Field { obj, field, span } => {
                            left = self.alloc(Expr::FieldAssign(FieldAssign {
                                span: span.union(value_span),
                                obj,
                                field,
                                value,
                            }));
                        }
                        AssignResult::Error => {
                            self.error_raw(self.span_of(left), "cannot assign to this expression");
                            left = value;
                        }
                    }
                }
                kind if compound_op(kind).is_some() => {
                    let op = compound_op(kind).unwrap();
                    self.advance();
                    let rhs = self.parse_precedence(Precedence::Assignment);
                    let rhs_span = self.span_of(rhs);

                    match extract_assign_target(self.arena, left) {
                        AssignResult::Var { name, span } => {
                            let var_ref = self.alloc(Expr::Var(Var {
                                span,
                                name,
                                template_types: Vec::new(),
                            }));
                            let bin = self.alloc(Expr::Binary(Binary {
                                span: span.union(rhs_span),
                                op,
                                left: var_ref,
                                right: rhs,
                            }));
                            left = self.alloc(Expr::Assign(Assign {
                                span: span.union(rhs_span),
                                name,
                                value: bin,
                                is_mut: false,
                            }));
                        }
                        AssignResult::Field { obj, field, span } => {
                            let field_ref =
                                self.alloc(Expr::FieldAccess(FieldAccess { span, obj, field }));
                            let bin = self.alloc(Expr::Binary(Binary {
                                span: span.union(rhs_span),
                                op,
                                left: field_ref,
                                right: rhs,
                            }));
                            left = self.alloc(Expr::FieldAssign(FieldAssign {
                                span: span.union(rhs_span),
                                obj,
                                field,
                                value: bin,
                            }));
                        }
                        AssignResult::Error => {
                            self.error_raw(
                                self.span_of(left),
                                "cannot use compound assignment on this expression",
                            );
                            left = rhs;
                        }
                    }
                }
                // --- Binary operators ---
                TokenKind::Plus
                | TokenKind::Minus
                | TokenKind::Star
                | TokenKind::Slash
                | TokenKind::SlashSlash
                | TokenKind::Percent
                | TokenKind::PercentPercent
                | TokenKind::Caret
                | TokenKind::EqualEqual
                | TokenKind::BangEqual
                | TokenKind::Less
                | TokenKind::LessEqual
                | TokenKind::Greater
                | TokenKind::GreaterEqual
                | TokenKind::And
                | TokenKind::Or => {
                    let op_token = self.advance();
                    let op = token_to_binary_op(&op_token.kind);
                    let right = self.parse_precedence(prec);
                    let span = self.span_of(left).union(self.span_of(right));
                    left = self.alloc(Expr::Binary(Binary {
                        span,
                        op,
                        left,
                        right,
                    }));
                }
                // --- Range operator ---
                TokenKind::DotDot => {
                    self.advance();
                    let end = if matches!(
                        self.peek_kind(),
                        TokenKind::RBrace
                            | TokenKind::RBracket
                            | TokenKind::RParen
                            | TokenKind::Comma
                            | TokenKind::Semicolon
                            | TokenKind::Pipe
                    ) || self.at_end()
                    {
                        None
                    } else {
                        Some(self.parse_precedence(Precedence::Range))
                    };
                    let end_span = end.map(|n| self.span_of(n)).unwrap_or(self.previous().span);
                    left = self.alloc(Expr::RangeIter(RangeIter {
                        span: self.span_of(left).union(end_span),
                        start: left,
                        end,
                    }));
                }
                // --- Pipe operator ---
                TokenKind::Pipe => {
                    self.advance(); // consume '|'
                    left = self.parse_pipe_rhs(left);
                }
                // --- Function call ---
                TokenKind::LParen => {
                    let args = self.parse_call_args();
                    let arg_span = args
                        .last()
                        .map(|n| self.span_of(*n))
                        .unwrap_or(self.previous().span);
                    left = self.alloc(Expr::DirectCall(DirectCall {
                        span: self.span_of(left).union(arg_span),
                        caller: left,
                        args,
                        is_unsafe: false,
                    }));
                }
                // --- Field access ---
                TokenKind::Dot => {
                    self.advance();
                    let field_token = match self.peek_kind() {
                        TokenKind::Ident(_) => self.advance(),
                        _ => {
                            self.error_here("expected field name after '.'");
                            return self.error_node();
                        }
                    };
                    let field = self.intern_str(field_token.text().unwrap());
                    left = self.alloc(Expr::FieldAccess(FieldAccess {
                        span: self.span_of(left).union(field_token.span),
                        obj: left,
                        field,
                    }));
                }
                // --- Index access ---
                TokenKind::LBracket => {
                    self.advance();
                    let index = self.parse_expression();
                    if !self.consume_discriminant(&TokenKind::RBracket) {
                        self.error_here("expected ']' after index");
                    }
                    let get_name = self.intern_str("__get__");
                    left = self.alloc(Expr::Call(Call {
                        span: self.span_of(left).union(self.span_of(index)),
                        name: get_name,
                        args: vec![left, index],
                    }));
                }
                // --- Type-associated (Foo::bar) ---
                TokenKind::ColonColon => {
                    self.advance(); // consume '::'
                    // Extract data from arena first, then allocate.
                    let (ta_name, ta_template_types, ta_span) = match &self.arena[left] {
                        Expr::Var(v) => (v.name, v.template_types.clone(), v.span),
                        _ => {
                            self.error_raw(self.span_of(left), "expected type name before '::'");
                            return self.error_node();
                        }
                    };
                    let type_node = TypeNode::Named {
                        name: ta_name,
                        params: ta_template_types,
                    };
                    let inner = self.parse_type_associated_inner();
                    left = self.alloc(Expr::TypeAssociated(TypeAssociated {
                        span: ta_span.union(self.span_of(inner)),
                        type_node,
                        inner,
                    }));
                }
                _ => break,
            }
        }
        left
    }

    fn parse_expression(&mut self) -> NodeId {
        self.parse_precedence(Precedence::None)
    }

    // ==================================================================
    // Prefix expression parsers
    // ==================================================================

    fn parse_int_lit(&mut self) -> NodeId {
        let t = self.advance();
        self.alloc(Expr::IntLit(IntLit {
            span: t.span,
            value: t.text().unwrap().to_string(),
        }))
    }

    fn parse_num_lit(&mut self) -> NodeId {
        let t = self.advance();
        self.alloc(Expr::NumLit(NumLit {
            span: t.span,
            value: t.text().unwrap().to_string(),
        }))
    }

    fn parse_str_lit(&mut self) -> NodeId {
        let t = self.advance();
        self.alloc(Expr::StrLit(StrLit {
            span: t.span,
            value: t.text().unwrap().to_string(),
        }))
    }

    fn parse_bool_lit(&mut self) -> NodeId {
        let t = self.advance();
        self.alloc(Expr::BoolLit(BoolLit {
            span: t.span,
            value: matches!(t.kind, TokenKind::True),
        }))
    }

    fn parse_none_lit(&mut self) -> NodeId {
        let t = self.advance();
        let inner_type = if self.consume_discriminant(&TokenKind::Colon) {
            Some(self.parse_type_node())
        } else {
            None
        };
        self.alloc(Expr::NoneLit(NoneLit {
            span: t.span,
            inner_type,
        }))
    }

    /// Parse an identifier, possibly followed by template args or `::`.
    fn parse_var_or_type_associated(&mut self) -> NodeId {
        let token = self.advance();
        let name = self.intern_str(token.text().unwrap());

        // Template types: `Arr[Int]`
        let template_types = if self.consume_discriminant(&TokenKind::LBracket) {
            self.parse_template_types_inner()
        } else {
            Vec::new()
        };

        self.alloc(Expr::Var(Var {
            span: token.span,
            name,
            template_types,
        }))
    }

    /// Parse the right-hand side of `::` (either a call or a variable).
    fn parse_type_associated_inner(&mut self) -> NodeId {
        match self.peek_kind() {
            TokenKind::Ident(_) => {
                let token = self.advance();
                let name = self.intern_str(token.text().unwrap());
                if self.consume_discriminant(&TokenKind::LParen) {
                    let args = self.parse_call_args_inner();
                    self.alloc(Expr::Call(Call {
                        span: token.span,
                        name,
                        args,
                    }))
                } else {
                    self.alloc(Expr::Var(Var {
                        span: token.span,
                        name,
                        template_types: Vec::new(),
                    }))
                }
            }
            _ => {
                self.error_here("expected identifier after '::'");
                self.error_node()
            }
        }
    }

    fn parse_grouping_or_tuple(&mut self) -> NodeId {
        let open = self.advance(); // '('

        // `()` — empty parens
        if self.consume_discriminant(&TokenKind::RParen) {
            self.error_raw(
                open.span.union(self.previous().span),
                "empty parentheses are not allowed",
            );
            return self.error_node();
        }

        let first = self.parse_expression();

        // `(expr)` — grouping
        if self.consume_discriminant(&TokenKind::RParen) {
            return first;
        }

        // `(expr, ...)` — tuple
        let mut elements = vec![first];
        while self.consume_comma() {
            if self.consume_discriminant(&TokenKind::RParen) {
                break;
            }
            elements.push(self.parse_expression());
        }

        if !self.consume_discriminant(&TokenKind::RParen) {
            self.error_here("expected ')'");
        }

        if elements.len() == 1 {
            // Single-element tuple with trailing comma: already consumed
            elements[0]
        } else {
            self.alloc(Expr::TupleLit(TupleLit {
                span: open.span.union(self.previous().span),
                elements,
            }))
        }
    }

    fn parse_array_lit(&mut self) -> NodeId {
        let open = self.advance(); // '['

        let mut elements = Vec::new();
        if !self.consume_discriminant(&TokenKind::RBracket) {
            loop {
                elements.push(self.parse_expression());
                if !self.consume_comma() {
                    break;
                }
            }
            if !self.consume_discriminant(&TokenKind::RBracket) {
                self.error_here("expected ']' after array elements");
            }
        }

        let inner_type = if self.consume_discriminant(&TokenKind::Colon) {
            Some(self.parse_type_node())
        } else {
            None
        };

        self.alloc(Expr::ArrLit(ArrLit {
            span: open.span.union(self.previous().span),
            elements,
            inner_type,
        }))
    }

    fn parse_block_expr(&mut self) -> NodeId {
        self.parse_block_with_braces()
    }

    fn parse_unary(&mut self, op: UnaryOp, prec: Precedence) -> NodeId {
        let token = self.advance();
        let child = self.parse_precedence(prec);
        self.alloc(Expr::Unary(Unary {
            span: token.span.union(self.span_of(child)),
            op,
            child,
        }))
    }

    fn parse_lambda(&mut self) -> NodeId {
        let token = self.advance(); // '\'

        let mut params = Vec::new();
        if !matches!(self.peek_kind(), TokenKind::Minus) {
            loop {
                let param_token = match self.peek_kind() {
                    TokenKind::Ident(_) => self.advance(),
                    _ => {
                        self.error_here("expected parameter name in lambda");
                        break;
                    }
                };
                let name = self.intern_str(param_token.text().unwrap());

                let type_node = if self.consume_discriminant(&TokenKind::Colon) {
                    Some(self.parse_type_node())
                } else {
                    None
                };

                params.push(Param { name, type_node });

                if !self.consume_comma() {
                    break;
                }
            }
        }

        // `->` separates params from body
        if !matches!(self.peek_kind(), TokenKind::Minus) {
            self.error_here("expected '->' after lambda parameters");
            return self.error_node();
        }
        self.advance(); // '-'
        if !self.consume_discriminant(&TokenKind::Greater) {
            self.error_here("expected '>' after '-' in '->'");
        }

        let body = self.parse_precedence(Precedence::Pipe);

        self.alloc(Expr::AnonFunc(AnonFunc {
            span: token.span,
            params,
            return_type: None,
            body,
        }))
    }

    fn parse_if_expr(&mut self) -> NodeId {
        let token = self.advance(); // 'if'

        let condition = self.parse_expression();
        let branch = self.parse_block_with_braces();

        let branches: Vec<ConditionalBranch> = vec![ConditionalBranch {
            condition,
            body: branch,
        }];
        let else_branch = if self.consume_discriminant(&TokenKind::Else) {
            if self.consume_discriminant(&TokenKind::If) {
                // `else if` — parse inner if as the else branch
                Some(self.parse_if_expr())
            } else {
                Some(self.parse_block_with_braces())
            }
        } else {
            None
        };

        self.alloc(Expr::If(If {
            span: token.span.union(self.previous().span),
            branches,
            else_branch,
        }))
    }

    fn parse_for_loop(&mut self) -> NodeId {
        let token = self.advance(); // 'for'

        let var_token = match self.peek_kind() {
            TokenKind::Ident(_) => self.advance(),
            _ => {
                self.error_here("expected variable name after 'for'");
                return self.error_node();
            }
        };
        let var_name = self.intern_str(var_token.text().unwrap());

        // Consume `in` keyword
        match self.peek_kind() {
            TokenKind::Ident(s) if s == "in" => {
                self.advance();
            }
            _ => {
                self.error_here("expected 'in' after for variable");
            }
        }

        let iter = self.parse_expression();
        let body = self.parse_block_with_braces();

        self.alloc(Expr::ForLoop(ForLoop {
            span: token.span.union(self.previous().span),
            var_name,
            iter,
            body,
        }))
    }

    fn parse_break(&mut self) -> NodeId {
        let t = self.advance();
        self.alloc(Expr::Break(Break { span: t.span }))
    }

    fn parse_continue(&mut self) -> NodeId {
        let t = self.advance();
        self.alloc(Expr::Continue(Continue { span: t.span }))
    }

    fn parse_return(&mut self) -> NodeId {
        let t = self.advance();
        let value = if matches!(self.peek_kind(), TokenKind::RBrace | TokenKind::Semicolon)
            || self.at_end()
        {
            None
        } else {
            Some(self.parse_expression())
        };
        self.alloc(Expr::Return(Return {
            span: t.span,
            value,
        }))
    }

    fn parse_match(&mut self) -> NodeId {
        let token = self.advance(); // 'match'

        let scrutinee = self.parse_expression();

        if !self.consume_discriminant(&TokenKind::LBrace) {
            self.error_here("expected '{' after match expression");
            return self.error_node();
        }

        let mut arms = Vec::new();
        while !self.consume_discriminant(&TokenKind::RBrace) && !self.at_end() {
            match self.parse_match_arm() {
                Some(arm) => arms.push(arm),
                None => {
                    self.recover_to_boundary();
                }
            }
        }

        self.alloc(Expr::Match(Match {
            span: token.span.union(self.previous().span),
            scrutinee,
            arms,
        }))
    }

    fn parse_match_arm(&mut self) -> Option<MatchArm> {
        let start = self.peek().span;

        // `else => { ... }`
        if self.consume_discriminant(&TokenKind::Else) {
            let body = self.parse_block_with_braces();
            return Some(MatchArm {
                kind: MatchArmKind::Else,
                body,
                span: start.union(self.previous().span),
            });
        }

        // `none => { ... }`
        if self.consume_discriminant(&TokenKind::None) {
            let body = self.parse_block_with_braces();
            return Some(MatchArm {
                kind: MatchArmKind::None,
                body,
                span: start.union(self.previous().span),
            });
        }

        // `VariantName(binding) => { ... }` or `VariantName => { ... }`
        match self.peek_kind() {
            TokenKind::Ident(_) => {
                let name_token = self.advance();
                let name = self.intern_str(name_token.text().unwrap());

                let binding = if self.consume_discriminant(&TokenKind::LParen) {
                    let bind_token = match self.peek_kind() {
                        TokenKind::Ident(_) => self.advance(),
                        _ => {
                            self.error_here("expected binding name in match arm");
                            return None;
                        }
                    };
                    if !self.consume_discriminant(&TokenKind::RParen) {
                        self.error_here("expected ')' after binding");
                    }
                    Some(self.intern_str(bind_token.text().unwrap()))
                } else {
                    None
                };

                // `=>`
                if !(self.consume_discriminant(&TokenKind::Equal)
                    && self.consume_discriminant(&TokenKind::Greater))
                {
                    self.error_here("expected '=>' in match arm");
                }

                let body = self.parse_block_with_braces();
                Some(MatchArm {
                    kind: MatchArmKind::Variant { name, binding },
                    body,
                    span: name_token.span.union(self.previous().span),
                })
            }
            _ => {
                self.error_here("expected match arm (variant, 'none', or 'else')");
                None
            }
        }
    }

    // ==================================================================
    // Call argument parsing
    // ==================================================================

    fn parse_call_args(&mut self) -> Vec<NodeId> {
        self.advance(); // consume '('
        let args = self.parse_call_args_inner();
        if !self.consume_discriminant(&TokenKind::RParen) {
            self.error_here("expected ')' after arguments");
        }
        args
    }

    fn parse_call_args_inner(&mut self) -> Vec<NodeId> {
        let mut args = Vec::new();
        if !self.consume_discriminant(&TokenKind::RParen) {
            loop {
                args.push(self.parse_expression());
                if !self.consume_comma() {
                    break;
                }
            }
        }
        args
    }

    // ==================================================================
    // Block and statement parsing
    // ==================================================================

    /// Parse a `{ stmt; stmt; expr }` block.
    fn parse_block_with_braces(&mut self) -> NodeId {
        if !self.consume_discriminant(&TokenKind::LBrace) {
            self.error_here("expected '{'");
            return self.error_node();
        }

        let open_span = self.previous().span;
        let mut stmts: Vec<NodeId> = Vec::new();

        while !self.consume_discriminant(&TokenKind::RBrace) && !self.at_end() {
            // Skip empty statements (stray semicolons)
            if self.consume_semi() {
                continue;
            }

            let stmt = self.parse_block_statement();
            match stmt {
                Some(id) => {
                    let is_item = matches!(
                        self.arena[id],
                        Expr::FuncDef(_)
                            | Expr::StructDef(_)
                            | Expr::EnumDef(_)
                            | Expr::TraitDef(_)
                            | Expr::ImplBlock(_)
                    );

                    if is_item {
                        // Item definitions: consume optional trailing
                        // semicolon but do NOT wrap in DropValue.
                        self.consume_semi();
                        stmts.push(id);
                        continue;
                    }

                    let has_semi = self.consume_semi();
                    let at_end = self.consume_discriminant(&TokenKind::RBrace) || self.at_end();

                    if has_semi {
                        // Explicit semicolon → drop the value
                        stmts.push(self.alloc(Expr::DropValue(DropValue {
                            span: self.span_of(id),
                            child: id,
                        })));
                    } else if at_end {
                        // Last expression, no semicolon → this is the
                        // block's value.
                        stmts.push(id);
                    } else {
                        // Not last, no semicolon → implicit discard
                        stmts.push(self.alloc(Expr::DropValue(DropValue {
                            span: self.span_of(id),
                            child: id,
                        })));
                    }
                }
                None => {
                    // Statement parser returned None (error recovery
                    // already handled inside).
                    self.recover_to_boundary();
                }
            }
        }

        let close_span = self.previous().span;
        self.alloc(Expr::Block(Block {
            span: open_span.union(close_span),
            stmts,
        }))
    }

    /// Parse a single statement inside a block.
    /// Returns `Some(id)` on success, `None` if nothing could be parsed.
    fn parse_block_statement(&mut self) -> Option<NodeId> {
        // Item definitions — peek-ahead by keyword
        match self.peek_kind() {
            TokenKind::Use => return Some(self.parse_use_stmt()),
            TokenKind::Func => return Some(self.parse_func_def()),
            TokenKind::Struct => return Some(self.parse_struct_def()),
            TokenKind::Enum => return Some(self.parse_enum_def()),
            TokenKind::Trait => return Some(self.parse_trait_def()),
            _ => {}
        }

        // Assignment statements: `let x = ...`, `mut x = ...`,
        // `x = ...`, `x += ...`
        if let Some(assign) = self.try_parse_assignment_stmt() {
            return Some(assign);
        }

        // Fallthrough: any expression
        Some(self.parse_expression())
    }

    // ==================================================================
    // Assignment parsing
    // ==================================================================

    fn try_parse_assignment_stmt(&mut self) -> Option<NodeId> {
        // `let` keyword (now an identifier, not a keyword)
        if matches!(self.peek_kind(), TokenKind::Ident(s) if s == "let") {
            self.advance();
            return Some(self.parse_let_or_mut_decl(false));
        }

        // `mut` keyword
        if matches!(self.peek_kind(), TokenKind::Mut) {
            self.advance();
            return Some(self.parse_let_or_mut_decl(true));
        }

        // Identifier assignment: `x = ...` or `x += ...`
        // Must be an identifier followed by = or compound assign.
        if let TokenKind::Ident(_) = self.peek_kind() {
            let next = self.next(1);
            if let Some(next_tok) = next {
                if matches!(next_tok.kind, TokenKind::Equal)
                    || compound_op(&next_tok.kind).is_some()
                {
                    return Some(self.parse_identifier_assignment());
                }
            }
        }

        None
    }

    fn parse_let_or_mut_decl(&mut self, is_mut: bool) -> NodeId {
        let key_span = self.previous().span;

        // Tuple unpacking: `let (a, b) = expr`
        if matches!(self.peek_kind(), TokenKind::LParen) {
            return self.parse_tuple_unpack_decl(is_mut);
        }

        // Variable name
        let var_token = match self.peek_kind() {
            TokenKind::Ident(_) => self.advance(),
            _ => {
                self.error_here("expected variable name");
                return self.error_node();
            }
        };
        let name = self.intern_str(var_token.text().unwrap());

        // Optional type annotation: `let x: Type = expr`
        if self.consume_discriminant(&TokenKind::Colon) {
            // Consume the type annotation but don't store it yet —
            // type annotations on bindings will be handled during
            // type checking.
            self.parse_type_node();
        }

        // `= expr`
        if !self.consume_discriminant(&TokenKind::Equal) {
            self.error_here("expected '=' in let assignment");
            return self.error_node();
        }

        let value = self.parse_expression();

        self.alloc(Expr::Assign(Assign {
            span: key_span.union(self.span_of(value)),
            name,
            value,
            is_mut,
        }))
    }

    fn parse_tuple_unpack_decl(&mut self, _is_mut: bool) -> NodeId {
        let key_span = self.previous().span;
        self.advance(); // '(' — already confirmed by caller

        let mut bindings = Vec::new();
        while !self.consume_discriminant(&TokenKind::RParen) && !self.at_end() {
            let b_mut = if self.consume_discriminant(&TokenKind::Mut) {
                true
            } else {
                false
            };
            let t = match self.peek_kind() {
                TokenKind::Ident(_) => self.advance(),
                _ => {
                    self.error_here("expected variable name in tuple pattern");
                    return self.error_node();
                }
            };
            bindings.push(UnpackBinding {
                name: self.intern_str(t.text().unwrap()),
                is_mut: b_mut,
            });
            if !self.consume_comma() {
                break;
            }
        }

        // `= expr`
        if !self.consume_discriminant(&TokenKind::Equal) {
            self.error_here("expected '=' after tuple pattern");
            return self.error_node();
        }

        let source = self.parse_expression();

        self.alloc(Expr::TupleUnpack(TupleUnpack {
            span: key_span.union(self.span_of(source)),
            bindings,
            source,
        }))
    }

    fn parse_identifier_assignment(&mut self) -> NodeId {
        let token = self.advance();
        let name = self.intern_str(token.text().unwrap());

        // Check for compound assignment first
        if let Some(op) = self.check_compound() {
            self.advance(); // consume the compound op
            let rhs = self.parse_expression();
            let rhs_span = self.span_of(rhs);

            // Desugar: x += 1 → x = x + 1
            let var_ref = self.alloc(Expr::Var(Var {
                span: token.span,
                name,
                template_types: Vec::new(),
            }));
            let bin = self.alloc(Expr::Binary(Binary {
                span: token.span.union(rhs_span),
                op,
                left: var_ref,
                right: rhs,
            }));
            return self.alloc(Expr::Assign(Assign {
                span: token.span.union(rhs_span),
                name,
                value: bin,
                is_mut: false,
            }));
        }

        // Regular assignment
        if self.consume_discriminant(&TokenKind::Equal) {
            let value = self.parse_expression();
            return self.alloc(Expr::Assign(Assign {
                span: token.span.union(self.span_of(value)),
                name,
                value,
                is_mut: false,
            }));
        }

        // Should not be reached — caller checked for this.
        self.error_here("expected '=' or compound assignment");
        self.error_node()
    }

    // ==================================================================
    // Definition parsers (items)
    // ==================================================================

    fn parse_use_stmt(&mut self) -> NodeId {
        let token = self.advance(); // 'use'

        // `use (x: Type) from "path.js"` — JS interop
        if self.consume_discriminant(&TokenKind::LParen) {
            return self.parse_use_js(&token);
        }

        // `use "path.gema"` — bare module import
        if let TokenKind::Str(_) = self.peek_kind() {
            let path_token = self.advance();
            let path = path_token.text().unwrap().to_string();
            return self.alloc(Expr::Use(Use {
                span: token.span.union(path_token.span),
                path,
                symbols: None,
            }));
        }

        // `use { sym1, sym2 } from "path.gema"` — selective import
        if self.consume_discriminant(&TokenKind::LBrace) {
            let mut symbols = Vec::new();
            while !self.consume_discriminant(&TokenKind::RBrace) && !self.at_end() {
                match self.peek_kind() {
                    TokenKind::Ident(_) => {
                        let sym = self.advance();
                        symbols.push(self.intern_str(sym.text().unwrap()));
                        self.consume_comma();
                    }
                    _ => {
                        self.error_here("expected symbol name in import list");
                        break;
                    }
                }
            }

            // `from "path.gema"`
            let path = self.parse_from_path();

            return self.alloc(Expr::Use(Use {
                span: token.span.union(self.previous().span),
                path,
                symbols: Some(symbols),
            }));
        }

        // `use foo` or `use foo.bar.baz` — bare identifier path import
        let mut path_parts: Vec<String> = Vec::new();
        loop {
            match self.peek_kind() {
                TokenKind::Ident(_) => {
                    path_parts.push(self.peek().text().unwrap().to_string());
                    self.advance();
                    if self.consume_discriminant(&TokenKind::Dot) {
                        continue;
                    }
                    break;
                }
                _ => break,
            }
        }

        let path = path_parts.join(".");
        self.alloc(Expr::Use(Use {
            span: token.span.union(self.previous().span),
            path,
            symbols: None,
        }))
    }

    /// Parse `from "path..."` after a use declaration.
    fn parse_from_path(&mut self) -> String {
        match self.peek_kind() {
            TokenKind::Ident(s) if s == "from" => {
                self.advance();
                match self.peek_kind() {
                    TokenKind::Str(_) => {
                        let path_token = self.advance();
                        path_token.text().unwrap().to_string()
                    }
                    _ => {
                        self.error_here("expected module path string after 'from'");
                        String::new()
                    }
                }
            }
            _ => {
                self.error_here("expected 'from' after import specifier");
                String::new()
            }
        }
    }

    fn parse_use_js(&mut self, use_token: &Token) -> NodeId {
        let mut imports = Vec::new();
        while !self.consume_discriminant(&TokenKind::RParen) && !self.at_end() {
            let name_token = match self.peek_kind() {
                TokenKind::Ident(_) => self.advance(),
                _ => {
                    self.error_here("expected symbol name in JS import");
                    break;
                }
            };
            let name = self.intern_str(name_token.text().unwrap());

            let type_node = if self.consume_discriminant(&TokenKind::Colon) {
                self.parse_type_node()
            } else {
                self.error_here("expected type annotation in JS import");
                TypeNode::Null
            };

            imports.push(JsImportSymbol { name, type_node });

            if !self.consume_comma() {
                break;
            }
        }

        let path = self.parse_from_path();

        self.alloc(Expr::UseJs(UseJs {
            span: use_token.span.union(self.previous().span),
            path,
            imports,
        }))
    }

    fn parse_func_def(&mut self) -> NodeId {
        let token = self.advance(); // 'func'

        // Optional generic params: `func [T: Hash] name(args)`
        let type_params = if self.consume_discriminant(&TokenKind::LBracket) {
            self.parse_generic_params_inner()
        } else {
            Vec::new()
        };

        // Function name
        let name_token = match self.peek_kind() {
            TokenKind::Ident(_) => self.advance(),
            _ => {
                self.error_here("expected function name");
                return self.error_node();
            }
        };
        let name = self.intern_str(name_token.text().unwrap());

        // Parameters
        let params = if self.consume_discriminant(&TokenKind::LParen) {
            self.parse_func_params_inner()
        } else {
            Vec::new()
        };

        // Return type
        let return_type = if self.consume_discriminant(&TokenKind::Colon) {
            Some(self.parse_type_node())
        } else {
            None
        };

        let body = self.parse_block_with_braces();

        self.alloc(Expr::FuncDef(FuncDef {
            span: token.span.union(self.previous().span),
            name,
            params,
            return_type,
            type_params,
            body,
        }))
    }

    fn parse_func_params_inner(&mut self) -> Vec<Param> {
        let mut params = Vec::new();
        if !self.consume_discriminant(&TokenKind::RParen) {
            loop {
                let param_token = match self.peek_kind() {
                    TokenKind::Ident(_) => self.advance(),
                    _ => {
                        self.error_here("expected parameter name");
                        break;
                    }
                };
                let name = self.intern_str(param_token.text().unwrap());

                let type_node = if self.consume_discriminant(&TokenKind::Colon) {
                    Some(self.parse_type_node())
                } else {
                    None
                };

                params.push(Param { name, type_node });

                if !self.consume_comma() {
                    break;
                }
            }
            if !self.consume_discriminant(&TokenKind::RParen) {
                self.error_here("expected ')' after parameters");
            }
        }
        params
    }

    fn parse_struct_def(&mut self) -> NodeId {
        let token = self.advance(); // 'struct'

        let name_token = match self.peek_kind() {
            TokenKind::Ident(_) => self.advance(),
            _ => {
                self.error_here("expected struct name");
                return self.error_node();
            }
        };
        let name = self.intern_str(name_token.text().unwrap());

        // Generic params: `struct Pair[T] { ... }`
        let type_params = if self.consume_discriminant(&TokenKind::LBracket) {
            self.parse_generic_params_inner()
        } else {
            Vec::new()
        };

        // Fields: `{ field1: Type, field2: Type }`
        let fields = if self.consume_discriminant(&TokenKind::LBrace) {
            self.parse_struct_fields_inner()
        } else {
            Vec::new()
        };

        self.alloc(Expr::StructDef(StructDef {
            span: token.span.union(self.previous().span),
            name,
            type_params,
            fields,
        }))
    }

    fn parse_struct_fields_inner(&mut self) -> Vec<StructField> {
        let mut fields = Vec::new();
        if !self.consume_discriminant(&TokenKind::RBrace) {
            loop {
                let mut is_mut = false;
                if self.consume_discriminant(&TokenKind::Mut) {
                    is_mut = true;
                }

                let field_token = match self.peek_kind() {
                    TokenKind::Ident(_) => self.advance(),
                    _ => {
                        self.error_here("expected field name");
                        break;
                    }
                };
                let name = self.intern_str(field_token.text().unwrap());

                // `: Type`
                let type_node = if self.consume_discriminant(&TokenKind::Colon) {
                    self.parse_type_node()
                } else {
                    self.error_here("expected type annotation for struct field");
                    TypeNode::Null
                };

                fields.push(StructField {
                    name,
                    type_node,
                    is_mut,
                });

                if !self.consume_comma() {
                    break;
                }
            }
            if !self.consume_discriminant(&TokenKind::RBrace) {
                self.error_here("expected '}' after struct fields");
            }
        }
        fields
    }

    fn parse_enum_def(&mut self) -> NodeId {
        let token = self.advance(); // 'enum'

        let name_token = match self.peek_kind() {
            TokenKind::Ident(_) => self.advance(),
            _ => {
                self.error_here("expected enum name");
                return self.error_node();
            }
        };
        let name = self.intern_str(name_token.text().unwrap());

        let type_params = if self.consume_discriminant(&TokenKind::LBracket) {
            self.parse_generic_params_inner()
        } else {
            Vec::new()
        };

        let variants = if self.consume_discriminant(&TokenKind::LBrace) {
            self.parse_enum_variants_inner()
        } else {
            Vec::new()
        };

        self.alloc(Expr::EnumDef(EnumDef {
            span: token.span.union(self.previous().span),
            name,
            type_params,
            variants,
        }))
    }

    fn parse_enum_variants_inner(&mut self) -> Vec<EnumVariant> {
        let mut variants = Vec::new();
        let mut index = 0;

        if !self.consume_discriminant(&TokenKind::RBrace) {
            loop {
                let variant_token = match self.peek_kind() {
                    TokenKind::Ident(_) => self.advance(),
                    _ => {
                        self.error_here("expected variant name");
                        break;
                    }
                };
                let name = self.intern_str(variant_token.text().unwrap());

                let type_node = if self.consume_discriminant(&TokenKind::Colon) {
                    Some(self.parse_type_node())
                } else {
                    None
                };

                variants.push(EnumVariant {
                    name,
                    type_node,
                    index,
                });
                index += 1;

                if !self.consume_comma() {
                    break;
                }
            }
            if !self.consume_discriminant(&TokenKind::RBrace) {
                self.error_here("expected '}' after enum variants");
            }
        }
        variants
    }

    fn parse_trait_def(&mut self) -> NodeId {
        let token = self.advance(); // 'trait'

        let name_token = match self.peek_kind() {
            TokenKind::Ident(_) => self.advance(),
            _ => {
                self.error_here("expected trait name");
                return self.error_node();
            }
        };
        let name = self.intern_str(name_token.text().unwrap());

        let required_functions = if self.consume_discriminant(&TokenKind::LBrace) {
            self.parse_trait_funcs_inner()
        } else {
            Vec::new()
        };

        self.alloc(Expr::TraitDef(TraitDef {
            span: token.span.union(self.previous().span),
            name,
            required_functions,
        }))
    }

    fn parse_trait_funcs_inner(&mut self) -> Vec<TraitFuncSig> {
        let mut funcs = Vec::new();
        if !self.consume_discriminant(&TokenKind::RBrace) {
            loop {
                // Check for `Self.` prefix for type-associated functions
                let associated_self = if matches!(self.peek_kind(), TokenKind::Ident(s) if s == "Self")
                    && self
                        .next(1)
                        .map(|t| matches!(t.kind, TokenKind::Dot))
                        .unwrap_or(false)
                {
                    self.advance(); // consume 'Self'
                    self.advance(); // consume '.'
                    true
                } else {
                    false
                };

                let name_token = match self.peek_kind() {
                    TokenKind::Ident(_) => self.advance(),
                    _ => {
                        self.error_here("expected function name in trait");
                        break;
                    }
                };
                let name = self.intern_str(name_token.text().unwrap());

                // Parameters in parens
                let mut param_types = Vec::new();
                if self.consume_discriminant(&TokenKind::LParen) {
                    if !self.consume_discriminant(&TokenKind::RParen) {
                        loop {
                            param_types.push(self.parse_type_node());
                            if !self.consume_comma() {
                                break;
                            }
                        }
                        if !self.consume_discriminant(&TokenKind::RParen) {
                            self.error_here("expected ')' after trait function parameters");
                        }
                    }
                }

                // Return type
                let return_type = if self.consume_discriminant(&TokenKind::Colon) {
                    self.parse_type_node()
                } else {
                    self.error_here("expected return type for trait function");
                    TypeNode::Null
                };

                funcs.push(TraitFuncSig {
                    name,
                    param_types,
                    return_type,
                    associated_self,
                });

                if !self.consume_comma() {
                    break;
                }
            }
            if !self.consume_discriminant(&TokenKind::RBrace) {
                self.error_here("expected '}' after trait functions");
            }
        }
        funcs
    }

    // ==================================================================
    // Type annotation parsing
    // ==================================================================

    /// Parse a single type node from the current token stream.
    fn parse_type_node(&mut self) -> TypeNode {
        match self.peek_kind() {
            TokenKind::Ident(s) => {
                let name = s.clone();
                self.advance(); // consume identifier

                // Template params: `Arr[Int]`, `Pair[Int, Str]`
                let params = if self.consume_discriminant(&TokenKind::LBracket) {
                    self.parse_type_args_inner()
                } else {
                    Vec::new()
                };

                // Check for built-in type constructors
                match name.as_str() {
                    "Func" if !params.is_empty() => {
                        // Func is special: last arg is the return type,
                        // separated by `:` in the type annotation.
                        // Actually, Func[Int, Str: Bool] is how it's
                        // written, but the parser sees Int, Str: Bool
                        // inside [...].  The colon is consumed during
                        // parse_type_args_inner.
                        // For now, assume all args are param types
                        // and the return type is handled separately.
                        TypeNode::Func {
                            params,
                            ret: Box::new(TypeNode::Null),
                        }
                    }
                    "Arr" if params.len() == 1 => {
                        TypeNode::Arr(Box::new(params.into_iter().next().unwrap()))
                    }
                    "Iter" if params.len() == 1 => {
                        TypeNode::Iter(Box::new(params.into_iter().next().unwrap()))
                    }
                    "MutArr" if params.len() == 1 => {
                        TypeNode::MutArr(Box::new(params.into_iter().next().unwrap()))
                    }
                    "Tup" if params.len() >= 1 => TypeNode::Tup(params),
                    "Dict" if params.len() == 2 => {
                        let mut iter = params.into_iter();
                        TypeNode::Dict {
                            key: Box::new(iter.next().unwrap()),
                            val: Box::new(iter.next().unwrap()),
                        }
                    }
                    "MutDict" if params.len() == 2 => {
                        let mut iter = params.into_iter();
                        TypeNode::MutDict {
                            key: Box::new(iter.next().unwrap()),
                            val: Box::new(iter.next().unwrap()),
                        }
                    }
                    "Set" if params.len() == 1 => {
                        TypeNode::Set(Box::new(params.into_iter().next().unwrap()))
                    }
                    "MutSet" if params.len() == 1 => {
                        TypeNode::MutSet(Box::new(params.into_iter().next().unwrap()))
                    }
                    "Maybe" if params.len() == 1 => {
                        TypeNode::Maybe(Box::new(params.into_iter().next().unwrap()))
                    }
                    _ => {
                        // Check if it's a primitive type
                        match name.as_str() {
                            "Int" => TypeNode::Int,
                            "Num" => TypeNode::Num,
                            "Str" => TypeNode::Str,
                            "Bool" => TypeNode::Bool,
                            "Null" => TypeNode::Null,
                            "Self" => TypeNode::SelfType,
                            _ => TypeNode::Named {
                                name: self.intern_str(&name),
                                params,
                            },
                        }
                    }
                }
            }
            _ => {
                self.error_here("expected type");
                TypeNode::Null
            }
        }
    }

    fn parse_type_args_inner(&mut self) -> Vec<TypeNode> {
        let mut args = Vec::new();
        if !self.consume_discriminant(&TokenKind::RBracket) {
            loop {
                args.push(self.parse_type_node());
                if !self.consume_comma() {
                    break;
                }
            }
            if !self.consume_discriminant(&TokenKind::RBracket) {
                self.error_here("expected ']' after type arguments");
            }
        }
        args
    }

    /// Parse template types after a variable/type name: `[Int, Str]`
    fn parse_template_types_inner(&mut self) -> Vec<TypeNode> {
        self.parse_type_args_inner()
    }

    /// Parse generic parameters: `[T: Hash]`
    fn parse_generic_params_inner(&mut self) -> Vec<TypeParam> {
        let mut params = Vec::new();
        if !self.consume_discriminant(&TokenKind::RBracket) {
            loop {
                let name_token = match self.peek_kind() {
                    TokenKind::Ident(_) => self.advance(),
                    _ => {
                        self.error_here("expected type parameter name");
                        break;
                    }
                };
                let name = self.intern_str(name_token.text().unwrap());

                // Optional trait bound: `T: Hash`
                let traits = if self.consume_discriminant(&TokenKind::Colon) {
                    let mut ts = Vec::new();
                    loop {
                        let name = match self.peek_kind() {
                            TokenKind::Ident(s) => s.clone(),
                            _ => break,
                        };
                        let id = self.intern_str(&name);
                        ts.push(id);
                        self.advance();
                        if !self.consume_discriminant(&TokenKind::Comma) {
                            break;
                        }
                    }
                    ts
                } else {
                    Vec::new()
                };

                params.push(TypeParam { name, traits });

                if !self.consume_comma() {
                    break;
                }
            }
            if !self.consume_discriminant(&TokenKind::RBracket) {
                self.error_here("expected ']' after generic parameters");
            }
        }
        params
    }

    // ==================================================================
    // Pipe RHS parsing
    // ==================================================================

    /// Parse the right-hand side of a pipe expression.
    /// `a | f(b, c)` → `Call(f, [b, c, a])`
    /// `a | f` → `Call(f, [a])`
    /// `a | \x { body }` → `DirectCall(fn, [a])`
    fn parse_pipe_rhs(&mut self, left: NodeId) -> NodeId {
        match self.peek_kind() {
            TokenKind::Backslash => {
                let lambda = self.parse_lambda();
                self.alloc(Expr::DirectCall(DirectCall {
                    span: self.span_of(left).union(self.span_of(lambda)),
                    caller: lambda,
                    args: vec![left],
                    is_unsafe: false,
                }))
            }
            TokenKind::Ident(_) => {
                let token = self.advance();
                let name = self.intern_str(token.text().unwrap());
                let mut args = Vec::new();

                if self.consume_discriminant(&TokenKind::LParen) {
                    args = self.parse_call_args_inner();
                    if !self.consume_discriminant(&TokenKind::RParen) {
                        self.error_here("expected ')' after pipe arguments");
                    }
                }

                args.push(left);

                self.alloc(Expr::Call(Call {
                    span: token.span,
                    name,
                    args,
                }))
            }
            _ => {
                self.error_here("expected function or lambda after '|'");
                left
            }
        }
    }
}

// ======================================================================
// Public API
// ======================================================================

/// Parse a token stream into an AST.
///
/// The result is a top-level `Block` node (representing the file).
/// Diagnostics are accumulated in `DiagnosticsBag`.
pub fn parse(
    tokens: &[Token],
    arena: &mut AstArena,
    interner: &mut Interner,
    diagnostics: &mut DiagnosticsBag,
    file_idx: usize,
) -> NodeId {
    let parser = Parser::new(tokens, arena, interner, diagnostics, file_idx);
    parser.finish()
}

// ======================================================================
// Tests
// ======================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scan;
    use crate::source::SourceText;

    fn parse_one(source: &str) -> (AstArena, Interner, DiagnosticsBag, NodeId) {
        let src = SourceText::new("test.gema", source);
        let (tokens, scan_diags) = scan::scan(&src, 0);
        let mut arena = AstArena::new();
        let mut interner = Interner::new();
        let mut diagnostics = DiagnosticsBag::new();

        // Merge scan diagnostics
        for diag in scan_diags.into_vec() {
            diagnostics.push(diag);
        }

        let root = parse(&tokens, &mut arena, &mut interner, &mut diagnostics, 0);
        (arena, interner, diagnostics, root)
    }

    #[test]
    fn parse_integer_literal() {
        let (arena, _, diags, root) = parse_one("42i");
        assert!(!diags.has_errors(), "errors: {:?}", diags);
        match &arena[root] {
            Expr::Block(b) => {
                assert_eq!(b.stmts.len(), 1);
                match &arena[b.stmts[0]] {
                    Expr::IntLit(lit) => assert_eq!(lit.value, "42"),
                    Expr::DropValue(dv) => match &arena[dv.child] {
                        Expr::IntLit(lit) => assert_eq!(lit.value, "42"),
                        _ => panic!("expected IntLit inside DropValue"),
                    },
                    _ => panic!("expected IntLit or DropValue"),
                }
            }
            _ => panic!("expected Block"),
        }
    }

    #[test]
    fn parse_simple_expression() {
        let (arena, _, diags, root) = parse_one("1 + 2");
        assert!(!diags.has_errors(), "errors: {:?}", diags);
        match &arena[root] {
            Expr::Block(b) => {
                assert_eq!(b.stmts.len(), 1);
            }
            _ => panic!("expected Block"),
        }
    }

    #[test]
    fn parse_addition() {
        let src = SourceText::new("test.gema", "1 + 2");
        let (tokens, sd) = scan::scan(&src, 0);
        let mut arena = AstArena::new();
        let mut interner = Interner::new();
        let mut diagnostics = DiagnosticsBag::new();
        for d in sd.into_vec() {
            diagnostics.push(d);
        }
        let root = parse(&tokens, &mut arena, &mut interner, &mut diagnostics, 0);

        // Should have no errors
        assert!(!diagnostics.has_errors(), "errors: {:?}", diagnostics);

        // Walk the tree to find the Binary
        let block = &arena[root];
        if let Expr::Block(b) = block {
            let last = &arena[b.stmts[b.stmts.len() - 1]];
            let expr = if let Expr::DropValue(dv) = last {
                &arena[dv.child]
            } else {
                last
            };
            match expr {
                Expr::Binary(bin) => {
                    assert_eq!(bin.op, BinaryOp::Add);
                    assert!(matches!(&arena[bin.left], Expr::NumLit(_)));
                    assert!(matches!(&arena[bin.right], Expr::NumLit(_)));
                }
                _ => panic!("expected Binary, got {:?}", expr),
            }
        } else {
            panic!("expected Block");
        }
    }
}
