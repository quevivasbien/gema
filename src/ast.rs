/// AST node definitions for Gema.
///
/// All nodes live in a single `Arena<Expr>` (aliased as `AstArena`),
/// indexed by `NodeId` (a `Copy` `u32`).  See the module-level
/// documentation in `lib.rs` for usage patterns.
use id_arena::{Arena, Id};

use crate::interner::IdentId;
use crate::source::Span;

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/// A node ID — cheap `Copy` handle into the `AstArena`.
pub type NodeId = Id<Expr>;

/// The arena that owns all AST nodes.
pub type AstArena = Arena<Expr>;

// ---------------------------------------------------------------------------
// Expr — the central enum
// ---------------------------------------------------------------------------

/// Discriminated union of every AST node kind.
///
/// Each variant carries data either inline or via a named struct.
/// Named structs are used when the variant has several fields that
/// benefit from doc comments.
#[derive(Clone, Debug)]
pub enum Expr {
    // ── Literals ──
    IntLit(IntLit),
    NumLit(NumLit),
    StrLit(StrLit),
    BoolLit(BoolLit),
    NoneLit(NoneLit),

    // ── Collections ──
    ArrLit(ArrLit),
    TupleLit(TupleLit),
    RangeIter(RangeIter),

    // ── References and calls ──
    Var(Var),
    Call(Call),
    DirectCall(DirectCall),

    // ── Definitions ──
    FuncDef(FuncDef),
    AnonFunc(AnonFunc),
    StructDef(StructDef),
    EnumDef(EnumDef),
    TraitDef(TraitDef),
    ImplBlock(ImplBlock),

    // ── Variables and assignment ──
    Assign(Assign),
    TupleUnpack(TupleUnpack),
    FieldAccess(FieldAccess),
    FieldAssign(FieldAssign),

    // ── Operators ──
    Binary(Binary),
    Unary(Unary),

    // ── Control flow ──
    Block(Block),
    If(If),
    ForLoop(ForLoop),
    Break(Break),
    Continue(Continue),
    Return(Return),

    // ── Pattern matching ──
    Match(Match),

    // ── Modules ──
    Use(Use),
    UseJs(UseJs),

    // ── Type-associated (Foo::bar) ──
    TypeAssociated(TypeAssociated),

    // ── Value-discard wrapper ──
    DropValue(DropValue),

    /// Parser error-recovery sentinel.
    ErrorExpr,
}

// ---------------------------------------------------------------------------
// Helper enums
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BinaryOp {
    Add,    // +
    Sub,    // -
    Mul,    // *
    Div,    // /
    IntDiv, // //
    Mod,    // %
    EucMod, // %%
    Pow,    // ^
    Eq,     // ==
    Ne,     // !=
    Lt,     // <
    Le,     // <=
    Gt,     // >
    Ge,     // >=
    And,    // and
    Or,     // or
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnaryOp {
    Neg, // -
    Not, // !
}

/// The kind of pattern-match arm.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MatchArmKind {
    Some {
        binding: IdentId,
    },
    None,
    Variant {
        name: IdentId,
        binding: Option<IdentId>,
    },
    Else,
}

// ---------------------------------------------------------------------------
// Type annotations (produced by the parser, later resolved to TypeId)
// ---------------------------------------------------------------------------

/// A type annotation as written in source — before resolution.
#[derive(Clone, Debug, PartialEq)]
pub enum TypeNode {
    Int,
    Num,
    Str,
    Bool,
    Null,
    Named {
        name: IdentId,
        /// Type parameters (e.g. `Pair[Int, Str]` → two params).
        params: Vec<TypeNode>,
    },
    Func {
        params: Vec<TypeNode>,
        ret: Box<TypeNode>,
    },
    Arr(Box<TypeNode>),
    Iter(Box<TypeNode>),
    MutArr(Box<TypeNode>),
    Tup(Vec<TypeNode>),
    Dict {
        key: Box<TypeNode>,
        val: Box<TypeNode>,
    },
    MutDict {
        key: Box<TypeNode>,
        val: Box<TypeNode>,
    },
    Set(Box<TypeNode>),
    MutSet(Box<TypeNode>),
    Maybe(Box<TypeNode>),
    /// A reference to a generic type parameter (e.g. `T` in
    /// `func [T: Hash] identity(x: T): T`), optionally with trait
    /// bounds.
    TypeParamRef {
        name: IdentId,
        traits: Vec<IdentId>,
    },
    SelfType,
}

// ---------------------------------------------------------------------------
// Parameter and type-param helpers
// ---------------------------------------------------------------------------

/// A single function parameter.
#[derive(Clone, Debug)]
pub struct Param {
    pub name: IdentId,
    /// `None` when the type is inferred (e.g., in lambdas without type annotations).
    pub type_node: Option<TypeNode>,
}

/// A generic type parameter on a function, struct, or enum.
#[derive(Clone, Debug)]
pub struct TypeParam {
    pub name: IdentId,
    /// Trait bounds: `[T: Hash + Eq]`.
    pub traits: Vec<IdentId>,
}

/// A field in a struct definition.
#[derive(Clone, Debug)]
pub struct StructField {
    pub name: IdentId,
    pub type_node: TypeNode,
    pub is_mut: bool,
}

/// A variant in an enum definition.
#[derive(Clone, Debug)]
pub struct EnumVariant {
    pub name: IdentId,
    /// The type of the data carried by this variant, if any.
    pub type_node: Option<TypeNode>,
    /// The 0-based index of this variant within the enum.
    pub index: usize,
}

/// A match arm.
#[derive(Clone, Debug)]
pub struct MatchArm {
    pub kind: MatchArmKind,
    pub body: NodeId,
    pub span: Span,
}

/// A binding in tuple-unpacking syntax.
#[derive(Clone, Debug)]
pub struct UnpackBinding {
    pub name: IdentId,
    pub is_mut: bool,
}

/// A conditional branch in an `if` expression.
#[derive(Clone, Debug)]
pub struct ConditionalBranch {
    pub condition: NodeId,
    pub body: NodeId,
}

/// A function signature inside a trait definition.
#[derive(Clone, Debug)]
pub struct TraitFuncSig {
    pub name: IdentId,
    pub param_types: Vec<TypeNode>,
    pub return_type: TypeNode,
}

/// A symbol imported from a JS module via `use (x: T) from "path.js"`.
#[derive(Clone, Debug)]
pub struct JsImportSymbol {
    pub name: IdentId,
    pub type_node: TypeNode,
}

// ---------------------------------------------------------------------------
// Expr variant payloads
// ---------------------------------------------------------------------------

// ── Literals ──

#[derive(Clone, Debug)]
pub struct IntLit {
    pub span: Span,
    /// Numeric text without the `i` suffix, e.g. `"42"`.
    pub value: String,
}

#[derive(Clone, Debug)]
pub struct NumLit {
    pub span: Span,
    /// Numeric text as written, e.g. `"3.14"`, `"1e10"`.
    pub value: String,
}

#[derive(Clone, Debug)]
pub struct StrLit {
    pub span: Span,
    /// String content without the surrounding quotes.
    pub value: String,
}

#[derive(Clone, Debug)]
pub struct BoolLit {
    pub span: Span,
    pub value: bool,
}

#[derive(Clone, Debug)]
pub struct NoneLit {
    pub span: Span,
    /// The inner type `T` when explicitly annotated, e.g. `none: Int`
    /// produces `inner_type = Some(Int)`, yielding type `Maybe[Int]`.
    /// When `None`, the type must be inferred from usage context
    pub inner_type: Option<TypeNode>,
}

// ── Collections ──

#[derive(Clone, Debug)]
pub struct ArrLit {
    pub span: Span,
    pub elements: Vec<NodeId>,
    /// Optional element-type annotation, e.g. `[1, 2, 3]: Num`.
    /// When `None`, the type must be inferred from usage context.
    pub inner_type: Option<TypeNode>,
}

#[derive(Clone, Debug)]
pub struct TupleLit {
    pub span: Span,
    pub elements: Vec<NodeId>,
}

#[derive(Clone, Debug)]
pub struct RangeIter {
    pub span: Span,
    /// Start value.  Always required.
    pub start: NodeId,
    /// `None` for unbounded ranges `a..`.
    pub end: Option<NodeId>,
}

// ── References and calls ──

#[derive(Clone, Debug)]
pub struct Var {
    pub span: Span,
    pub name: IdentId,
    /// Argument type annotations -- this is used for annotating function definitions
    /// for use as a variable or value passed to a function call,
    /// required to disambiguate functions with the same name but different parameter types.
    /// E.g. `foo[T]` has `template_types = [T]`.
    pub template_types: Vec<TypeNode>,
}

#[derive(Clone, Debug)]
pub struct Call {
    pub span: Span,
    pub name: IdentId,
    pub args: Vec<NodeId>,
}

#[derive(Clone, Debug)]
pub struct DirectCall {
    pub span: Span,
    pub caller: NodeId,
    pub args: Vec<NodeId>,
    pub is_unsafe: bool,
}

// ── Definitions ──

#[derive(Clone, Debug)]
pub struct FuncDef {
    pub span: Span,
    pub name: IdentId,
    pub params: Vec<Param>,
    pub return_type: Option<TypeNode>,
    pub type_params: Vec<TypeParam>,
    pub body: NodeId,
}

#[derive(Clone, Debug)]
pub struct AnonFunc {
    pub span: Span,
    pub params: Vec<Param>,
    pub return_type: Option<TypeNode>,
    pub body: NodeId,
}

#[derive(Clone, Debug)]
pub struct StructDef {
    pub span: Span,
    pub name: IdentId,
    pub type_params: Vec<TypeParam>,
    pub fields: Vec<StructField>,
}

#[derive(Clone, Debug)]
pub struct EnumDef {
    pub span: Span,
    pub name: IdentId,
    pub type_params: Vec<TypeParam>,
    pub variants: Vec<EnumVariant>,
}

#[derive(Clone, Debug)]
pub struct TraitDef {
    pub span: Span,
    pub name: IdentId,
    pub required_functions: Vec<TraitFuncSig>,
}

#[derive(Clone, Debug)]
pub struct ImplBlock {
    pub span: Span,
    pub trait_name: IdentId,
    pub self_type: TypeNode,
    pub functions: Vec<NodeId>,
}

// ── Variables and assignment ──

#[derive(Clone, Debug)]
pub struct Assign {
    pub span: Span,
    pub name: IdentId,
    pub value: NodeId,
    pub is_mut: bool,
}

#[derive(Clone, Debug)]
pub struct TupleUnpack {
    pub span: Span,
    pub bindings: Vec<UnpackBinding>,
    pub source: NodeId,
}

#[derive(Clone, Debug)]
pub struct FieldAccess {
    pub span: Span,
    pub obj: NodeId,
    pub field: IdentId,
}

#[derive(Clone, Debug)]
pub struct FieldAssign {
    pub span: Span,
    pub obj: NodeId,
    pub field: IdentId,
    pub value: NodeId,
}

// ── Operators ──

#[derive(Clone, Debug)]
pub struct Binary {
    pub span: Span,
    pub op: BinaryOp,
    pub left: NodeId,
    pub right: NodeId,
}

#[derive(Clone, Debug)]
pub struct Unary {
    pub span: Span,
    pub op: UnaryOp,
    pub child: NodeId,
}

// ── Control flow ──

#[derive(Clone, Debug)]
pub struct Block {
    pub span: Span,
    pub stmts: Vec<NodeId>,
}

#[derive(Clone, Debug)]
pub struct If {
    pub span: Span,
    pub branches: Vec<ConditionalBranch>,
    pub else_branch: Option<NodeId>,
}

#[derive(Clone, Debug)]
pub struct ForLoop {
    pub span: Span,
    pub var_name: IdentId,
    pub iter: NodeId,
    pub body: NodeId,
}

#[derive(Clone, Debug)]
pub struct Break {
    pub span: Span,
}

#[derive(Clone, Debug)]
pub struct Continue {
    pub span: Span,
}

#[derive(Clone, Debug)]
pub struct Return {
    pub span: Span,
    pub value: Option<NodeId>,
}

// ── Pattern matching ──

#[derive(Clone, Debug)]
pub struct Match {
    pub span: Span,
    pub scrutinee: NodeId,
    pub arms: Vec<MatchArm>,
}

// ── Modules ──

#[derive(Clone, Debug)]
pub struct Use {
    pub span: Span,
    pub path: String,
    /// `None` = bare import (import everything);
    /// `Some([...])` = selective import.
    pub symbols: Option<Vec<IdentId>>,
}

#[derive(Clone, Debug)]
pub struct UseJs {
    pub span: Span,
    pub path: String,
    pub imports: Vec<JsImportSymbol>,
}

// ── Type-associated ──

#[derive(Clone, Debug)]
pub struct TypeAssociated {
    pub span: Span,
    pub type_node: TypeNode,
    pub inner: NodeId,
}

// ── Value-discard wrapper ──

#[derive(Clone, Debug)]
pub struct DropValue {
    pub span: Span,
    pub child: NodeId,
}

// ---------------------------------------------------------------------------
// span() — convenience accessor
// ---------------------------------------------------------------------------

impl Expr {
    /// The source span of this expression.
    pub fn span(&self) -> Span {
        match self {
            Expr::IntLit(e) => e.span,
            Expr::NumLit(e) => e.span,
            Expr::StrLit(e) => e.span,
            Expr::BoolLit(e) => e.span,
            Expr::NoneLit(e) => e.span,
            Expr::ArrLit(e) => e.span,
            Expr::TupleLit(e) => e.span,
            Expr::RangeIter(e) => e.span,
            Expr::Var(e) => e.span,
            Expr::Call(e) => e.span,
            Expr::DirectCall(e) => e.span,
            Expr::FuncDef(e) => e.span,
            Expr::AnonFunc(e) => e.span,
            Expr::StructDef(e) => e.span,
            Expr::EnumDef(e) => e.span,
            Expr::TraitDef(e) => e.span,
            Expr::ImplBlock(e) => e.span,
            Expr::Assign(e) => e.span,
            Expr::TupleUnpack(e) => e.span,
            Expr::FieldAccess(e) => e.span,
            Expr::FieldAssign(e) => e.span,
            Expr::Binary(e) => e.span,
            Expr::Unary(e) => e.span,
            Expr::Block(e) => e.span,
            Expr::If(e) => e.span,
            Expr::ForLoop(e) => e.span,
            Expr::Break(e) => e.span,
            Expr::Continue(e) => e.span,
            Expr::Return(e) => e.span,
            Expr::Match(e) => e.span,
            Expr::Use(e) => e.span,
            Expr::UseJs(e) => e.span,
            Expr::TypeAssociated(e) => e.span,
            Expr::DropValue(e) => e.span,
            Expr::ErrorExpr => Span::empty_at(0),
        }
    }
}

// ---------------------------------------------------------------------------
// Display impls
// ---------------------------------------------------------------------------

impl std::fmt::Display for BinaryOp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BinaryOp::Add => write!(f, "+"),
            BinaryOp::Sub => write!(f, "-"),
            BinaryOp::Mul => write!(f, "*"),
            BinaryOp::Div => write!(f, "/"),
            BinaryOp::IntDiv => write!(f, "//"),
            BinaryOp::Mod => write!(f, "%"),
            BinaryOp::EucMod => write!(f, "%%"),
            BinaryOp::Pow => write!(f, "^"),
            BinaryOp::Eq => write!(f, "=="),
            BinaryOp::Ne => write!(f, "!="),
            BinaryOp::Lt => write!(f, "<"),
            BinaryOp::Le => write!(f, "<="),
            BinaryOp::Gt => write!(f, ">"),
            BinaryOp::Ge => write!(f, ">="),
            BinaryOp::And => write!(f, "and"),
            BinaryOp::Or => write!(f, "or"),
        }
    }
}

impl std::fmt::Display for UnaryOp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            UnaryOp::Neg => write!(f, "-"),
            UnaryOp::Not => write!(f, "!"),
        }
    }
}

// ---------------------------------------------------------------------------
// Convenience constructors for building ASTs programmatically (tests)
// ---------------------------------------------------------------------------

/// Allocate an expression into an arena and return its `NodeId`.
pub fn alloc(arena: &mut AstArena, expr: Expr) -> NodeId {
    arena.alloc(expr)
}

/// Allocate a block with the given statements.
pub fn block(arena: &mut AstArena, span: Span, stmts: Vec<NodeId>) -> NodeId {
    arena.alloc(Expr::Block(Block { span, stmts }))
}

/// Allocate an integer literal.
pub fn int_lit(arena: &mut AstArena, span: Span, value: impl Into<String>) -> NodeId {
    arena.alloc(Expr::IntLit(IntLit {
        span,
        value: value.into(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arena_alloc_and_index() {
        let mut arena = AstArena::new();
        let id = int_lit(&mut arena, Span::new(0, 3), "42");
        match &arena[id] {
            Expr::IntLit(lit) => assert_eq!(lit.value, "42"),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn block_containing_multiple_nodes() {
        let mut arena = AstArena::new();
        let a = int_lit(&mut arena, Span::new(0, 1), "1");
        let b = int_lit(&mut arena, Span::new(2, 3), "2");
        let bop = arena.alloc(Expr::Binary(Binary {
            span: Span::new(0, 3),
            op: BinaryOp::Add,
            left: a,
            right: b,
        }));
        let blk = block(&mut arena, Span::new(0, 3), vec![bop]);
        assert!(matches!(&arena[blk], Expr::Block(_)));
    }

    #[test]
    fn create_complex_expr() {
        let mut arena = AstArena::new();
        let mut interner = crate::interner::Interner::new();

        let name = interner.intern("foo");
        let arg = int_lit(&mut arena, Span::new(5, 8), "42");
        let call = arena.alloc(Expr::Call(Call {
            span: Span::new(0, 8),
            name,
            args: vec![arg],
        }));

        match &arena[call] {
            Expr::Call(c) => {
                assert_eq!(interner.lookup(c.name), "foo");
                assert_eq!(c.args.len(), 1);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn binary_op_display() {
        assert_eq!(BinaryOp::Add.to_string(), "+");
        assert_eq!(BinaryOp::IntDiv.to_string(), "//");
        assert_eq!(BinaryOp::And.to_string(), "and");
    }

    #[test]
    fn error_expr_sentinel() {
        let mut arena = AstArena::new();
        let id = arena.alloc(Expr::ErrorExpr);
        assert!(matches!(arena[id], Expr::ErrorExpr));
    }

    #[test]
    fn bool_lit_carries_span() {
        let mut arena = AstArena::new();
        let id = arena.alloc(Expr::BoolLit(BoolLit {
            span: Span::new(0, 4),
            value: true,
        }));
        assert_eq!(arena[id].span(), Span::new(0, 4));
    }

    #[test]
    fn break_and_continue_carry_span() {
        let mut arena = AstArena::new();
        let brk = arena.alloc(Expr::Break(Break {
            span: Span::new(0, 5),
        }));
        let cont = arena.alloc(Expr::Continue(Continue {
            span: Span::new(6, 14),
        }));
        assert_eq!(arena[brk].span(), Span::new(0, 5));
        assert_eq!(arena[cont].span(), Span::new(6, 14));
    }

    #[test]
    fn all_variants_have_span() {
        // Verify that every Expr variant returns a span — we walk through
        // a list of all variants by constructing simple instances.
        let mut arena = AstArena::new();

        let cases: Vec<(Expr, Span)> = vec![
            (
                Expr::IntLit(IntLit {
                    span: Span::new(0, 3),
                    value: "42".into(),
                }),
                Span::new(0, 3),
            ),
            (
                Expr::NumLit(NumLit {
                    span: Span::new(0, 4),
                    value: "3.14".into(),
                }),
                Span::new(0, 4),
            ),
            (
                Expr::StrLit(StrLit {
                    span: Span::new(0, 7),
                    value: "hello".into(),
                }),
                Span::new(0, 7),
            ),
            (
                Expr::BoolLit(BoolLit {
                    span: Span::new(0, 4),
                    value: true,
                }),
                Span::new(0, 4),
            ),
            (
                Expr::NoneLit(NoneLit {
                    span: Span::new(0, 4),
                    inner_type: None,
                }),
                Span::new(0, 4),
            ),
            (
                Expr::Break(Break {
                    span: Span::new(0, 5),
                }),
                Span::new(0, 5),
            ),
            (
                Expr::Continue(Continue {
                    span: Span::new(0, 8),
                }),
                Span::new(0, 8),
            ),
            (Expr::ErrorExpr, Span::empty_at(0)),
        ];

        for (expr, expected_span) in cases {
            let id = arena.alloc(expr);
            assert_eq!(arena[id].span(), expected_span, "span mismatch for variant");
        }
    }
}
