/// HIR → JavaScript codegen.
use rustc_hash::FxHashSet;

use crate::builtins;
use crate::hir::*;
use crate::interner::{IdentId, Interner};

/// Compile a HIR tree to a JavaScript string.
pub fn codegen(hir: &HirExpr, interner: &Interner) -> String {
    let mut w = JsWriter::new(interner);
    w.emit_expr(hir, true);
    w.finish()
}

struct JsWriter<'a> {
    interner: &'a Interner,
    lines: Vec<String>,
    current: String,
    indent: usize,
    /// Set of builtin helper names required by calls in this program.
    needed_helpers: FxHashSet<&'static str>,
    /// Tracks which variable names have been declared via `let` in the
    /// current block, to prevent duplicate `let` on reassignment.
    declared: FxHashSet<IdentId>,
    /// Counter for generating unique names for synthetic variables.
    next_unique_id: u32,
}

impl<'a> JsWriter<'a> {
    fn new(interner: &'a Interner) -> Self {
        Self {
            interner,
            lines: Vec::new(),
            current: String::new(),
            indent: 0,
            needed_helpers: FxHashSet::default(),
            declared: FxHashSet::default(),
            next_unique_id: 0,
        }
    }

    fn unique_name(&mut self, prefix: &str) -> String {
        let id = self.next_unique_id;
        self.next_unique_id += 1;
        format!("{}{}$", prefix, id)
    }

    fn newline(&mut self) {
        self.lines.push(self.current.clone());
        self.current = "    ".repeat(self.indent);
    }

    fn write(&mut self, s: &str) {
        self.current.push_str(s);
    }

    fn indent_in(&mut self) {
        self.indent += 1;
    }

    fn indent_out(&mut self) {
        self.indent -= 1;
    }

    fn safe_name(&self, name: &str) -> String {
        let reserved = [
            "let",
            "const",
            "var",
            "function",
            "class",
            "new",
            "this",
            "super",
            "if",
            "else",
            "for",
            "while",
            "do",
            "switch",
            "case",
            "break",
            "continue",
            "return",
            "throw",
            "try",
            "catch",
            "finally",
            "typeof",
            "void",
            "delete",
            "import",
            "export",
            "yield",
            "async",
            "await",
            "in",
            "of",
            "instanceof",
            "true",
            "false",
            "null",
            "undefined",
        ];
        if reserved.contains(&name) {
            format!("_{}", name)
        } else {
            name.to_string()
        }
    }

    fn require_helper(&mut self, name: &'static str) {
        self.needed_helpers.insert(name);
    }

    /// Render a HirExpr to a string without side effects on the writer.
    fn expr_to_string(&self, expr: &HirExpr) -> String {
        let mut buf = JsWriter::new(self.interner);
        buf.emit_expr(expr, true);
        buf.newline();
        buf.current.trim().to_string()
    }

    fn finish(&mut self) -> String {
        let trimmed = self.current.trim();
        if !trimmed.is_empty() {
            self.lines.push(self.current.clone());
        }

        let helpers_code = if self.needed_helpers.is_empty() {
            String::new()
        } else {
            let mut h: Vec<&str> = self.needed_helpers.iter().copied().collect();
            h.sort_unstable();
            builtins::emit_helpers(&h)
        };

        let program = self.lines.join("\n");
        let mut out = String::new();
        if !helpers_code.is_empty() {
            out.push_str(&helpers_code);
            out.push('\n');
        }
        out.push_str("// PROGRAM //\n");
        out.push_str(&program);
        out.push('\n');
        out
    }

    // ===================================================================
    // Central dispatch
    // ===================================================================

    fn emit_expr(&mut self, expr: &HirExpr, value_used: bool) {
        match expr {
            HirExpr::IntLit(e) => self.emit_int_lit(e),
            HirExpr::NumLit(e) => self.emit_num_lit(e),
            HirExpr::StrLit(e) => self.emit_str_lit(e),
            HirExpr::BoolLit(e) => self.emit_bool_lit(e),
            HirExpr::NoneLit(_) => self.write("null"),
            HirExpr::Ident(e) => self.emit_ident(e),
            HirExpr::ArrLit(e) => self.emit_array(e),
            HirExpr::TupleLit(e) => self.emit_tuple(e),
            HirExpr::RangeLit(e) => self.emit_range(e),
            HirExpr::StructLit(e) => self.emit_struct_lit(e),
            HirExpr::EnumLit(e) => self.emit_enum_lit(e),
            HirExpr::Binary(e) => self.emit_binary(e),
            HirExpr::Unary(e) => self.emit_unary(e),
            HirExpr::Assign(e) => self.emit_assign(e),
            HirExpr::FieldAccess(e) => self.emit_field_access(e),
            HirExpr::FieldAssign(e) => self.emit_field_assign(e),
            HirExpr::TupleIndex(e) => self.emit_tuple_index(e),
            HirExpr::Block(e) => self.emit_block(e, value_used),
            HirExpr::If(e) => self.emit_if(e, value_used),
            HirExpr::ForLoop(e) => self.emit_for_loop(e),
            HirExpr::Break(_) => self.write("break"),
            HirExpr::Continue(_) => self.write("continue"),
            HirExpr::Return(e) => self.emit_return(e),
            HirExpr::FuncDef(e) => self.emit_func_def(e),
            HirExpr::AnonFunc(e) => self.emit_anon_func(e),
            HirExpr::Call(e) => self.emit_call(e),
            HirExpr::DirectCall(e) => self.emit_direct_call(e),
            HirExpr::Match(e) => self.emit_match(e, value_used),
            HirExpr::Error => { /* emit nothing */ }
        }
    }

    // ── Literals ──

    fn emit_int_lit(&mut self, e: &IntLit) {
        self.write(&e.value);
        self.write("n");
    }

    fn emit_num_lit(&mut self, e: &NumLit) {
        self.write(&e.value);
    }

    fn emit_str_lit(&mut self, e: &StrLit) {
        self.write("\"");
        let chars: Vec<char> = e.value.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            match chars[i] {
                '"' => self.write("\\\""),
                '\\' => {
                    self.write("\\\\");
                    // The next char is the escaped char — emit it as-is.
                    if i + 1 < chars.len() {
                        i += 1;
                        self.write(&chars[i].to_string());
                    }
                }
                '\n' => self.write("\\n"),
                '\r' => self.write("\\r"),
                '\t' => self.write("\\t"),
                c => self.write(&c.to_string()),
            }
            i += 1;
        }
        self.write("\"");
    }

    fn emit_bool_lit(&mut self, e: &BoolLit) {
        self.write(if e.value { "true" } else { "false" });
    }

    // ── Identifiers ──

    fn emit_ident(&mut self, e: &IdentNode) {
        let name = self.interner.lookup(e.name);
        self.write(&self.safe_name(name));
    }

    // ── Collections ──

    fn emit_array(&mut self, e: &ArrLit) {
        self.write("[");
        for (i, el) in e.elements.iter().enumerate() {
            if i > 0 {
                self.write(", ");
            }
            self.emit_expr(el, true);
        }
        self.write("]");
    }

    fn emit_tuple(&mut self, e: &TupleLit) {
        self.write("[");
        for (i, el) in e.elements.iter().enumerate() {
            if i > 0 {
                self.write(", ");
            }
            self.emit_expr(el, true);
        }
        self.write("]");
    }

    fn emit_range(&mut self, e: &RangeLit) {
        self.require_helper("$IntRangeIterator$");
        self.write("new $IntRangeIterator$(");
        self.emit_expr(&e.start, true);
        if let Some(end) = &e.end {
            self.write(", ");
            self.emit_expr(end, true);
        }
        self.write(")");
    }

    // ── Struct and enum construction ──

    fn emit_struct_lit(&mut self, e: &StructLit) {
        self.write("{");
        for (i, (name, val)) in e.fields.iter().enumerate() {
            if i > 0 {
                self.write(", ");
            }
            let field_name = self.interner.lookup(*name);
            self.write(&self.safe_name(field_name));
            self.write(": ");
            self.emit_expr(val, true);
        }
        self.write("}");
    }

    fn emit_enum_lit(&mut self, e: &EnumLit) {
        if e.is_tagged_union {
            self.write("Object.freeze({ $tag: \"");
            let tag = self.interner.lookup(e.tag);
            self.write(&tag.replace('"', "\\\""));
            self.write("\", $val: ");
            if let Some(val) = &e.value {
                self.emit_expr(val, true);
            } else {
                self.write("undefined");
            }
            self.write(" })");
        }
    }

    // ── Operators ──

    fn emit_binary(&mut self, e: &Binary) {
        self.write("(");
        self.emit_expr(&e.left, true);
        self.write(" ");
        self.write(&e.op.to_string());
        self.write(" ");
        self.emit_expr(&e.right, true);
        self.write(")");
    }

    fn emit_unary(&mut self, e: &Unary) {
        self.write(&e.op.to_string());
        self.emit_expr(&e.child, true);
    }

    // ── Assignment ──
    // Uses inline `let` — the `declared` set prevents duplicate `let`
    // for reassignments within the same block.

    fn emit_assign(&mut self, e: &Assign) {
        let name_str = self.interner.lookup(e.name);
        let safe = self.safe_name(name_str);

        if !self.declared.contains(&e.name) {
            self.declared.insert(e.name);
            self.write(&format!("let {} = ", safe));
        } else {
            self.write(&format!("{} = ", safe));
        }
        self.emit_expr(&e.value, true);
    }

    // ── Field access, assign, and tuple index ──

    fn emit_field_access(&mut self, e: &FieldAccess) {
        self.write("(");
        self.emit_expr(&e.obj, true);
        let field = self.interner.lookup(e.field);
        self.write(&format!(").{}", self.safe_name(field)));
    }

    fn emit_field_assign(&mut self, e: &FieldAssign) {
        self.write("(");
        self.emit_expr(&e.obj, true);
        let field = self.interner.lookup(e.field);
        self.write(&format!(").{} = ", self.safe_name(field)));
        self.emit_expr(&e.value, true);
    }

    fn emit_tuple_index(&mut self, e: &TupleIndex) {
        self.write("(");
        self.emit_expr(&e.obj, true);
        self.write(&format!(")[{}]", e.index));
    }

    // ── Control flow ──

    /// Emit a statement as the value-returning expression of a block.
    /// Statement-like constructs (function defs, for loops, errors)
    /// are emitted without `return`.  Variable declarations are split
    /// into `let x = val; return x;`.
    /// The caller should NOT add a trailing `;` — this method handles it.
    fn emit_returned_stmt(&mut self, stmt: &HirExpr) {
        match stmt {
            HirExpr::Assign(a) if !self.declared.contains(&a.name) => {
                let name_str = self.interner.lookup(a.name);
                let safe = self.safe_name(name_str);
                self.declared.insert(a.name);
                self.write(&format!("let {} = ", safe));
                self.emit_expr(&a.value, true);
                self.write(";");
                self.newline();
                self.write(&format!("return {}", safe));
            }
            HirExpr::FuncDef(f) => self.emit_func_def(f),
            HirExpr::AnonFunc(a) => self.emit_anon_func(a),
            HirExpr::ForLoop(f) => self.emit_for_loop(f),
            HirExpr::Error => {}
            _ => {
                self.write("return ");
                self.emit_expr(stmt, true);
            }
        }
    }

    /// Check whether `stmt` is a statement-like construct whose emitted
    /// text already ends with a closing brace, so no trailing `;` is needed.
    fn stmt_ends_with_brace(stmt: &HirExpr) -> bool {
        matches!(
            stmt,
            HirExpr::FuncDef(_)
                | HirExpr::AnonFunc(_)
                | HirExpr::ForLoop(_)
                | HirExpr::If(_)
                | HirExpr::Match(_)
        )
    }

    /// Emit a branch/arm body as a returned value, without IIFE wrapping.
    /// If the body is a Block, destructure it and return the last statement.
    fn emit_arm_body_as_return(&mut self, body: &HirExpr) {
        self.indent_in();
        self.newline();
        if let HirExpr::Block(b) = body {
            for (i, stmt) in b.stmts.iter().enumerate() {
                if i == b.stmts.len() - 1 {
                    self.emit_returned_stmt(stmt);
                    self.write(";");
                } else {
                    self.emit_expr(stmt, false);
                    self.write(";");
                    self.newline();
                }
            }
        } else {
            self.write("return ");
            self.emit_expr(body, true);
            self.write(";");
        }
        self.newline();
        self.indent_out();
    }

    fn emit_block(&mut self, e: &Block, value_used: bool) {
        let prev_declared = self.declared.clone();

        if value_used {
            self.write("(() => {");
            self.indent_in();
            self.newline();
            let last_idx = e.stmts.len().saturating_sub(1);
            for (i, stmt) in e.stmts.iter().enumerate() {
                if matches!(stmt, HirExpr::Error) {
                    continue;
                }
                if i == last_idx {
                    self.emit_returned_stmt(stmt);
                    if !Self::stmt_ends_with_brace(stmt) {
                        self.write(";");
                    }
                    self.newline();
                } else {
                    self.emit_expr(stmt, false);
                    if !Self::stmt_ends_with_brace(stmt) {
                        self.write(";");
                    }
                    self.newline();
                }
            }
            self.indent_out();
            self.write("})()");
        } else {
            for stmt in &e.stmts {
                if matches!(stmt, HirExpr::Error) {
                    continue;
                }
                self.emit_expr(stmt, false);
                if !Self::stmt_ends_with_brace(stmt) {
                    self.write(";");
                }
                self.newline();
            }
        }
        self.declared = prev_declared;
    }

    fn emit_if(&mut self, e: &If, value_used: bool) {
        if value_used && e.else_branch.is_some() {
            self.write("(() => {");
            self.indent_in();
            self.newline();

            for (i, branch) in e.branches.iter().enumerate() {
                if i > 0 {
                    self.write("} else ");
                }
                self.write("if (");
                self.emit_expr(&branch.condition, true);
                self.write(") {");
                self.emit_arm_body_as_return(&branch.body);
            }

            if let Some(else_body) = &e.else_branch {
                self.write("} else {");
                self.emit_arm_body_as_return(else_body);
            }

            self.write("}");
            self.newline();
            self.indent_out();
            self.write("})()");
        } else {
            for (i, branch) in e.branches.iter().enumerate() {
                if i > 0 {
                    self.write("} else ");
                }
                self.write("if (");
                self.emit_expr(&branch.condition, true);
                self.write(") {");
                self.indent_in();
                self.newline();
                self.emit_expr(&branch.body, false);
                self.newline();
                self.indent_out();
            }

            if let Some(else_body) = &e.else_branch {
                self.write("} else {");
                self.indent_in();
                self.newline();
                self.emit_expr(else_body, false);
                self.newline();
                self.indent_out();
            }

            self.write("}");
        }
    }

    fn emit_for_loop(&mut self, e: &ForLoop) {
        let iter_name = self.unique_name("$iter");
        let val_name = self.unique_name("$val");
        let var_name = self.interner.lookup(e.var);

        // Outer block scopes the iterator and value variables.
        self.write("{");
        self.indent_in();
        self.newline();
        self.write(&format!("const {} = ", iter_name));
        self.emit_expr(&e.iter, true);
        self.write(";");
        self.newline();
        self.write(&format!("let {};", val_name));
        self.newline();
        self.write(&format!("while (({} = {}.next()) !== undefined) {{", val_name, iter_name));
        self.indent_in();
        self.newline();
        self.write(&format!("const {} = {};", self.safe_name(var_name), val_name));
        self.newline();
        self.emit_expr(&e.body, false);
        self.newline();
        self.indent_out();
        self.write("}");
        self.newline();
        self.indent_out();
        self.write("}");
    }

    fn emit_return(&mut self, e: &Return) {
        self.write("return");
        if let Some(val) = &e.value {
            self.write(" ");
            self.emit_expr(val, true);
        }
    }

    // ── Functions ──

    fn emit_func_def(&mut self, e: &FuncDef) {
        let name = self.interner.lookup(e.name);
        self.write(&format!("function {}(", self.safe_name(name)));
        for (i, p) in e.params.iter().enumerate() {
            if i > 0 {
                self.write(", ");
            }
            let pname = self.interner.lookup(p.name);
            self.write(&self.safe_name(pname));
        }
        self.write(") {");
        self.indent_in();
        self.newline();

        if let HirExpr::Block(body) = &*e.body {
            for (i, stmt) in body.stmts.iter().enumerate() {
                if matches!(stmt, HirExpr::Error) {
                    continue;
                }
                if i == body.stmts.len() - 1 {
                    self.emit_returned_stmt(stmt);
                    if !Self::stmt_ends_with_brace(stmt) {
                        self.write(";");
                    }
                    self.newline();
                } else {
                    self.emit_expr(stmt, false);
                    if !Self::stmt_ends_with_brace(stmt) {
                        self.write(";");
                    }
                    self.newline();
                }
            }
        } else {
            self.write("return ");
            self.emit_expr(&e.body, true);
            self.write(";");
            self.newline();
        }

        self.write("}");
    }

    fn emit_anon_func(&mut self, e: &AnonFunc) {
        self.write("(");
        for (i, p) in e.params.iter().enumerate() {
            if i > 0 {
                self.write(", ");
            }
            let pname = self.interner.lookup(p.name);
            self.write(&self.safe_name(pname));
        }
        self.write(") => {");
        self.indent_in();
        self.newline();

        if let HirExpr::Block(body) = &*e.body {
            for (i, stmt) in body.stmts.iter().enumerate() {
                if matches!(stmt, HirExpr::Error) {
                    continue;
                }
                if i == body.stmts.len() - 1 {
                    self.emit_returned_stmt(stmt);
                    if !Self::stmt_ends_with_brace(stmt) {
                        self.write(";");
                    }
                    self.newline();
                } else {
                    self.emit_expr(stmt, false);
                    if !Self::stmt_ends_with_brace(stmt) {
                        self.write(";");
                    }
                    self.newline();
                }
            }
        } else {
            self.write("return ");
            self.emit_expr(&e.body, true);
            self.write(";");
            self.newline();
        }

        self.write("}");
    }

    // ── Calls and builtins ──

    fn emit_call(&mut self, e: &Call) {
        let name = self.interner.lookup(e.name);
        let safe = self.safe_name(name);

        if e.is_builtin
            && let Some(builtin) = crate::builtins::BuiltinFunc::try_from_name(name)
        {
            for helper in builtins::required_helpers(builtin) {
                self.require_helper(helper);
            }
            let arg_strs: Vec<String> = e.args.iter().map(|a| self.expr_to_string(a)).collect();
            let js = builtin.emit_js(&arg_strs.iter().map(|s| s.as_str()).collect::<Vec<&str>>());
            self.write(&js);
            return;
        }

        self.write(&safe);
        self.write("(");
        for (i, arg) in e.args.iter().enumerate() {
            if i > 0 {
                self.write(", ");
            }
            self.emit_expr(arg, true);
        }
        self.write(")");
    }

    fn emit_direct_call(&mut self, e: &DirectCall) {
        self.emit_expr(&e.callee, true);
        self.write("(");
        for (i, arg) in e.args.iter().enumerate() {
            if i > 0 {
                self.write(", ");
            }
            self.emit_expr(arg, true);
        }
        self.write(")");
    }

    // ── Pattern matching ──

    fn emit_match(&mut self, e: &Match, value_used: bool) {
        self.write("(() => {");
        self.indent_in();
        self.newline();

        let scrut = self.expr_to_string(&e.scrutinee);
        self.write(&format!("const $match$ = {};", scrut));
        self.newline();

        for (i, arm) in e.arms.iter().enumerate() {
            if i > 0 {
                self.write(" else ");
            }
            match &arm.kind {
                HirMatchArmKind::Some { binding } => {
                    self.write("if ($match$ !== null) {");
                    self.indent_in();
                    self.newline();
                    let bname = self.interner.lookup(*binding);
                    self.write(&format!("const {} = $match$;", self.safe_name(bname)));
                    self.newline();
                    if value_used {
                        self.write("return ");
                    }
                    self.emit_expr(&arm.body, true);
                    self.write(";");
                    self.newline();
                    self.indent_out();
                    self.write("}");
                }
                HirMatchArmKind::Variant { binding, .. } => {
                    self.write("{");
                    self.indent_in();
                    self.newline();
                    if let Some(b) = binding {
                        let bname = self.interner.lookup(*b);
                        self.write(&format!("const {} = $match$.$val;", self.safe_name(bname)));
                        self.newline();
                    }
                    if value_used {
                        self.write("return ");
                    }
                    self.emit_expr(&arm.body, true);
                    self.write(";");
                    self.newline();
                    self.indent_out();
                    self.write("}");
                }
                HirMatchArmKind::None | HirMatchArmKind::Else => {
                    self.write("{");
                    self.indent_in();
                    self.newline();
                    if value_used {
                        self.write("return ");
                    }
                    self.emit_expr(&arm.body, true);
                    self.write(";");
                    self.newline();
                    self.indent_out();
                    self.write("}");
                }
            }
        }

        self.indent_out();
        self.newline();
        self.write("})()");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::interner::Interner;
    use crate::lower::lower;
    use crate::parse;
    use crate::resolve::resolve_names;
    use crate::scan;
    use crate::source::SourceText;

    fn compile(source: &str) -> String {
        let src = SourceText::new("test.gema", source);
        let (tokens, sd) = scan::scan(&src, 0);
        assert!(!sd.has_errors(), "scan errors");
        let mut arena = crate::ast::AstArena::new();
        let mut interner = Interner::new();
        let mut diagnostics = crate::diagnostics::DiagnosticsBag::new();
        for d in sd.into_vec() {
            diagnostics.push(d);
        }
        let root = parse::parse(&tokens, &mut arena, &mut interner, &mut diagnostics, 0);
        assert!(!diagnostics.has_errors(), "parse errors");
        let scope_tree = resolve_names(&arena, root, &mut interner, &mut diagnostics, 0);
        assert!(!diagnostics.has_errors(), "resolve errors");
        let hir = lower(&arena, root, &scope_tree, &interner);
        codegen(&hir, &interner)
    }

    fn js_contains(source: &str, expected: &str) {
        let js = compile(source);
        assert!(
            js.contains(expected),
            "expected '{expected}' in JS output, got:\n{js}"
        );
    }

    #[test]
    fn int_lit() {
        js_contains("42i", "42n");
    }
    #[test]
    fn num_lit() {
        js_contains("3.14", "3.14");
    }
    #[test]
    fn str_lit() {
        js_contains("\"hello\"", "\"hello\"");
    }
    #[test]
    fn bool_lit_true() {
        js_contains("true", "true");
    }
    #[test]
    fn bool_lit_false() {
        js_contains("false", "false");
    }
    #[test]
    fn none_lit() {
        js_contains("none", "null");
    }
    #[test]
    fn binary_add() {
        js_contains("1i + 2i", "(1n + 2n)");
    }
    #[test]
    fn comparison() {
        js_contains("1i == 2i", "(1n == 2n)");
    }
    #[test]
    fn variable_assign() {
        let js = compile("x = 42i");
        assert!(js.contains("let x = 42n"), "got: {js}");
    }
    #[test]
    fn if_expr() {
        let js = compile("if true { 1i } else { 2i }");
        assert!(js.contains("if (true)"));
        assert!(js.contains("return 1n"));
    }
    #[test]
    fn for_loop() {
        let js = compile("for x = 1i..10i { x }");
        assert!(js.contains("while (("), "got: {js}");
        assert!(js.contains(".next())"), "got: {js}");
    }
    #[test]
    fn func_def() {
        let js = compile("func add(x: Int, y: Int): Int { x + y }");
        assert!(js.contains("function add("));
        assert!(js.contains("x + y"));
    }
    #[test]
    fn function_call() {
        let js = compile("func foo(x: Int): Int { x }; foo(1i)");
        assert!(js.contains("foo(1n"));
    }
    #[test]
    fn array_lit() {
        js_contains("[1i, 2i, 3i]", "[1n, 2n, 3n]");
    }
    #[test]
    fn tuple_lit() {
        js_contains("(1i, \"hi\")", "[1n, \"hi\"]");
    }
    #[test]
    fn struct_construction() {
        let js = compile("struct Point { x: Num, y: Num }; Point(1, 2)");
        assert!(js.contains("x:") && js.contains("y:"), "got: {js}");
    }
    #[test]
    fn field_access() {
        let js = compile("struct Point { x: Num, y: Num }; p = Point(1, 2); p.x");
        assert!(js.contains(").x") || js.contains("p.x"), "got: {js}");
    }

    // ── Runtime tests (require `bun` on PATH) ──

    fn bun_available() -> bool {
        std::process::Command::new("bun")
            .arg("--version")
            .output()
            .is_ok()
    }

    fn assert_run(source: &str, expected: &str) {
        if !bun_available() {
            eprintln!("skipping runtime test — bun not available");
            return;
        }
        let js = compile(source);
        // The compiled output has the form:
        //   // BUILTIN HELPERS //\nclass ...\n// PROGRAM //\n(() => { ... })()
        // Wrap in a console.log that captures the IIFE result.
        // Split at "// PROGRAM //\n" to get helpers and program separately.
        let program = if let Some(pos) = js.find("// PROGRAM //\n") {
            let (helpers, prog) = js.split_at(pos + "// PROGRAM //\n".len());
            format!(
                "{}\nconsole.log(String({}));",
                helpers.trim(),
                prog.trim()
            )
        } else {
            // No helpers — just wrap the whole thing.
            format!("console.log(String({}));", js.trim())
        };
        let output = std::process::Command::new("bun")
            .arg("-e")
            .arg(&program)
            .output()
            .expect("bun execution failed");
        let stdout = String::from_utf8(output.stdout).unwrap().trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            output.status.success(),
            "JS:\n{js}\nstderr:\n{stderr}"
        );
        assert_eq!(stdout, expected, "source: {source}\nJS:\n{js}");
    }

    #[test]
    fn run_int_lit() {
        assert_run("42i", "42");
    }
    #[test]
    fn run_num_lit() {
        assert_run("3.14", "3.14");
    }
    #[test]
    fn run_str_lit() {
        assert_run("\"hello\"", "hello");
    }
    #[test]
    fn run_bool_true() {
        assert_run("true", "true");
    }
    #[test]
    fn run_bool_false() {
        assert_run("false", "false");
    }
    #[test]
    fn run_none() {
        assert_run("none", "null");
    }
    #[test]
    fn run_binary_add() {
        assert_run("1i + 2i", "3");
    }
    #[test]
    fn run_binary_mul() {
        assert_run("3 * 4", "12");
    }
    #[test]
    fn run_comparison_eq() {
        assert_run("1i == 2i", "false");
    }
    #[test]
    fn run_comparison_lt() {
        assert_run("1i < 2i", "true");
    }
    #[test]
    fn run_variable() {
        assert_run("x = 42i; x", "42");
    }
    #[test]
    fn run_block() {
        assert_run("{ 1i; 2i; 3i }", "3");
    }
    #[test]
    fn run_if_else() {
        assert_run("if true { 1i } else { 2i }", "1");
    }
    #[test]
    fn run_if_else_false() {
        assert_run("if false { 1i } else { 2i }", "2");
    }
    #[test]
    fn run_func_call() {
        assert_run(
            "func add(x: Int, y: Int): Int { x + y }; add(1i, 2i)",
            "3",
        );
    }
    #[test]
    fn run_for_loop_sum() {
        assert_run("mut s = 0i; for x = 1i..3i { s = s + x }; s", "6");
    }
}
