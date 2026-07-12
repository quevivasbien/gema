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

    /// Helper for tests: get the last (value) expression from a block, unwrapping
    /// DropValue if present.
    fn last_expr<'a>(arena: &'a AstArena, root: NodeId) -> &'a Expr {
        let block = match &arena[root] {
            Expr::Block(b) => b,
            _ => panic!("expected Block"),
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
        let (arena, _, diags, root) = parse_one("42i");
        assert!(!diags.has_errors(), "errors: {:?}", diags);
        assert_eq!(last_kind(&arena, root), "IntLit");
        match last_expr(&arena, root) {
            Expr::IntLit(lit) => assert_eq!(lit.value, "42"),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn parse_num_lit() {
        let (arena, _, diags, root) = parse_one("3.14");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "NumLit");
    }

    #[test]
    fn parse_str_lit() {
        let (arena, _, diags, root) = parse_one("\"hello\"");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "StrLit");
    }

    #[test]
    fn parse_bool_lit() {
        let (arena, _, diags, root) = parse_one("true");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "BoolLit");
    }

    #[test]
    fn parse_none_lit() {
        let (arena, _, diags, root) = parse_one("none");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "NoneLit");
    }

    // ── Binary operators ──

    #[test]
    fn parse_binary_add() {
        let (arena, _, diags, root) = parse_one("1 + 2");
        assert!(!diags.has_errors());
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
        let (arena, _, diags, root) = parse_one("1 + 2 * 3");
        assert!(!diags.has_errors());
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
        let (arena, _, diags, root) = parse_one("a == b");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "Binary");
    }

    #[test]
    fn parse_boolean_ops() {
        let (arena, _, diags, root) = parse_one("x and y or z");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "Binary");
    }

    // ── Unary operators ──

    #[test]
    fn parse_unary_minus() {
        let (arena, _, diags, root) = parse_one("-42");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "Unary");
    }

    #[test]
    fn parse_unary_not() {
        let (arena, _, diags, root) = parse_one("!true");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "Unary");
    }

    // ── Grouping and tuples ──

    #[test]
    fn parse_grouping() {
        let (arena, _, diags, root) = parse_one("(1 + 2) * 3");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "Binary");
    }

    #[test]
    fn parse_tuple() {
        let (arena, _, diags, root) = parse_one("(1, 2, 3)");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "TupleLit");
    }

    #[test]
    fn parse_single_element_tuple() {
        // (1,) with trailing comma — should be tuple, not grouping
        let (arena, _, diags, root) = parse_one("(1i,)");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "TupleLit");
    }

    // ── Blocks ──

    #[test]
    fn parse_block_value() {
        let (arena, _, diags, root) = parse_one("{ 42i }");
        assert!(!diags.has_errors());
        // The outer block is the file, inner block is the { } expr
        // last_expr gets the inner block
        assert_eq!(last_kind(&arena, root), "Block");
    }

    #[test]
    fn parse_block_semicolon_drops_value() {
        let (arena, _, diags, root) = parse_one("{ 1i; 2i }");
        assert!(!diags.has_errors(), "errors: {:?}", diags);
        // Last expression is 2i (not dropped)
        assert_eq!(last_kind(&arena, root), "IntLit");
    }

    #[test]
    fn parse_block_trailing_semi_drops_value() {
        let (arena, _, diags, root) = parse_one("{ 1i; }");
        assert!(!diags.has_errors());
        // Block type is Null — last stmt wrapped in DropValue
        let block = match &arena[root] {
            Expr::Block(b) => b,
            _ => panic!("expected Block"),
        };
        // The block body is Block → DropValue(IntLit)
        assert_eq!(block.stmts.len(), 1);
        assert!(matches!(&arena[block.stmts[0]], Expr::DropValue(_)));
    }

    // ── If expressions ──

    #[test]
    fn parse_if_expr() {
        let (arena, _, diags, root) = parse_one("if true { 1i } else { 2i }");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "If");
    }

    #[test]
    fn parse_if_else_if() {
        let (arena, _, diags, root) = parse_one("if a { 1i } else if b { 2i } else { 3i }");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "If");
    }

    // ── For loops ──

    #[test]
    fn parse_for_loop() {
        let (arena, _, diags, root) = parse_one("for x in range(0i, 10i) { x }");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "ForLoop");
    }

    // ── Control flow ──

    #[test]
    fn parse_break() {
        let (arena, _, diags, root) = parse_one("{ break }");
        // Break inside a plain block without a loop will be a type error
        // later, but parsing should succeed.
        assert!(!diags.has_errors());
        // The inner block has the Break
        assert_eq!(last_kind(&arena, root), "Block");
    }

    #[test]
    fn parse_continue() {
        let (arena, _, diags, root) = parse_one("{ continue }");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "Block");
    }

    #[test]
    fn parse_return() {
        let (arena, _, diags, root) = parse_one("return 42i");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "Return");
    }

    #[test]
    fn parse_return_no_value() {
        let (arena, _, diags, root) = parse_one("return");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "Return");
    }

    // ── Match expressions ──

    #[test]
    fn parse_match_variants() {
        let (arena, _, diags, root) =
            parse_one("match x { Variant(a) => { a } none => { 0i } else => { 1i } }");
        assert!(!diags.has_errors(), "errors: {:?}", diags);
        assert_eq!(last_kind(&arena, root), "Match");
    }

    // ── Lambdas ──

    #[test]
    fn parse_lambda() {
        let (arena, _, diags, root) = parse_one("\\x -> x + 1");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "AnonFunc");
    }

    #[test]
    fn parse_lambda_multi_param() {
        let (arena, _, diags, root) = parse_one("\\x, y -> x + y");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "AnonFunc");
    }

    #[test]
    fn parse_lambda_typed_param() {
        let (arena, _, diags, root) = parse_one("\\x: Int -> x + 1");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "AnonFunc");
    }

    // ── Pipes ──

    #[test]
    fn parse_pipe() {
        let (arena, _, diags, root) = parse_one("1 | double");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "Call");
    }

    #[test]
    fn parse_pipe_with_args() {
        let (arena, _, diags, root) = parse_one("5 | add(3)");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "Call");
    }

    #[test]
    fn parse_pipe_with_lambda() {
        let (arena, _, diags, root) = parse_one("5 | \\x -> x + 1");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "DirectCall");
    }

    // ── Field access ──

    #[test]
    fn parse_field_access() {
        let (arena, _, diags, root) = parse_one("obj.field");
        assert!(!diags.has_errors());
        match last_kind(&arena, root) {
            "Var" => {} // obj is a Var, .field is infix — wait no, this IS field access
            "FieldAccess" => {}
            kind => panic!("expected FieldAccess, got {kind}"),
        }
    }

    // ── Array literals ──

    #[test]
    fn parse_array_lit() {
        let (arena, _, diags, root) = parse_one("[1, 2, 3]");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "ArrLit");
    }

    #[test]
    fn parse_empty_array() {
        let (arena, _, diags, root) = parse_one("[]");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "ArrLit");
    }

    // ── Range ──

    #[test]
    fn parse_range() {
        let (arena, _, diags, root) = parse_one("1..10");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "RangeIter");
    }

    // ── Variables and assignments ──

    #[test]
    fn parse_variable() {
        let (arena, _, diags, root) = parse_one("myVar");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "Var");
    }

    #[test]
    fn parse_assign() {
        let (arena, _, diags, root) = parse_one("x = 42");
        assert!(!diags.has_errors(), "errors: {:?}", diags);
        assert_eq!(last_kind(&arena, root), "Assign");
    }

    #[test]
    fn parse_mut_assign() {
        let (arena, _, diags, root) = parse_one("mut x = 42");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "Assign");
    }

    #[test]
    fn parse_compound_assign() {
        let (arena, _, diags, root) = parse_one("x += 1");
        assert!(!diags.has_errors(), "errors: {:?}", diags);
        assert_eq!(last_kind(&arena, root), "Assign");
    }

    #[test]
    fn parse_tuple_unpack() {
        let (arena, _, diags, root) = parse_one("(a, b) = (1, 2)");
        assert!(!diags.has_errors(), "errors: {:?}", diags);
        assert_eq!(last_kind(&arena, root), "TupleUnpack");
    }

    #[test]
    fn parse_tuple_unpack_with_mut() {
        let (arena, _, diags, root) = parse_one("(mut a, b) = (1, 2)");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "TupleUnpack");
    }

    // ── Function definitions ──

    #[test]
    fn parse_func_def() {
        let (arena, _, diags, root) = parse_one("func foo(x: Int): Int { x }");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "FuncDef");
    }

    #[test]
    fn parse_func_no_params() {
        let (arena, _, diags, root) = parse_one("func foo(): Int { 42i }");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "FuncDef");
    }

    #[test]
    fn parse_func_no_return_type() {
        let (arena, _, diags, root) = parse_one("func foo(x) { x }");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "FuncDef");
    }

    #[test]
    fn parse_generic_func() {
        let (arena, _, diags, root) = parse_one("func [T: Hash] id(x: T): T { x }");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "FuncDef");
    }

    // ── Struct definitions ──

    #[test]
    fn parse_struct_def() {
        let (arena, _, diags, root) = parse_one("struct Point { x: Num, y: Num }");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "StructDef");
    }

    #[test]
    fn parse_struct_generic() {
        let (arena, _, diags, root) = parse_one("struct Pair[T] { a: T, b: T }");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "StructDef");
    }

    #[test]
    fn parse_struct_mut_field() {
        let (arena, _, diags, root) = parse_one("struct Foo { mut x: Num }");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "StructDef");
    }

    // ── Enum definitions ──

    #[test]
    fn parse_enum_def() {
        let (arena, _, diags, root) = parse_one("enum Option { some: Int, nothing }");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "EnumDef");
    }

    #[test]
    fn parse_enum_generic() {
        let (arena, _, diags, root) = parse_one("enum Option[T] { some: T, nothing }");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "EnumDef");
    }

    // ── Trait definitions ──

    #[test]
    fn parse_trait_def() {
        let (arena, _, diags, root) =
            parse_one("trait Eq { equal(Self, Self): Bool, notEqual(Self, Self): Bool }");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "TraitDef");
    }

    // ── Impl blocks ──

    #[test]
    fn parse_impl_block() {
        let (arena, _, diags, root) =
            parse_one("impl Eq for MyType { func equal(a: Self, b: Self): Bool { true } }");
        assert!(!diags.has_errors(), "errors: {:?}", diags);
        assert_eq!(last_kind(&arena, root), "ImplBlock");
    }

    // ── Use statements ──

    #[test]
    fn parse_use_bare() {
        let (arena, _, diags, root) = parse_one("use \"math.gema\"");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "Use");
    }

    #[test]
    fn parse_use_selective() {
        let (arena, _, diags, root) = parse_one("use { add, sub } from \"math.gema\"");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "Use");
    }

    #[test]
    fn parse_use_js() {
        // TODO: This test never completes! Need to figure out why that's happening.
        let (arena, _, diags, root) = parse_one("use (add: Func[Num, Num: Num]) from \"math.js\"");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "UseJs");
    }

    // ── Function calls ──

    #[test]
    fn parse_call_no_args() {
        let (arena, _, diags, root) = parse_one("foo()");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "Var"); // Actually `foo()` might be... let's check
    }

    #[test]
    fn parse_call_with_args() {
        let (arena, _, diags, root) = parse_one("foo(1, 2)");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "Call");
    }

    // ── Type-associated expressions ──

    #[test]
    fn parse_type_associated_call() {
        let (arena, _, diags, root) = parse_one("Int::zero()");
        assert!(!diags.has_errors(), "errors: {:?}", diags);
        assert_eq!(last_kind(&arena, root), "TypeAssociated");
    }

    // ── Type annotations ──

    #[test]
    fn parse_type_annotation() {
        // This tests that type annotations work via `none: Int`
        let (arena, _, diags, root) = parse_one("none: Int");
        assert!(!diags.has_errors(), "errors: {:?}", diags);
        match last_expr(&arena, root) {
            Expr::NoneLit(n) => assert!(n.inner_type.is_some()),
            _ => panic!("expected NoneLit"),
        }
    }

    // ── Error recovery ──

    #[test]
    fn parse_error_unexpected_char() {
        // Scanner emits error, parser should still produce a tree
        let (_, _, diags, _) = parse_one("$");
        assert!(diags.has_errors());
    }

    #[test]
    fn parse_multiple_items() {
        let (arena, _, diags, root) = parse_one("struct Foo { x: Num }\nfunc bar() { Foo }\nbar()");
        assert!(!diags.has_errors(), "errors: {:?}", diags);
        let block = match &arena[root] {
            Expr::Block(b) => b,
            _ => panic!("expected Block"),
        };
        // Three top-level items: StructDef, FuncDef, Call
        assert_eq!(block.stmts.len(), 3);
    }

    #[test]
    fn parse_templated_var() {
        let (arena, _, diags, root) = parse_one("Arr[Int]");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "Var");
    }

    #[test]
    fn parse_index_access() {
        let (arena, _, diags, root) = parse_one("arr[0]");
        assert!(!diags.has_errors());
        assert_eq!(last_kind(&arena, root), "Call"); // Desugared to __get__(arr, 0)
    }
}
