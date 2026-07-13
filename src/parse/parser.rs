use crate::{
    ast::*,
    diagnostics::DiagnosticsBag,
    interner::{IdentId, Interner},
    parse::{
        precedence::{Precedence, token_precedence},
        utils::{compound_op, token_to_binary_op},
    },
    source::Span,
    token::{Token, TokenKind},
};

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
            if self.consume_discriminant(&TokenKind::Semicolon) {
                continue;
            }

            let stmt_id = self.parse_block_statement();
            let is_item = matches!(
                self.arena[stmt_id],
                Expr::FuncDef(_)
                    | Expr::StructDef(_)
                    | Expr::EnumDef(_)
                    | Expr::TraitDef(_)
                    | Expr::ImplBlock(_)
            );

            if is_item {
                self.consume_discriminant(&TokenKind::Semicolon);
                stmts.push(stmt_id);
                continue;
            }

            let has_semi = self.consume_discriminant(&TokenKind::Semicolon);
            let at_end = self.at_end();

            if has_semi || !at_end {
                stmts.push(self.alloc(Expr::DropValue(DropValue {
                    span: self.span_of(stmt_id),
                    child: stmt_id,
                })));
            } else {
                stmts.push(stmt_id);
            }

            // If we got an ErrorExpr without consuming a
            // semicolon and we're still not at end, force-
            // advance to prevent an infinite loop (error
            // recovery may hit a boundary token it can't
            // advance past).
            if !has_semi && !at_end && matches!(self.arena[stmt_id], Expr::ErrorExpr) {
                self.advance();
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

    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.pos)
    }

    fn next(&self, offset: usize) -> Option<&Token> {
        self.tokens.get(self.pos + offset)
    }

    fn peek_kind(&self) -> Option<&TokenKind> {
        self.peek().map(|t| &t.kind)
    }

    /// Checks if the current token type has the same discriminant as an expected type
    /// (by discriminant — ignores data-carrying variants).
    fn peek_is(&self, t: &TokenKind) -> bool {
        match self.peek_kind() {
            Some(kind) => std::mem::discriminant(kind) == std::mem::discriminant(t),
            None => false,
        }
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
        if self.peek_is(expected) {
            self.advance();
            true
        } else {
            false
        }
    }

    /// Consume the current token if it is a comma
    /// Returns whether the current token is consumed
    fn consume_comma(&mut self) -> bool {
        self.consume_discriminant(&TokenKind::Comma)
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
        let current_token = match self.peek() {
            Some(token) => token,
            None => self
                .tokens
                .last()
                .expect("tried to create error in a token stream that does not have any tokens"),
        };
        self.error_raw(current_token.span, msg);
    }

    /// Create an ErrorExpr in the current AST position
    fn error_node(&mut self) -> NodeId {
        self.arena.alloc(Expr::ErrorExpr)
    }

    /// Advance past tokens until we hit a statement or structural
    /// boundary, so error recovery can continue.
    fn recover_to_boundary(&mut self) {
        while let Some(kind) = self.peek_kind() {
            match kind {
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

    /// Add an error to the diagnostics and recover to the next boundary.
    /// Returns an error node so the parser can continue.
    fn error_and_recover(&mut self, msg: impl Into<String>) -> NodeId {
        self.error_here(msg);
        self.recover_to_boundary();
        self.error_node()
    }

    // ==================================================================
    // Pratt core loop
    // ==================================================================

    fn parse_precedence(&mut self, min_prec: Precedence) -> NodeId {
        // ── Prefix (nud) ──
        let token_kind = match self.peek_kind() {
            Some(token) => token,
            None => {
                self.error_here("unexpected end of file");
                return self.error_node();
            }
        };
        let left = match token_kind {
            TokenKind::Integer(_) => self.parse_int_lit(),
            TokenKind::Num(_) => self.parse_num_lit(),
            TokenKind::Str(_) => self.parse_str_lit(),
            TokenKind::True | TokenKind::False => self.parse_bool_lit(),
            TokenKind::None => self.parse_none_lit(),
            TokenKind::Ident(_) => self.parse_var_or_type_associated(),
            TokenKind::LParen => self.parse_grouping_or_tuple(),
            TokenKind::LBracket => self.parse_array_lit(),
            TokenKind::LBrace => self.parse_block_with_braces(),
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
                return self.error_and_recover(
                    "function definitions are not allowed in expression position",
                );
            }
            _ => {
                return self.error_and_recover("expected expression");
            }
        };

        // ── Infix (led) ──
        self.parse_infix_loop(left, min_prec)
    }

    /// Continue parsing infix operators for a left-hand side,
    /// respecting the minimum precedence.
    fn parse_infix_loop(&mut self, mut left: NodeId, min_prec: Precedence) -> NodeId {
        while let Some(token_kind) = self.peek_kind()
            && let Some(prec) = token_precedence(token_kind)
            && prec >= min_prec
        {
            // --- Assignment operators ---
            // `=`, `+=`, `-=`, etc. are handled at the lowest precedence
            // and are only valid when the left side is a variable or
            // field access.
            match token_kind {
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
                        None | Some(TokenKind::RBracket)
                            | Some(TokenKind::RParen)
                            | Some(TokenKind::Comma)
                            | Some(TokenKind::Semicolon)
                            | Some(TokenKind::Pipe)
                            | Some(TokenKind::RBrace)
                    ) {
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
                    self.advance(); // consume '('
                    let args = self.parse_call_args();
                    if !self.consume_discriminant(&TokenKind::RParen) {
                        return self.error_and_recover("expected ')' after arguments");
                    }
                    let arg_span = args
                        .last()
                        .map(|n| self.span_of(*n))
                        .unwrap_or(self.previous().span);

                    // If the callee is a bare identifier, use Call(name)
                    // instead of DirectCall(caller).
                    let is_named_call = matches!(&self.arena[left], Expr::Var(_));
                    if is_named_call {
                        // Extract data before mutable borrow.
                        let (v_name, v_span) = match &self.arena[left] {
                            Expr::Var(v) => (v.name, v.span),
                            _ => unreachable!(),
                        };
                        left = self.alloc(Expr::Call(Call {
                            span: v_span.union(arg_span),
                            name: v_name,
                            args,
                        }));
                    } else {
                        left = self.alloc(Expr::DirectCall(DirectCall {
                            span: self.span_of(left).union(arg_span),
                            caller: left,
                            args,
                            is_unsafe: false,
                        }));
                    }
                }
                // --- Field access ---
                TokenKind::Dot => {
                    self.advance();
                    let field_token = match self.peek_kind() {
                        Some(TokenKind::Ident(_)) => self.advance(),
                        _ => {
                            return self.error_and_recover("expected field name after '.'");
                        }
                    };
                    let field = self.intern_str(field_token.text().unwrap());
                    left = self.alloc(Expr::FieldAccess(FieldAccess {
                        span: self.span_of(left).union(field_token.span),
                        obj: left,
                        field,
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
                            self.recover_to_boundary();
                            return self.error_node();
                        }
                    };
                    let type_node = TypeNode::Named {
                        name: ta_name,
                        params: ta_template_types,
                    };
                    let inner = self.parse_type_associated_rhs();
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

    /// Parse an identifier, possibly followed by template type args or `::`.
    /// In Gema, `[` is used only for type annotations, so `foo[Int]` is a
    /// variable with template type arguments, NOT index access.
    fn parse_var_or_type_associated(&mut self) -> NodeId {
        let token = self.advance();
        let name = self.intern_str(token.text().unwrap());

        // Template types: `foo[Int, Str]`
        let template_types = if self.consume_discriminant(&TokenKind::LBracket) {
            let (params, _return_type) = self.parse_type_params_inner();
            if !self.consume_discriminant(&TokenKind::RBracket) {
                return self.error_and_recover("expected ']' after type parameters");
            }
            params
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
    fn parse_type_associated_rhs(&mut self) -> NodeId {
        match self.peek_kind() {
            Some(TokenKind::Ident(_)) => {
                let token = self.advance();
                let name = self.intern_str(token.text().unwrap());
                if self.consume_discriminant(&TokenKind::LParen) {
                    let args = self.parse_call_args();
                    if !self.consume_discriminant(&TokenKind::RParen) {
                        return self.error_and_recover("expected ')' after arguments");
                    }
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
            _ => self.error_and_recover("expected identifier after '::'"),
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
        let mut comma_count = 0u32;
        while self.consume_comma() {
            comma_count += 1;
            if self.peek_is(&TokenKind::RParen) {
                break;
            }
            elements.push(self.parse_expression());
        }

        if !self.consume_discriminant(&TokenKind::RParen) {
            return self.error_and_recover("expected ')'");
        }

        if elements.len() > 1 || comma_count > 0 {
            self.alloc(Expr::TupleLit(TupleLit {
                span: open.span.union(self.previous().span),
                elements,
            }))
        } else {
            elements[0]
        }
    }

    fn parse_array_lit(&mut self) -> NodeId {
        let open = self.advance(); // '['

        let mut elements = Vec::new();
        while !self.at_end() && !self.peek_is(&TokenKind::RBracket) {
            elements.push(self.parse_expression());
            self.consume_comma();
        }
        if !self.consume_discriminant(&TokenKind::RBracket) {
            return self.error_and_recover("expected ']' after array elements");
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
        while !self.peek_is(&TokenKind::Arrow) && !self.peek_is(&TokenKind::LBrace) {
            let param_token = match self.peek_kind() {
                Some(TokenKind::Ident(_)) => self.advance(),
                _ => {
                    return self.error_and_recover("expected parameter name in lambda");
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

        let body = match self.peek_kind() {
            Some(TokenKind::Arrow) => {
                self.advance();
                self.parse_expression()
            }
            Some(TokenKind::LBrace) => self.parse_block_with_braces(),
            _ => self.error_and_recover("expected '->' or '{' after lambda parameters"),
        };

        self.alloc(Expr::AnonFunc(AnonFunc {
            span: token.span,
            params,
            return_type: None,
            body,
        }))
    }

    fn parse_if_expr(&mut self) -> NodeId {
        let token = self.advance(); // 'if'

        let mut branches = vec![ConditionalBranch {
            condition: self.parse_expression(),
            body: self.parse_block_with_braces(),
        }];

        // Parse any number of `else if` clauses — append to branches.
        while self.consume_discriminant(&TokenKind::Else) {
            if self.consume_discriminant(&TokenKind::If) {
                branches.push(ConditionalBranch {
                    condition: self.parse_expression(),
                    body: self.parse_block_with_braces(),
                });
            } else {
                // Final `else { ... }` — parse the else branch and stop.
                let else_body = self.parse_block_with_braces();
                return self.alloc(Expr::If(If {
                    span: token.span.union(self.previous().span),
                    branches,
                    else_branch: Some(else_body),
                }));
            }
        }

        self.alloc(Expr::If(If {
            span: token.span.union(self.previous().span),
            branches,
            else_branch: None,
        }))
    }

    fn parse_for_loop(&mut self) -> NodeId {
        let token = self.advance(); // 'for'

        let var_token = match self.peek_kind() {
            Some(TokenKind::Ident(_)) => self.advance(),
            _ => {
                return self.error_and_recover("expected variable name after 'for'");
            }
        };
        let var_name = self.intern_str(var_token.text().unwrap());

        // Consume `=`
        if !self.consume_discriminant(&TokenKind::Equal) {
            return self.error_and_recover("expected '=' after for variable");
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
        let value = if matches!(
            self.peek_kind(),
            None | Some(TokenKind::RBrace) | Some(TokenKind::Semicolon)
        ) {
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
            return self.error_and_recover("expected '{' after match expression");
        }

        let mut arms = Vec::new();
        while !self.at_end() && !self.peek_is(&TokenKind::RBrace) {
            match self.parse_match_arm() {
                Some(arm) => {
                    arms.push(arm);
                    if !self.consume_comma() {
                        break;
                    }
                }
                None => {
                    self.recover_to_boundary();
                }
            }
        }

        if !self.consume_discriminant(&TokenKind::RBrace) {
            return self.error_and_recover("expected '}' after match arms");
        }

        self.alloc(Expr::Match(Match {
            span: token.span.union(self.previous().span),
            scrutinee,
            arms,
        }))
    }

    fn parse_match_arm(&mut self) -> Option<MatchArm> {
        let start = match self.peek() {
            Some(token) => token.span,
            None => {
                self.error_here("expected match arm");
                return None;
            }
        };

        // `else ...`
        if self.consume_discriminant(&TokenKind::Else) {
            let body = match self.peek_kind() {
                Some(TokenKind::Arrow) => {
                    self.advance();
                    self.parse_expression()
                }
                Some(TokenKind::LBrace) => self.parse_block_with_braces(),
                _ => {
                    self.error_here("expected '->' or '{' after 'else' in match arm");
                    return None;
                }
            };
            return Some(MatchArm {
                kind: MatchArmKind::Else,
                body,
                span: start.union(self.previous().span),
            });
        }

        // `none ...
        if self.consume_discriminant(&TokenKind::None) {
            let body = match self.peek_kind() {
                Some(TokenKind::Arrow) => {
                    self.advance();
                    self.parse_expression()
                }
                Some(TokenKind::LBrace) => self.parse_block_with_braces(),
                _ => {
                    self.error_here("expected '->' or '{' after 'none' in match arm");
                    return None;
                }
            };
            return Some(MatchArm {
                kind: MatchArmKind::None,
                body,
                span: start.union(self.previous().span),
            });
        }

        // `VariantName(binding) ... or `VariantName ...
        match self.peek_kind() {
            Some(TokenKind::Ident(_)) => {
                let name_token = self.advance();
                let name = self.intern_str(name_token.text().unwrap());

                let binding = if self.consume_discriminant(&TokenKind::LParen) {
                    let bind_token = match self.peek_kind() {
                        Some(TokenKind::Ident(_)) => self.advance(),
                        _ => {
                            self.error_here("expected binding name in match arm");
                            return None;
                        }
                    };
                    if !self.consume_discriminant(&TokenKind::RParen) {
                        self.error_here("expected ')' after binding");
                        return None;
                    }
                    Some(self.intern_str(bind_token.text().unwrap()))
                } else {
                    None
                };

                let body = match self.peek_kind() {
                    Some(TokenKind::Arrow) => {
                        self.advance();
                        self.parse_expression()
                    }
                    Some(TokenKind::LBrace) => self.parse_block_with_braces(),
                    _ => {
                        self.error_here("expected '->' or '{' after discriminant in match arm");
                        return None;
                    }
                };
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
        let mut args = Vec::new();
        while !self.at_end() && !self.peek_is(&TokenKind::RParen) {
            args.push(self.parse_expression());
            if !self.consume_comma() {
                break;
            };
        }
        args
    }

    // ==================================================================
    // Block and statement parsing
    // ==================================================================

    /// Parse a `{ stmt; stmt; expr }` block.
    fn parse_block_with_braces(&mut self) -> NodeId {
        if !self.consume_discriminant(&TokenKind::LBrace) {
            return self.error_and_recover("expected '{'");
        }

        let open_span = self.previous().span;
        let mut stmts: Vec<NodeId> = Vec::new();

        while !self.consume_discriminant(&TokenKind::RBrace) && !self.at_end() {
            // Skip empty statements (stray semicolons)
            if self.consume_discriminant(&TokenKind::Semicolon) {
                continue;
            }

            let stmt_id = self.parse_block_statement();
            let is_item_def = matches!(
                self.arena[stmt_id],
                Expr::FuncDef(_)
                    | Expr::StructDef(_)
                    | Expr::EnumDef(_)
                    | Expr::TraitDef(_)
                    | Expr::ImplBlock(_)
            );

            if is_item_def {
                // Item definitions: consume optional trailing
                // semicolon but do NOT wrap in DropValue.
                self.consume_discriminant(&TokenKind::Semicolon);
                stmts.push(stmt_id);
                continue;
            }

            let has_semi = self.consume_discriminant(&TokenKind::Semicolon);
            let at_end = matches!(self.peek_kind(), None | Some(TokenKind::RBrace));

            if has_semi {
                // Explicit semicolon → drop the value
                stmts.push(self.alloc(Expr::DropValue(DropValue {
                    span: self.span_of(stmt_id),
                    child: stmt_id,
                })));
            } else if at_end {
                // Last expression, no semicolon → this is the
                // block's value.
                stmts.push(stmt_id);
            } else {
                // Not last, no semicolon → this is illegal
                return self.error_and_recover("expected ';' after expression in block");
            }
        }

        let close_span = self.previous().span;
        self.alloc(Expr::Block(Block {
            span: open_span.union(close_span),
            stmts,
        }))
    }

    /// Parse a single statement inside a block.
    fn parse_block_statement(&mut self) -> NodeId {
        // Item definitions — peek-ahead by keyword
        match self.peek_kind() {
            Some(TokenKind::Use) => return self.parse_use_stmt(),
            Some(TokenKind::Func) => return self.parse_func_def(),
            Some(TokenKind::Struct) => return self.parse_struct_def(),
            Some(TokenKind::Enum) => return self.parse_enum_def(),
            Some(TokenKind::Trait) => return self.parse_trait_def(),
            Some(TokenKind::Impl) => return self.parse_impl_block(),
            _ => {}
        }

        // Assignment statements: `mut x = ...`, `(a, b) = expr`,
        // `x = ...`, `x += ...`
        if let Some(assign) = self.try_parse_assignment_stmt() {
            return assign;
        }

        // Fallthrough: any expression
        self.parse_expression()
    }

    // ==================================================================
    // Assignment parsing
    // ==================================================================

    /// Scan ahead to see if `(` ... `)` is followed by `=`.
    /// This disambiguates tuple unpack `(a, b) = expr` from
    /// tuple expressions like `(1, 2)` without consuming tokens.
    fn is_tuple_unpack(&self) -> bool {
        if !self.peek_is(&TokenKind::LParen) {
            return false;
        }
        let mut depth = 1u32;
        let mut i = self.pos + 1;
        while i < self.tokens.len() && depth > 0 {
            match &self.tokens[i].kind {
                TokenKind::LParen => depth += 1,
                TokenKind::RParen => depth -= 1,
                _ => {}
            }
            i += 1;
        }
        // After matching ')', check if '=' follows
        depth == 0 && i < self.tokens.len() && matches!(self.tokens[i].kind, TokenKind::Equal)
    }

    fn try_parse_assignment_stmt(&mut self) -> Option<NodeId> {
        // `mut` keyword — unambiguously a mutable variable declaration
        if matches!(self.peek_kind(), Some(TokenKind::Mut)) {
            self.advance();
            return Some(self.parse_mut_decl());
        }

        // Tuple unpacking: `(mut a, b) = expr`
        // Use scan-ahead to disambiguate from tuple expressions.
        if self.is_tuple_unpack() {
            return Some(self.parse_tuple_unpack_decl());
        }

        // Note: Simple identifier assignment `x = expr` is handled
        // by the infix loop (`=` has Assignment precedence), so it
        // doesn't need special treatment here.

        None
    }

    fn parse_mut_decl(&mut self) -> NodeId {
        let key_span = self.previous().span;

        // Variable name
        let var_token = match self.peek_kind() {
            Some(TokenKind::Ident(_)) => self.advance(),
            _ => {
                return self.error_and_recover("expected variable name");
            }
        };
        let name = self.intern_str(var_token.text().unwrap());

        // `= expr`
        if !self.consume_discriminant(&TokenKind::Equal) {
            return self.error_and_recover("expected '=' in assignment");
        }

        let value = self.parse_expression();

        self.alloc(Expr::Assign(Assign {
            span: key_span.union(self.span_of(value)),
            name,
            value,
            is_mut: true,
        }))
    }

    fn parse_tuple_unpack_decl(&mut self) -> NodeId {
        let open = self.advance(); // consume '('

        let mut bindings = Vec::new();
        while !self.consume_discriminant(&TokenKind::RParen) && !self.at_end() {
            let b_mut = self.consume_discriminant(&TokenKind::Mut);
            let t = match self.peek_kind() {
                Some(TokenKind::Ident(_)) => self.advance(),
                _ => {
                    return self.error_and_recover("expected variable name in tuple pattern");
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

        // Consume the closing `)`
        if !self.consume_discriminant(&TokenKind::RParen) {
            return self.error_and_recover("expected ')' after tuple pattern");
        }

        // `= expr`
        if !self.consume_discriminant(&TokenKind::Equal) {
            return self.error_and_recover("expected '=' after tuple pattern");
        }

        let source = self.parse_expression();

        self.alloc(Expr::TupleUnpack(TupleUnpack {
            span: open.span.union(self.span_of(source)),
            bindings,
            source,
        }))
    }

    // ==================================================================
    // Definition parsers (items)
    // ==================================================================

    fn parse_use_stmt(&mut self) -> NodeId {
        let token = self.advance(); // 'use'

        let next_token = match self.peek() {
            Some(t) => t,
            None => {
                self.error_here("expected token after 'use'");
                // Nothing to recover from — already at end.
                return self.error_node();
            }
        };

        match &next_token.kind {
            // Unsafe import (from JS)
            TokenKind::Bang => {
                self.advance(); // consume the `!` token
                self.parse_use_js(&token)
            }
            // Bare import (import everything)
            TokenKind::Str(path) => {
                let expr = self.alloc(Expr::Use(Use {
                    span: token.span.union(next_token.span),
                    path: path.to_string(),
                    symbols: None,
                }));
                self.advance(); // consume the string token
                expr
            }
            // Import specific symbols
            TokenKind::LParen => {
                self.advance(); // consume the LParen
                let mut symbols = Vec::new();
                while !self.at_end() && !self.peek_is(&TokenKind::RParen) {
                    match self.peek_kind() {
                        Some(TokenKind::Ident(_)) => {
                            let sym = self.advance();
                            symbols.push(self.intern_str(sym.text().unwrap()));
                            if !self.consume_comma() {
                                break;
                            }
                        }
                        _ => {
                            return self.error_and_recover("expected symbol name in import list");
                        }
                    }
                }

                if !self.consume_discriminant(&TokenKind::RParen) {
                    return self.error_and_recover("expected `)` after import list");
                }

                // `from "path.gema"`
                let path = match self.parse_from_path() {
                    Some(path) => path,
                    None => {
                        // Error diagnostic is created inside `parse_from_path`
                        self.recover_to_boundary();
                        return self.error_node();
                    }
                };

                self.alloc(Expr::Use(Use {
                    span: token.span.union(self.previous().span),
                    path,
                    symbols: Some(symbols),
                }))
            }
            _ => self.error_and_recover(
                "expected filename or list of imports in parentheses after `use`",
            ),
        }
    }

    /// Parse `from "path..."` after a use declaration.
    fn parse_from_path(&mut self) -> Option<String> {
        match self.peek_kind() {
            Some(TokenKind::From) => {
                self.advance();
                match self.peek_kind() {
                    Some(TokenKind::Str(_)) => {
                        let path_token = self.advance();
                        Some(path_token.text().unwrap().to_string())
                    }
                    _ => {
                        self.error_here("expected module path string after 'from'");
                        None
                    }
                }
            }
            _ => {
                self.error_here("expected 'from' after import specifier");
                None
            }
        }
    }

    fn parse_use_js(&mut self, use_token: &Token) -> NodeId {
        if !self.consume_discriminant(&TokenKind::LParen) {
            return self.error_and_recover("expected '(' after 'use!'");
        }
        let mut imports = Vec::new();
        while !self.at_end() && !self.peek_is(&TokenKind::RParen) {
            let name_token = match self.peek_kind() {
                Some(TokenKind::Ident(_)) => self.advance(),
                _ => {
                    return self.error_and_recover("expected symbol name in JS import");
                }
            };
            let name = self.intern_str(name_token.text().unwrap());

            let type_node = if self.consume_discriminant(&TokenKind::Colon) {
                self.parse_type_node()
            } else {
                return self.error_and_recover("expected type annotation in JS import");
            };

            imports.push(JsImportSymbol { name, type_node });

            if !self.consume_comma() {
                break;
            }
        }

        if !self.consume_discriminant(&TokenKind::RParen) {
            return self.error_and_recover("expected ')' after JS imports");
        }

        let path = self.parse_from_path().unwrap_or_default();

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
            let type_params = self.parse_generic_params_inner();
            if !self.consume_discriminant(&TokenKind::RBracket) {
                return self.error_and_recover("expected ']' after generic parameters");
            }
            type_params
        } else {
            Vec::new()
        };

        // Function name
        let name_token = match self.peek_kind() {
            Some(TokenKind::Ident(_)) => self.advance(),
            _ => {
                return self.error_and_recover("expected function name");
            }
        };
        let name = self.intern_str(name_token.text().unwrap());

        // Parameters
        if !self.consume_discriminant(&TokenKind::LParen) {
            return self.error_and_recover("expected '(' after function name");
        }
        let params = self.parse_func_params_inner();
        if !self.consume_discriminant(&TokenKind::RParen) {
            return self.error_and_recover("expected ')' after parameters");
        }

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
        while !self.at_end() && !self.peek_is(&TokenKind::RParen) {
            let param_token = match self.peek_kind() {
                Some(TokenKind::Ident(_)) => self.advance(),
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
        params
    }

    fn parse_struct_def(&mut self) -> NodeId {
        let token = self.advance(); // 'struct'

        let name_token = match self.peek_kind() {
            Some(TokenKind::Ident(_)) => self.advance(),
            _ => {
                return self.error_and_recover("expected struct name");
            }
        };
        let name = self.intern_str(name_token.text().unwrap());

        // Generic params: `struct Pair[T] { ... }`
        let type_params = if self.consume_discriminant(&TokenKind::LBracket) {
            let params = self.parse_generic_params_inner();
            if !self.consume_discriminant(&TokenKind::RBracket) {
                return self.error_and_recover("expected ']' after generic params");
            }
            params
        } else {
            Vec::new()
        };

        // Fields: `{ field1: Type, field2: Type }`
        if !self.consume_discriminant(&TokenKind::LBrace) {
            return self.error_and_recover("expected '{' before struct fields");
        }

        let fields = self.parse_struct_fields_inner();

        if !self.consume_discriminant(&TokenKind::RBrace) {
            return self.error_and_recover("expected '}' after struct fields");
        }

        self.alloc(Expr::StructDef(StructDef {
            span: token.span.union(self.previous().span),
            name,
            type_params,
            fields,
        }))
    }

    fn parse_struct_fields_inner(&mut self) -> Vec<StructField> {
        let mut fields = Vec::new();
        while !self.at_end() && !self.peek_is(&TokenKind::RBrace) {
            let mut is_mut = false;
            if self.consume_discriminant(&TokenKind::Mut) {
                is_mut = true;
            }

            let field_token = match self.peek_kind() {
                Some(TokenKind::Ident(_)) => self.advance(),
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
        fields
    }

    fn parse_enum_def(&mut self) -> NodeId {
        let token = self.advance(); // 'enum'

        let name_token = match self.peek_kind() {
            Some(TokenKind::Ident(_)) => self.advance(),
            _ => {
                return self.error_and_recover("expected enum name");
            }
        };
        let name = self.intern_str(name_token.text().unwrap());

        let type_params = if self.consume_discriminant(&TokenKind::LBracket) {
            let type_params = self.parse_generic_params_inner();
            if !self.consume_discriminant(&TokenKind::RBracket) {
                return self.error_and_recover("expected ']' after generic parameters");
            }
            type_params
        } else {
            Vec::new()
        };

        if !self.consume_discriminant(&TokenKind::LBrace) {
            return self.error_and_recover("expected '{' before enum variants");
        }

        let variants = self.parse_enum_variants_inner();

        if !self.consume_discriminant(&TokenKind::RBrace) {
            return self.error_and_recover("expected '}' after enum variants");
        }

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

        while !self.at_end() && !self.peek_is(&TokenKind::RBrace) {
            let variant_token = match self.peek_kind() {
                Some(TokenKind::Ident(_)) => self.advance(),
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

        variants
    }

    fn parse_trait_def(&mut self) -> NodeId {
        let token = self.advance(); // 'trait'

        let name_token = match self.peek_kind() {
            Some(TokenKind::Ident(_)) => self.advance(),
            _ => {
                return self.error_and_recover("expected trait name");
            }
        };
        let name = self.intern_str(name_token.text().unwrap());

        if !self.consume_discriminant(&TokenKind::LBrace) {
            return self.error_and_recover("expected '{' after trait name");
        }

        let required_functions = self.parse_trait_funcs_inner();

        if !self.consume_discriminant(&TokenKind::RBrace) {
            return self.error_and_recover("expected '}' after trait functions");
        }

        self.alloc(Expr::TraitDef(TraitDef {
            span: token.span.union(self.previous().span),
            name,
            required_functions,
        }))
    }

    fn parse_trait_funcs_inner(&mut self) -> Vec<TraitFuncSig> {
        let mut funcs = Vec::new();
        while !self.at_end() && !self.peek_is(&TokenKind::RBrace) {
            // Check for `Self::` prefix for type-associated functions
            let associated_self = if matches!(self.peek_kind(), Some(TokenKind::Ident(s)) if s == "Self")
                && self
                    .next(1)
                    .map(|t| matches!(t.kind, TokenKind::ColonColon))
                    .unwrap_or(false)
            {
                self.advance(); // consume 'Self'
                self.advance(); // consume '::'
                true
            } else {
                false
            };

            let name_token = match self.peek_kind() {
                Some(TokenKind::Ident(_)) => self.advance(),
                _ => {
                    self.error_here("expected function name in trait");
                    break;
                }
            };
            let name = self.intern_str(name_token.text().unwrap());

            // Parameters in parens
            let mut param_types = Vec::new();
            if !self.consume_discriminant(&TokenKind::LBracket) {
                self.error_here("expected '[' after trait function name");
                continue;
            }
            while !self.at_end() && !self.peek_is(&TokenKind::Colon) {
                param_types.push(self.parse_type_node());
                if !self.consume_comma() {
                    break;
                }
            }

            // Return type
            let return_type = if self.consume_discriminant(&TokenKind::Colon) {
                self.parse_type_node()
            } else {
                self.error_here("expected ':' then return type for trait function");
                TypeNode::Null
            };

            if !self.consume_discriminant(&TokenKind::RBracket) {
                self.error_here("expected ']' after trait function parameters");
                continue;
            }

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
        funcs
    }

    fn parse_impl_block(&mut self) -> NodeId {
        let token = self.advance(); // 'impl'

        // Parse self type
        let self_type = self.parse_type_node();

        // Consume ':'
        if !matches!(self.peek_kind(), Some(TokenKind::Colon)) {
            return self.error_and_recover("expected ':' after type name in impl block");
        }
        self.advance();

        // Parse trait name
        let name_token = match self.peek_kind() {
            Some(TokenKind::Ident(_)) => self.advance(),
            _ => {
                return self.error_and_recover("expected trait name in impl block");
            }
        };
        let trait_name = self.intern_str(name_token.text().unwrap());

        // Parse { functions }
        if !self.consume_discriminant(&TokenKind::LBrace) {
            return self.error_and_recover("expected '{' after impl block");
        }

        let functions = self.parse_impl_funcs_inner();

        if !self.consume_discriminant(&TokenKind::RBrace) {
            return self.error_and_recover("expected '}' after impl functions");
        }

        self.alloc(Expr::ImplBlock(ImplBlock {
            span: token.span.union(self.previous().span),
            trait_name,
            self_type,
            functions,
        }))
    }

    fn parse_impl_funcs_inner(&mut self) -> Vec<NodeId> {
        let mut funcs = Vec::new();
        while !self.at_end() && !self.peek_is(&TokenKind::RBrace) {
            // Expect 'func' keyword
            if !matches!(self.peek_kind(), Some(TokenKind::Func)) {
                self.error_here("expected 'func' in impl block");
                break;
            }
            funcs.push(self.parse_func_def());

            if !self.consume_comma() {
                break;
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
            Some(TokenKind::Ident(s)) => {
                let name = s.clone();
                self.advance(); // consume identifier

                // Template params: `Arr[Int]`, `Pair[Int, Str]`, `Func[Num, Num: Num]`
                let (params, return_type) = if self.consume_discriminant(&TokenKind::LBracket) {
                    let result = self.parse_type_params_inner();
                    if !self.consume_discriminant(&TokenKind::RBracket) {
                        self.error_here("expected ']' after type parameters");
                    }
                    result
                } else {
                    (Vec::new(), None)
                };

                // Check for built-in type constructors
                // TODO: Maybe should have checks here to make sure we aren't getting unexpected type params or return type
                // Otherwise, we'll end up with weird things like Int[Num: Str] getting accepted and treated like a named type
                match name.as_str() {
                    "Func" if !params.is_empty() => {
                        let ret = match return_type {
                            Some(ret) => Box::new(ret),
                            None => Box::new(TypeNode::Null),
                        };
                        TypeNode::Func { params, ret }
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
                    "Tup" if !params.is_empty() => TypeNode::Tup(params),
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

    fn parse_type_params_inner(&mut self) -> (Vec<TypeNode>, Option<TypeNode>) {
        let mut params = Vec::new();
        let mut return_type = None;
        while !self.at_end() && !self.peek_is(&TokenKind::RBracket) {
            params.push(self.parse_type_node());
            // `:` signals the return type separator in Func types.
            if self.consume_discriminant(&TokenKind::Colon) {
                return_type = Some(self.parse_type_node());
                break; // Return type is expected to be last thing in type params
            }
            if !self.consume_comma() {
                break;
            }
        }
        (params, return_type)
    }

    /// Parse generic parameters: `[T: Hash + Clone]`
    fn parse_generic_params_inner(&mut self) -> Vec<TypeParam> {
        let mut params = Vec::new();
        while !self.at_end() && !self.peek_is(&TokenKind::RBracket) {
            let name_token = match self.peek_kind() {
                Some(TokenKind::Ident(_)) => self.advance(),
                _ => {
                    self.error_here("expected type parameter name");
                    break;
                }
            };
            let name = self.intern_str(name_token.text().unwrap());

            // Optional trait bound: `T: Hash + Clone`
            let traits = if self.consume_discriminant(&TokenKind::Colon) {
                let mut ts = Vec::new();
                while let Some(TokenKind::Ident(s)) = self.peek_kind() {
                    let name = s.clone();
                    let id = self.intern_str(&name);
                    ts.push(id);
                    self.advance();
                    if !self.consume_discriminant(&TokenKind::Plus) {
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
            Some(TokenKind::Backslash) => {
                let lambda = self.parse_lambda();
                self.alloc(Expr::DirectCall(DirectCall {
                    span: self.span_of(left).union(self.span_of(lambda)),
                    caller: lambda,
                    args: vec![left],
                    is_unsafe: false,
                }))
            }
            Some(TokenKind::Ident(_)) => {
                let token = self.advance();
                let name = self.intern_str(token.text().unwrap());
                let mut args = Vec::new();

                if self.consume_discriminant(&TokenKind::LParen) {
                    args = self.parse_call_args();
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
