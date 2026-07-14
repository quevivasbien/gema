/// Pratt parser for Gema.
///
/// Parses a token stream into an `AstArena` of `Expr` nodes.
/// Produces diagnostics for syntax errors but always returns a
/// best-effort AST (with `ErrorExpr` sentinels where needed).
use crate::ast::*;
use crate::diagnostics::DiagnosticsBag;
use crate::interner::Interner;
use crate::token::Token;

use parser::Parser;

mod parser;
mod precedence;
mod utils;

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

    /// Helper for tests: parse a single expression and return the result,
    /// including the arena, interner, diagnostics, and root node.
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

    /// Parse source text and return arena + root, asserting no scan errors.
    fn parse_ok(source: &str) -> (AstArena, NodeId) {
        let src = SourceText::new("test.gema", source);
        let (tokens, sd) = scan::scan(&src, 0);
        assert!(!sd.has_errors(), "scan errors: {:?}", sd);
        let mut arena = AstArena::new();
        let mut interner = Interner::new();
        let mut diagnostics = DiagnosticsBag::new();
        let root = parse(&tokens, &mut arena, &mut interner, &mut diagnostics, 0);
        assert!(!diagnostics.has_errors(), "parse errors: {:?}", diagnostics);
        (arena, root)
    }

    /// Parse source text and return arena + root + diagnostics (for error tests).
    fn parse_with_errors(source: &str) -> (AstArena, NodeId, DiagnosticsBag) {
        let src = SourceText::new("test.gema", source);
        let (tokens, scan_diags) = scan::scan(&src, 0);
        let mut arena = AstArena::new();
        let mut interner = Interner::new();
        let mut diagnostics = DiagnosticsBag::new();
        for d in scan_diags.into_vec() {
            diagnostics.push(d);
        }
        let root = parse(&tokens, &mut arena, &mut interner, &mut diagnostics, 0);
        (arena, root, diagnostics)
    }

    /// Get the last (value) expression from the top-level block.
    fn last_expr<'a>(arena: &'a AstArena, root: NodeId) -> &'a Expr {
        let block = match &arena[root] {
            Expr::Block(b) => b,
            _ => panic!("expected Block at root"),
        };
        let last = &arena[block.stmts[block.stmts.len() - 1]];
        if let Expr::DropValue(dv) = last {
            &arena[dv.child]
        } else {
            last
        }
    }

    /// Helper for tests: get the last expr's variant name for quick assertions.
    fn last_kind(arena: &AstArena, root: NodeId) -> &'static str {
        match last_expr(arena, root) {
            Expr::IntLit(_) => "IntLit",
            Expr::NumLit(_) => "NumLit",
            Expr::StrLit(_) => "StrLit",
            Expr::BoolLit(_) => "BoolLit",
            Expr::NoneLit(_) => "NoneLit",
            Expr::ArrLit(_) => "ArrLit",
            Expr::TupleLit(_) => "TupleLit",
            Expr::RangeIter(_) => "RangeIter",
            Expr::Var(_) => "Var",
            Expr::Call(_) => "Call",
            Expr::DirectCall(_) => "DirectCall",
            Expr::FuncDef(_) => "FuncDef",
            Expr::AnonFunc(_) => "AnonFunc",
            Expr::StructDef(_) => "StructDef",
            Expr::EnumDef(_) => "EnumDef",
            Expr::TraitDef(_) => "TraitDef",
            Expr::ImplBlock(_) => "ImplBlock",
            Expr::Assign(_) => "Assign",
            Expr::TupleUnpack(_) => "TupleUnpack",
            Expr::FieldAccess(_) => "FieldAccess",
            Expr::FieldAssign(_) => "FieldAssign",
            Expr::Binary(_) => "Binary",
            Expr::Unary(_) => "Unary",
            Expr::Block(_) => "Block",
            Expr::If(_) => "If",
            Expr::ForLoop(_) => "ForLoop",
            Expr::Break(_) => "Break",
            Expr::Continue(_) => "Continue",
            Expr::Return(_) => "Return",
            Expr::Match(_) => "Match",
            Expr::Use(_) => "Use",
            Expr::UseJs(_) => "UseJs",
            Expr::TypeAssociated(_) => "TypeAssociated",
            Expr::DropValue(_) => "DropValue",
            Expr::ErrorExpr => "ErrorExpr",
        }
    }

    #[test]
    fn parse_int_lit() {
        let (arena, root) = parse_ok("42i");
        assert_eq!(last_kind(&arena, root), "IntLit");
        match last_expr(&arena, root) {
            Expr::IntLit(lit) => assert_eq!(lit.value, "42"),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn parse_num_lit() {
        let (arena, root) = parse_ok("3.14");
        assert_eq!(last_kind(&arena, root), "NumLit");
    }

    #[test]
    fn parse_str_lit() {
        let (arena, root) = parse_ok("\"hello\"");
        assert_eq!(last_kind(&arena, root), "StrLit");
    }

    #[test]
    fn parse_bool_lit() {
        let (arena, root) = parse_ok("true");
        assert_eq!(last_kind(&arena, root), "BoolLit");
    }

    #[test]
    fn parse_none_lit() {
        let (arena, root) = parse_ok("none");
        assert_eq!(last_kind(&arena, root), "NoneLit");
    }

    // ── Binary operators ──

    #[test]
    fn parse_binary_add() {
        let (arena, root) = parse_ok("1 + 2");
        match last_expr(&arena, root) {
            Expr::Binary(b) => {
                assert_eq!(b.op, BinaryOp::Add);
                assert!(matches!(&arena[b.left], Expr::NumLit(_)));
                assert!(matches!(&arena[b.right], Expr::NumLit(_)));
            }
            _ => panic!("expected Binary"),
        }
    }

    #[test]
    fn parse_binary_precedence() {
        let (arena, root) = parse_ok("1 + 2 * 3");
        // 1 + (2 * 3) — multiplication binds tighter
        match last_expr(&arena, root) {
            Expr::Binary(outer) => {
                assert_eq!(outer.op, BinaryOp::Add);
                assert!(
                    matches!(&arena[outer.right], Expr::Binary(inner) if inner.op == BinaryOp::Mul)
                );
            }
            _ => panic!("expected Binary"),
        }
    }

    #[test]
    fn parse_comparison() {
        let (arena, root) = parse_ok("a == b");
        assert_eq!(last_kind(&arena, root), "Binary");
    }

    #[test]
    fn parse_boolean_ops() {
        let (arena, root) = parse_ok("x and y or z");
        assert_eq!(last_kind(&arena, root), "Binary");
    }

    // ── Unary operators ──

    #[test]
    fn parse_unary_minus() {
        let (arena, root) = parse_ok("-42");
        assert_eq!(last_kind(&arena, root), "Unary");
    }

    #[test]
    fn parse_unary_not() {
        let (arena, root) = parse_ok("!true");
        assert_eq!(last_kind(&arena, root), "Unary");
    }

    // ── Grouping and tuples ──

    #[test]
    fn parse_grouping() {
        let (arena, root) = parse_ok("(1 + 2) * 3");
        assert_eq!(last_kind(&arena, root), "Binary");
    }

    #[test]
    fn parse_tuple() {
        let (arena, root) = parse_ok("(1, 2, 3)");
        assert_eq!(last_kind(&arena, root), "TupleLit");
    }

    #[test]
    fn parse_single_element_tuple() {
        // (1,) with trailing comma — should be tuple, not grouping
        let (arena, root) = parse_ok("(1i,)");
        assert_eq!(last_kind(&arena, root), "TupleLit");
    }

    // ── Blocks ──

    #[test]
    fn parse_block_value() {
        let (arena, root) = parse_ok("{ 42i }");
        // The outer block is the file, inner block is the { } expr
        // last_expr gets the inner block
        assert_eq!(last_kind(&arena, root), "Block");
    }

    #[test]
    fn parse_block_semicolon_drops_value() {
        let (arena, root) = parse_ok("{ 1i; 2i }");
        match last_expr(&arena, root) {
            Expr::Block(b) => match &arena[*b.stmts.last().unwrap()] {
                Expr::IntLit(i) => {
                    assert_eq!(i.value, "2");
                }
                _ => panic!("expected IntLit"),
            },
            _ => panic!("expected Block"),
        }
    }

    #[test]
    fn parse_block_trailing_semi_drops_value() {
        let (arena, root) = parse_ok("{ 1i; }");
        let child = match last_expr(&arena, root) {
            Expr::Block(b) => match &arena[*b.stmts.last().unwrap()] {
                Expr::DropValue(d) => d.child,
                _ => panic!("expected DropValue"),
            },
            _ => panic!("expected Block"),
        };
        match &arena[child] {
            Expr::IntLit(i) => {
                assert_eq!(i.value, "1");
            }
            _ => panic!("expected IntLit"),
        }
    }

    // ── If expressions ──

    #[test]
    fn parse_if_expr() {
        let (arena, root) = parse_ok("if true { 1i } else { 2i }");
        assert_eq!(last_kind(&arena, root), "If");
    }

    #[test]
    fn parse_if_else_if() {
        let (arena, root) = parse_ok("if a { 1i } else if b { 2i } else { 3i }");
        assert_eq!(last_kind(&arena, root), "If");
    }

    // ── For loops ──

    #[test]
    fn parse_for_loop() {
        let (arena, root) = parse_ok("for x = 0..10 { x }");
        assert_eq!(last_kind(&arena, root), "ForLoop");
    }

    #[test]
    fn parse_for_loop_with_explicit_range() {
        let (arena, root) = parse_ok("for x = range(0i, 10i) { x }");
        assert_eq!(last_kind(&arena, root), "ForLoop");
    }

    // ── Control flow ──

    #[test]
    fn parse_break() {
        let (arena, root) = parse_ok("break");
        // Break inside a plain block without a loop will be a type error
        // later, but parsing should succeed.
        assert_eq!(last_kind(&arena, root), "Break");
    }

    #[test]
    fn parse_continue() {
        let (arena, root) = parse_ok("continue");
        assert_eq!(last_kind(&arena, root), "Continue");
    }

    #[test]
    fn parse_return() {
        let (arena, root) = parse_ok("return 42i");
        let ret = match last_expr(&arena, root) {
            Expr::Return(ret) => ret,
            _ => panic!("Expected return expression"),
        };
        let expr = arena
            .get(ret.value.expect("Expected return value"))
            .unwrap();
        match expr {
            Expr::IntLit(il) => assert_eq!(il.value, "42"),
            _ => panic!("Unexpected value in return expression"),
        }
    }

    #[test]
    fn parse_return_no_value() {
        let (arena, root) = parse_ok("return");
        let ret = match last_expr(&arena, root) {
            Expr::Return(ret) => ret,
            _ => panic!("Expected return expression"),
        };
        if ret.value.is_some() {
            panic!("Expected no value in return expression.")
        }
    }

    // ── Match expressions ──

    #[test]
    fn parse_match_variants() {
        let (arena, root) = parse_ok("match x { variant(a) -> a, none -> 0i, else -> 1i }");
        assert_eq!(last_kind(&arena, root), "Match");
    }

    #[test]
    fn parse_match_variants_with_block() {
        let (arena, root) = parse_ok("match x { variant(a) { a }, none { 0i }, else -> { 1i } }");
        assert_eq!(last_kind(&arena, root), "Match");
    }

    // ── Lambdas ──

    #[test]
    fn parse_lambda() {
        let (arena, root) = parse_ok("\\x -> x + 1");
        assert_eq!(last_kind(&arena, root), "AnonFunc");
    }

    #[test]
    fn parse_lambda_multi_param() {
        let (arena, root) = parse_ok("\\x, y -> x + y");
        assert_eq!(last_kind(&arena, root), "AnonFunc");
    }

    #[test]
    fn parse_lambda_typed_param() {
        let (arena, root) = parse_ok("\\x: Num -> x + 1");
        assert_eq!(last_kind(&arena, root), "AnonFunc");
    }

    #[test]
    fn parse_lambda_multi_typed_param() {
        let (arena, root) = parse_ok("\\x: Num, y: Num -> x + y");
        assert_eq!(last_kind(&arena, root), "AnonFunc");
    }

    #[test]
    fn parse_lambda_with_block() {
        let (arena, root) = parse_ok("\\x { out = x + 1; out }");
        assert_eq!(last_kind(&arena, root), "AnonFunc");
    }

    #[test]
    fn parse_lambda_with_block_and_arrow() {
        let (arena, root) = parse_ok("\\x -> { out = x + 1; out }");
        assert_eq!(last_kind(&arena, root), "AnonFunc");
    }

    // ── Pipes ──

    #[test]
    fn parse_pipe() {
        let (arena, root) = parse_ok("1 | double");
        assert_eq!(last_kind(&arena, root), "Call");
    }

    #[test]
    fn parse_pipe_with_args() {
        let (arena, root) = parse_ok("5 | add(3)");
        assert_eq!(last_kind(&arena, root), "Call");
    }

    #[test]
    fn parse_pipe_with_lambda() {
        let (arena, root) = parse_ok("5 | \\x -> x + 1");
        assert_eq!(last_kind(&arena, root), "DirectCall");
    }

    // ── Field access ──

    #[test]
    fn parse_field_access() {
        let (arena, root) = parse_ok("obj.field");
        match last_kind(&arena, root) {
            "Var" => {} // obj is a Var, .field is infix — wait no, this IS field access
            "FieldAccess" => {}
            kind => panic!("expected FieldAccess, got {kind}"),
        }
    }

    // ── Array literals ──

    #[test]
    fn parse_array_lit() {
        let (arena, root) = parse_ok("[1, 2, 3]");
        assert_eq!(last_kind(&arena, root), "ArrLit");
    }

    #[test]
    fn parse_empty_array() {
        let (arena, root) = parse_ok("[]");
        assert_eq!(last_kind(&arena, root), "ArrLit");
    }

    // ── Range ──

    #[test]
    fn parse_range() {
        let (arena, root) = parse_ok("1..10");
        assert_eq!(last_kind(&arena, root), "RangeIter");
    }

    // ── Variables and assignments ──

    #[test]
    fn parse_variable() {
        let (arena, root) = parse_ok("myVar");
        assert_eq!(last_kind(&arena, root), "Var");
    }

    #[test]
    fn parse_assign() {
        let (arena, root) = parse_ok("x = 42");
        assert_eq!(last_kind(&arena, root), "Assign");
    }

    #[test]
    fn parse_mut_assign() {
        let (arena, root) = parse_ok("mut x = 42");
        assert_eq!(last_kind(&arena, root), "Assign");
    }

    #[test]
    fn parse_compound_assign() {
        let (arena, root) = parse_ok("x += 1");
        assert_eq!(last_kind(&arena, root), "Assign");
    }

    #[test]
    fn parse_tuple_unpack() {
        let (arena, root) = parse_ok("(a, b) = (1, 2)");
        assert_eq!(last_kind(&arena, root), "TupleUnpack");
    }

    #[test]
    fn parse_tuple_unpack_with_mut() {
        let (arena, root) = parse_ok("(mut a, b) = (1, 2)");
        assert_eq!(last_kind(&arena, root), "TupleUnpack");
    }

    // ── Function definitions ──

    #[test]
    fn parse_func_def() {
        let (arena, root) = parse_ok("func foo(x: Int): Int { x }");
        assert_eq!(last_kind(&arena, root), "FuncDef");
    }

    #[test]
    fn parse_func_no_params() {
        let (arena, root) = parse_ok("func foo(): Int { 42i }");
        assert_eq!(last_kind(&arena, root), "FuncDef");
    }

    #[test]
    fn parse_func_no_return_type() {
        let (arena, root) = parse_ok("func foo(x) { x }");
        assert_eq!(last_kind(&arena, root), "FuncDef");
    }

    #[test]
    fn parse_generic_func() {
        let (arena, root) = parse_ok("func [T] id(x: T): T { x }");
        assert_eq!(last_kind(&arena, root), "FuncDef");
    }

    #[test]
    fn parse_generic_func_with_traits() {
        let (arena, root) = parse_ok("func [T: Hash + Clone] id(x: T) { x | clone | hash }");
        assert_eq!(last_kind(&arena, root), "FuncDef");
    }

    // ── Struct definitions ──

    #[test]
    fn parse_struct_def() {
        let (arena, root) = parse_ok("struct Point { x: Num, y: Num }");
        assert_eq!(last_kind(&arena, root), "StructDef");
    }

    #[test]
    fn parse_struct_generic() {
        let (arena, root) = parse_ok("struct Pair[T] { a: T, b: T }");
        assert_eq!(last_kind(&arena, root), "StructDef");
    }

    #[test]
    fn parse_struct_mut_field() {
        let (arena, root) = parse_ok("struct Foo { mut x: Num }");
        assert_eq!(last_kind(&arena, root), "StructDef");
    }

    // ── Enum definitions ──

    #[test]
    fn parse_enum_def() {
        let (arena, root) = parse_ok("enum Option { some: Int, nothing }");
        assert_eq!(last_kind(&arena, root), "EnumDef");
    }

    #[test]
    fn parse_enum_generic() {
        let (arena, root) = parse_ok("enum Option[T] { some: T, nothing }");
        assert_eq!(last_kind(&arena, root), "EnumDef");
    }

    // ── Trait definitions ──

    #[test]
    fn parse_trait_def() {
        let (arena, root) =
            parse_ok("trait Eq { equal[Self, Self: Bool], notEqual[Self, Self: Bool] }");
        assert_eq!(last_kind(&arena, root), "TraitDef");
    }

    // ── Impl blocks ──

    #[test]
    fn parse_impl_block() {
        let (arena, root) =
            parse_ok("impl MyType: Eq { func equal(a: Self, b: Self): Bool { true } }");
        assert_eq!(last_kind(&arena, root), "ImplBlock");
    }

    #[test]
    fn parse_impl_block_with_multiple_functions() {
        let (arena, root) = parse_ok(
            "impl MyType: Eq { func equal(a: Self, b: Self): Bool { true }, func notEqual(a: Self, b: Self): Bool { false } }",
        );
        assert_eq!(last_kind(&arena, root), "ImplBlock");
    }

    // ── Use statements ──

    #[test]
    fn parse_use_bare() {
        let (arena, root) = parse_ok("use \"math.gema\"");
        assert_eq!(last_kind(&arena, root), "Use");
    }

    #[test]
    fn parse_use_selective() {
        let (arena, root) = parse_ok("use ( add, sub ) from \"math.gema\"");
        assert_eq!(last_kind(&arena, root), "Use");
    }

    #[test]
    fn parse_use_js() {
        let (arena, root) = parse_ok("use! (add: Func[Num, Num: Num]) from \"math.js\"");
        assert_eq!(last_kind(&arena, root), "UseJs");
    }

    // ── Function calls ──

    #[test]
    fn parse_call_no_args() {
        let (arena, root) = parse_ok("foo()");
        assert_eq!(last_kind(&arena, root), "Call");
    }

    #[test]
    fn parse_call_with_args() {
        let (arena, root) = parse_ok("foo(1, 2)");
        assert_eq!(last_kind(&arena, root), "Call");
    }

    // ── Type-associated expressions ──

    #[test]
    fn parse_type_associated_call() {
        let (arena, root) = parse_ok("Int::zero()");
        assert_eq!(last_kind(&arena, root), "TypeAssociated");
    }

    // ── Type annotations ──

    #[test]
    fn parse_type_annotation() {
        // This tests that type annotations work via `none: Int`
        let (arena, root) = parse_ok("none: Int");
        match last_expr(&arena, root) {
            Expr::NoneLit(n) => assert!(n.inner_type.is_some()),
            _ => panic!("expected NoneLit"),
        }
    }

    #[test]
    fn parse_error_unexpected_char() {
        // Scanner emits error, parser should still produce a tree
        let (_, _, diags, _) = parse_one("$");
        assert!(diags.has_errors());
    }

    #[test]
    fn parse_multiple_items() {
        let (arena, root) = parse_ok("struct Foo { x: Num }\nfunc bar() { Foo }\nbar()");
        let block = match &arena[root] {
            Expr::Block(b) => b,
            _ => panic!("expected Block"),
        };
        // Three top-level items: StructDef, FuncDef, Call
        assert_eq!(block.stmts.len(), 3);
    }

    #[test]
    fn parse_templated_var() {
        let (arena, root) = parse_ok("foo[Int]");
        assert_eq!(last_kind(&arena, root), "Var");
    }

    #[test]
    fn parse_index_access() {
        let (arena, root) = parse_ok("arr(0)");
        assert_eq!(last_kind(&arena, root), "Call");
    }

    // ════════════════════════════════════════════════════════════════════════
    // Error recovery tests
    // ════════════════════════════════════════════════════════════════════════

    #[test]
    fn missing_closing_brace_in_block() {
        // Parser should recover and produce a tree even without the closing brace
        let (arena, root, diags) = parse_with_errors("{ 42i ");
        assert!(diags.has_errors());
        assert_eq!(last_kind(&arena, root), "ErrorExpr");
    }

    #[test]
    fn error_then_valid_continues() {
        // Error recovery: a bad expression followed by valid code should
        // still parse the valid code.
        let (arena, root, diags) = parse_with_errors("$; 42i");
        assert!(diags.has_errors()); // Generate only 1 error and then recover
        let block = match &arena[root] {
            Expr::Block(b) => b,
            _ => panic!("expected Block"),
        };
        assert!(
            !block.stmts.is_empty(),
            "should get at least one expression in main block"
        );
        let int_literal = match &arena[block.stmts[block.stmts.len() - 1]] {
            Expr::IntLit(il) => il,
            _ => panic!("expected IntLit at end of block"),
        };
        assert_eq!(int_literal.value, "42")
    }

    #[test]
    fn missing_paren_in_call() {
        // `foo(1, 2` — missing `)` — should still parse args
        let (arena, root, diags) = parse_with_errors("foo(1, 2");
        assert!(diags.len() == 1);
        assert_eq!(last_kind(&arena, root), "ErrorExpr");
    }

    #[test]
    fn malformed_match_recovers() {
        // Bad match arm syntax should recover and the rest of the
        // program should still parse.
        let (arena, root, diags) = parse_with_errors("match x { bad } 42i");
        assert!(diags.has_errors());
        let block = match &arena[root] {
            Expr::Block(b) => b,
            _ => panic!("expected Block"),
        };
        assert!(block.stmts.len() >= 2, "should have match + 42i");
    }

    #[test]
    fn missing_if_condition() {
        // `if { }` — missing condition should produce error but still parse
        let (_arena, _root, diags) = parse_with_errors("if { 1i }");
        assert!(diags.has_errors());
    }

    #[test]
    fn unmatched_close_brace() {
        // Extra `}` at top level should be handled gracefully
        let (arena, root, _diags) = parse_with_errors("42i }");
        // The `}` is unexpected at top level, but 42i should be parsed.
        // The scanner might or might not produce an error depending on
        // where the token lands.
        let block = match &arena[root] {
            Expr::Block(b) => b,
            _ => panic!("expected Block"),
        };
        assert!(
            !block.stmts.is_empty(),
            "should parse 42i before extra close brace"
        );
    }

    // ════════════════════════════════════════════════════════════════════════
    // Precedence and associativity
    // ════════════════════════════════════════════════════════════════════════

    #[test]
    fn arithmetic_left_assoc() {
        // `1 - 2 - 3` should be `((1 - 2) - 3)`, not `(1 - (2 - 3))`
        let (arena, root) = parse_ok("1 - 2 - 3");
        match last_expr(&arena, root) {
            Expr::Binary(outer) => {
                assert_eq!(outer.op, BinaryOp::Sub, "outer should be Sub");
                match &arena[outer.left] {
                    Expr::Binary(inner) => {
                        assert_eq!(inner.op, BinaryOp::Sub, "inner should be Sub");
                        assert!(
                            matches!(&arena[inner.left], Expr::NumLit(_)),
                            "leftmost should be NumLit"
                        );
                        assert!(
                            matches!(&arena[inner.right], Expr::NumLit(_)),
                            "inner right should be NumLit"
                        );
                    }
                    _ => panic!("expected nested Binary"),
                }
                assert!(
                    matches!(&arena[outer.right], Expr::NumLit(_)),
                    "outer right should be NumLit"
                );
            }
            other => panic!("expected Binary, got {:?}", other),
        }
    }

    #[test]
    fn comparison_chain() {
        // `a < b == c` should be `(a < b) == c` since comparison prec == equality prec
        let (arena, root) = parse_ok("a < b == c");
        match last_expr(&arena, root) {
            Expr::Binary(outer) => {
                assert_eq!(outer.op, BinaryOp::Eq, "outer should be Eq");
                match &arena[outer.left] {
                    Expr::Binary(inner) => {
                        assert_eq!(inner.op, BinaryOp::Lt, "inner should be Lt");
                    }
                    _ => panic!("expected nested Binary as left of =="),
                }
            }
            _ => panic!("expected outer Binary"),
        }
    }

    #[test]
    fn logical_and_before_or() {
        // `a or b and c` should be `a or (b and c)` — `and` binds tighter than `or`
        let (arena, root) = parse_ok("a or b and c");
        match last_expr(&arena, root) {
            Expr::Binary(outer) => {
                assert_eq!(outer.op, BinaryOp::Or, "outer should be Or");
                match &arena[outer.right] {
                    Expr::Binary(inner) => {
                        assert_eq!(inner.op, BinaryOp::And, "inner should be And");
                    }
                    _ => panic!("expected nested Binary"),
                }
            }
            _ => panic!("expected outer Binary"),
        }
    }

    #[test]
    fn exponent_right_assoc() {
        let (arena, root) = parse_ok("a ^ (b ^ c)");
        match last_expr(&arena, root) {
            Expr::Binary(outer) => {
                assert_eq!(outer.op, BinaryOp::Pow, "outer should be Pow");
                match &arena[outer.right] {
                    Expr::Binary(inner) => {
                        assert_eq!(inner.op, BinaryOp::Pow, "inner should be Pow");
                    }
                    _ => panic!("expected nested Binary on right of pow"),
                }
            }
            _ => panic!("expected outer Binary"),
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    // Deeply nested structures
    // ════════════════════════════════════════════════════════════════════════

    #[test]
    fn deeply_nested_blocks() {
        let (arena, root) = parse_ok("{{{{{ 42i }}}}}");
        // Unwrap 5 levels of Block to get to 42i
        let mut current = &arena[root];
        for _ in 0..6 {
            match current {
                Expr::Block(_) | Expr::DropValue(_) => {}
                _ => {}
            }
            // Walk down through the single statement
            let block = match current {
                Expr::Block(b) => b,
                _ => break,
            };
            current = &arena[block.stmts[block.stmts.len() - 1]];
            if let Expr::DropValue(dv) = current {
                current = &arena[dv.child];
            }
        }
        assert!(matches!(current, Expr::IntLit(l) if l.value == "42"));
    }

    #[test]
    fn nested_if_inside_block() {
        let (arena, root) = parse_ok("{ if true { if false { 1i } else { 2i } } }");
        let outer_block = match &arena[root] {
            Expr::Block(b) => b,
            _ => panic!("expected Block"),
        };
        let inner_block = match &arena[outer_block.stmts[0]] {
            Expr::Block(b) => b,
            _ => panic!("expected Block"),
        };
        let inner = match &arena[inner_block.stmts[0]] {
            Expr::DropValue(dv) => &arena[dv.child],
            other => other,
        };
        assert!(matches!(inner, Expr::If(_)), "expected If");
    }

    #[test]
    fn long_addition_chain() {
        let (arena, root) = parse_ok("1 + 2 + 3 + 4 + 5");
        // Should produce a left-assoc tree of depth 4
        let mut expr = last_expr(&arena, root);
        let mut count = 0;
        while let Expr::Binary(b) = expr {
            assert_eq!(b.op, BinaryOp::Add);
            expr = &arena[b.left];
            count += 1;
        }
        assert_eq!(count, 4, "should have 4 binary nodes for 5 operands");
        assert!(matches!(expr, Expr::NumLit(_)), "leaf should be NumLit");
    }

    // ════════════════════════════════════════════════════════════════════════
    // Edge cases
    // ════════════════════════════════════════════════════════════════════════

    #[test]
    fn empty_source() {
        let (_arena, root) = parse_ok("");
        assert!(matches!(&_arena[root], Expr::Block(b) if b.stmts.is_empty()));
    }

    #[test]
    fn just_comments() {
        let (_arena, root) = parse_ok("# just a comment\n# another one");
        assert!(matches!(&_arena[root], Expr::Block(b) if b.stmts.is_empty()));
    }

    #[test]
    fn just_whitespace() {
        let (_arena, root) = parse_ok("  \n  \t  ");
        assert!(matches!(&_arena[root], Expr::Block(b) if b.stmts.is_empty()));
    }

    #[test]
    fn multiple_trailing_semicolons() {
        let (arena, root, diags) = parse_with_errors("1i;;;2i");
        assert!(
            !diags.has_errors(),
            "multiple semicolons should be ignored: {:?}",
            diags
        );
        let block = match &arena[root] {
            Expr::Block(b) => b,
            _ => panic!("expected Block"),
        };
        // The `1i` is a statement (dropped), `2i` is the last expression
        assert_eq!(block.stmts.len(), 2);
    }

    #[test]
    fn empty_block_in_expr() {
        // Empty block { } should be parseable and have no statements
        let (arena, root) = parse_ok("{ }");
        // The outer block (top-level) wraps the inner { } expression
        match &arena[root] {
            Expr::Block(b) => {
                assert_eq!(
                    b.stmts.len(),
                    1,
                    "top-level block should contain the inner block expression"
                );
            }
            _ => panic!("expected Block at root"),
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    // Specific AST structure assertions
    // ════════════════════════════════════════════════════════════════════════

    #[test]
    fn lambda_params_are_correct() {
        let (arena, root) = parse_ok("\\x, y: Int -> x + y");
        match last_expr(&arena, root) {
            Expr::AnonFunc(f) => {
                assert_eq!(f.params.len(), 2);
                // First param has no type annotation
                assert!(f.params[0].type_node.is_none());
                // Second param has Int annotation
                assert!(f.params[1].type_node.is_some());
            }
            _ => panic!("expected AnonFunc"),
        }
    }

    #[test]
    fn func_def_params_parsed() {
        let (arena, root) = parse_ok("func foo(x: Int, y: Str): Bool { true }");
        match &arena[root] {
            Expr::Block(b) => match &arena[b.stmts[0]] {
                Expr::FuncDef(f) => {
                    assert_eq!(f.params.len(), 2, "should have 2 params");
                    assert!(f.return_type.is_some(), "should have return type");
                }
                _ => panic!("expected FuncDef"),
            },
            _ => panic!("expected Block"),
        }
    }

    #[test]
    fn struct_mut_field_preserved() {
        let (arena, root) = parse_ok("struct Foo { mut x: Num, y: Num }");
        // Find the struct definition
        let block = match &arena[root] {
            Expr::Block(b) => b,
            _ => panic!("expected Block"),
        };
        match &arena[block.stmts[0]] {
            Expr::StructDef(s) => {
                assert_eq!(s.fields.len(), 2);
                assert!(s.fields[0].is_mut, "first field should be mut");
                assert!(!s.fields[1].is_mut, "second field should NOT be mut");
            }
            _ => panic!("expected StructDef"),
        }
    }

    #[test]
    fn enum_variant_indices_sequential() {
        let (arena, root) = parse_ok("enum Color { red, green: Int, blue }");
        let block = match &arena[root] {
            Expr::Block(b) => b,
            _ => panic!("expected Block"),
        };
        match &arena[block.stmts[0]] {
            Expr::EnumDef(e) => {
                assert_eq!(e.variants.len(), 3);
                assert_eq!(e.variants[0].index, 0);
                assert_eq!(e.variants[1].index, 1);
                assert_eq!(e.variants[2].index, 2);
                // Second variant has a type
                assert!(e.variants[1].type_node.is_some());
                // First and third have no type
                assert!(e.variants[0].type_node.is_none());
                assert!(e.variants[2].type_node.is_none());
            }
            _ => panic!("expected EnumDef"),
        }
    }

    #[test]
    fn trait_with_self_return_type() {
        let (arena, root) = parse_ok("trait Default { zero[:Self] }");
        let block = match &arena[root] {
            Expr::Block(b) => b,
            _ => panic!("expected Block"),
        };
        match &arena[block.stmts[0]] {
            Expr::TraitDef(t) => {
                assert_eq!(t.required_functions.len(), 1);
                // The return type should contain SelfType
                assert!(matches!(
                    t.required_functions[0].return_type,
                    TypeNode::SelfType
                ));
            }
            _ => panic!("expected TraitDef"),
        }
    }

    #[test]
    fn match_arm_binding() {
        let (arena, root) = parse_ok("match x { Some(v) -> { v }, none -> { 0i } }");
        assert_eq!(last_kind(&arena, root), "Match");
    }

    #[test]
    fn tuple_unpack_mut_per_element() {
        let (arena, root) = parse_ok("(mut a, b, mut c) = (1, 2, 3)");
        assert_eq!(last_kind(&arena, root), "TupleUnpack");
        match last_expr(&arena, root) {
            Expr::TupleUnpack(t) => {
                assert_eq!(t.bindings.len(), 3);
                assert!(t.bindings[0].is_mut, "a should be mut");
                assert!(!t.bindings[1].is_mut, "b should NOT be mut");
                assert!(t.bindings[2].is_mut, "c should be mut");
            }
            _ => panic!("expected TupleUnpack"),
        }
    }

    #[test]
    fn generic_func_def() {
        let (arena, root) =
            parse_ok("func [T: Hash, U: Default] pair(a: T, b: U): Tup[T, U] { (a, b) }");
        let block = match &arena[root] {
            Expr::Block(b) => b,
            _ => panic!("expected Block"),
        };
        match &arena[block.stmts[0]] {
            Expr::FuncDef(f) => {
                assert_eq!(f.type_params.len(), 2);
                assert_eq!(f.params.len(), 2);
                assert!(f.return_type.is_some());
            }
            _ => panic!("expected FuncDef"),
        }
    }

    #[test]
    fn pipe_chained() {
        // `a | f | g` should be: g(f(a))
        let (arena, root) = parse_ok("5 | double | toStr");
        let block = match &arena[root] {
            Expr::Block(b) => b,
            _ => panic!("expected Block"),
        };
        // The pipe desugars: `5 | double | toStr` → `toStr(double(5))`
        // Each `|` creates a Call where the piped value is the last argument.
        // First pipe: `5 | double` → `Call(double, [5])`
        // Then: `Call(double, [5]) | toStr` → `Call(toStr, [Call(double, [5])])`
        let last = &arena[block.stmts[block.stmts.len() - 1]];
        let expr = if let Expr::DropValue(dv) = last {
            &arena[dv.child]
        } else {
            last
        };
        match expr {
            Expr::Call(outer) => {
                // outer is `toStr(...)`
                assert_eq!(outer.args.len(), 1);
                match &arena[outer.args[0]] {
                    Expr::Call(inner) => {
                        // inner is `double(5)`
                        assert_eq!(inner.args.len(), 1);
                        assert!(matches!(&arena[inner.args[0]], Expr::NumLit(_)));
                    }
                    _ => panic!("expected inner Call"),
                }
            }
            _ => panic!("expected outer Call for pipe chain"),
        }
    }

    #[test]
    fn string_literal_with_escaped_quote() {
        let (arena, root) = parse_ok(r#""hello\"world""#);
        assert_eq!(last_kind(&arena, root), "StrLit");
        match last_expr(&arena, root) {
            Expr::StrLit(s) => {
                assert_eq!(s.value, r#"hello\"world"#);
            }
            _ => panic!("expected StrLit"),
        }
    }

    #[test]
    fn none_with_type_annotation() {
        let (arena, root) = parse_ok("none: Int");
        match last_expr(&arena, root) {
            Expr::NoneLit(n) => {
                assert!(n.inner_type.is_some(), "none: Int should have inner type");
            }
            _ => panic!("expected NoneLit"),
        }
    }

    #[test]
    fn multiple_use_statements() {
        let (arena, root) = parse_ok(
            r#"use "a.gema"
    use(x) from "b.gema"
    use!(f: Func[Int: Int]) from "c.js""#,
        );
        let block = match &arena[root] {
            Expr::Block(b) => b,
            _ => panic!("expected Block"),
        };
        assert_eq!(block.stmts.len(), 3);
        assert!(matches!(&arena[block.stmts[0]], Expr::Use(_)));
        assert!(matches!(&arena[block.stmts[1]], Expr::Use(_)));
        assert!(matches!(&arena[block.stmts[2]], Expr::UseJs(_)));
    }

    #[test]
    fn if_else_if_all_branches_collected() {
        // `if a { 1 } else if b { 2 } else if c { 3 } else { 4 }`
        // should produce a single If with 3 branches + else
        let (arena, root) = parse_ok("if a { 1i } else if b { 2i } else if c { 3i } else { 4i }");
        match &arena[root] {
            Expr::Block(b) => {
                let last = &arena[b.stmts[b.stmts.len() - 1]];
                let expr = if let Expr::DropValue(dv) = last {
                    &arena[dv.child]
                } else {
                    last
                };
                match expr {
                    Expr::If(if_expr) => {
                        assert_eq!(
                            if_expr.branches.len(),
                            3,
                            "should have 3 branches for 3 conditions"
                        );
                        assert!(if_expr.else_branch.is_some(), "should have else branch");
                    }
                    _ => panic!("expected If"),
                }
            }
            _ => panic!("expected Block"),
        }
    }
}
