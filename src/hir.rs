/// Codegen IR — the "HIR" (High-level IR).
///
/// The HIR is produced by lowering from the AST and consumed by
/// codegen.  It is a flat, desugared tree close to the JavaScript
/// target.  Pipes, `TypeAssociated` expressions, and other
/// AST-only constructs are gone — everything is a call, literal,
/// or control-flow construct.
///
/// The HIR is **not** arena-allocated — it is an owned tree using
/// `Box` for single children and `Vec` for lists.  This keeps the
/// representation simple: lowering produces a root `HirExpr`,
/// and codegen traverses it recursively.
///
/// Because monomorphization / dictionary-passing runs as a
/// HIR-to-HIR transform, the `FuncDef` variant carries
/// `type_params` so generic functions can be identified and
/// transformed before codegen.
use crate::interner::IdentId;
use crate::source::Span;

// ===========================================================================
// HirExpr
// ===========================================================================

/// A node in the codegen IR tree.
#[derive(Clone, Debug)]
pub enum HirExpr {
    // ── Literals ──
    IntLit(IntLit),
    NumLit(NumLit),
    StrLit(StrLit),
    BoolLit(BoolLit),
    NoneLit(NoneLit),

    // ── Variable reference ──
    Ident(IdentNode),

    // ── Collections ──
    ArrLit(ArrLit),
    TupleLit(TupleLit),
    RangeLit(RangeLit),

    // ── Struct, enum, and type descriptor construction ──
    StructLit(StructLit),
    EnumLit(EnumLit),
    TypeDescriptor(TypeDescriptor),

    // ── Operators ──
    Binary(Binary),
    Unary(Unary),

    // ── Assignment, field access, and indexing ──
    Assign(Assign),
    FieldAccess(FieldAccess),
    FieldAssign(FieldAssign),
    TupleIndex(TupleIndex),

    // ── Control flow ──
    Block(Block),
    If(If),
    ForLoop(ForLoop),
    Break(Break),
    Continue(Continue),
    Return(Return),

    // ── Functions and calls ──
    FuncDef(FuncDef),
    AnonFunc(AnonFunc),
    Call(Call),
    DirectCall(DirectCall),

    // ── Pattern matching ──
    Match(Match),

    /// Error-recovery sentinel — codegen emits nothing.
    Error,
}

// ===========================================================================
// Helper enums
// ===========================================================================

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HirBinaryOp {
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
pub enum HirUnaryOp {
    Neg, // -
    Not, // !
}

/// A pattern-match arm kind.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HirMatchArmKind {
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

// ===========================================================================
// Parameter and type-param helpers
// ===========================================================================

/// A single function parameter (name only — types are resolved before
/// lowering).
#[derive(Clone, Debug)]
pub struct FuncParam {
    pub name: IdentId,
}

/// A generic type parameter on a function definition.
///
/// Carried so the dictionary-passing transform can identify which
/// functions are generic and what trait bounds their type params
/// require.
#[derive(Clone, Debug)]
pub struct TypeParam {
    pub name: IdentId,
    pub trait_bounds: Vec<IdentId>,
}

/// A match arm.
#[derive(Clone, Debug)]
pub struct MatchArm {
    pub kind: HirMatchArmKind,
    pub body: Box<HirExpr>,
    pub span: Span,
}

/// A conditional branch in an if-expression.
#[derive(Clone, Debug)]
pub struct ConditionalBranch {
    pub condition: Box<HirExpr>,
    pub body: Box<HirExpr>,
}

// ===========================================================================
// Variant payloads
// ===========================================================================

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
    /// Numeric text as written, e.g. `"3.14"`.
    pub value: String,
}

#[derive(Clone, Debug)]
pub struct StrLit {
    pub span: Span,
    /// String contents without surrounding quotes.
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
}

// ── Variable reference ──

#[derive(Clone, Debug)]
pub struct IdentNode {
    pub span: Span,
    pub name: IdentId,
    /// When this ident refers to a specific function overload (e.g.
    /// `foo[Num]`), this holds the AST NodeId of the selected FuncDef.
    /// Codegen uses this to emit the machine name.
    pub def_node: Option<crate::ast::NodeId>,
}

// ── Collections ──

#[derive(Clone, Debug)]
pub struct ArrLit {
    pub span: Span,
    pub elements: Vec<HirExpr>,
}

#[derive(Clone, Debug)]
pub struct TupleLit {
    pub span: Span,
    pub elements: Vec<HirExpr>,
}

#[derive(Clone, Debug)]
pub struct RangeLit {
    pub span: Span,
    pub start: Box<HirExpr>,
    pub end: Option<Box<HirExpr>>,
}

// ── Struct and enum construction ──

#[derive(Clone, Debug)]
pub struct StructLit {
    pub span: Span,
    pub name: IdentId,
    pub fields: Vec<(IdentId, HirExpr)>,
}

#[derive(Clone, Debug)]
pub struct EnumLit {
    pub span: Span,
    pub enum_name: IdentId,
    pub tag: IdentId,
    pub value: Option<Box<HirExpr>>,
    pub is_tagged_union: bool,
}

/// A type descriptor object constructed during monomorphization.
/// Descriptors map trait method names to their implementations for a
/// concrete type, and are passed as extra arguments to generic functions.
#[derive(Clone, Debug)]
pub struct TypeDescriptor {
    pub span: Span,
    /// The concrete type this descriptor is for (e.g., `Int`).
    pub type_name: IdentId,
    /// Trait method implementations: (method_name, implementation_expr).
    pub methods: Vec<(IdentId, HirExpr)>,
}

// ── Operators ──

#[derive(Clone, Debug)]
pub struct Binary {
    pub span: Span,
    pub op: HirBinaryOp,
    pub left: Box<HirExpr>,
    pub right: Box<HirExpr>,
}

#[derive(Clone, Debug)]
pub struct Unary {
    pub span: Span,
    pub op: HirUnaryOp,
    pub child: Box<HirExpr>,
}

// ── Assignment and field access ──

#[derive(Clone, Debug)]
pub struct Assign {
    pub span: Span,
    pub name: IdentId,
    pub value: Box<HirExpr>,
    pub is_mut: bool,
}

#[derive(Clone, Debug)]
pub struct FieldAccess {
    pub span: Span,
    pub obj: Box<HirExpr>,
    pub field: IdentId,
}

#[derive(Clone, Debug)]
pub struct FieldAssign {
    pub span: Span,
    pub obj: Box<HirExpr>,
    pub field: IdentId,
    pub value: Box<HirExpr>,
}

#[derive(Clone, Debug)]
pub struct TupleIndex {
    pub span: Span,
    pub obj: Box<HirExpr>,
    pub index: usize,
}

// ── Control flow ──

#[derive(Clone, Debug)]
pub struct Block {
    pub span: Span,
    pub stmts: Vec<HirExpr>,
}

#[derive(Clone, Debug)]
pub struct If {
    pub span: Span,
    pub branches: Vec<ConditionalBranch>,
    pub else_branch: Option<Box<HirExpr>>,
}

#[derive(Clone, Debug)]
pub struct ForLoop {
    pub span: Span,
    pub var: IdentId,
    pub iter: Box<HirExpr>,
    pub body: Box<HirExpr>,
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
    pub value: Option<Box<HirExpr>>,
}

// ── Functions and calls ──

#[derive(Clone, Debug)]
    pub struct FuncDef {
        pub span: Span,
        pub name: IdentId,
        pub params: Vec<FuncParam>,
        pub body: Box<HirExpr>,
        pub type_params: Vec<TypeParam>,
        /// The AST NodeId of the FuncDef expression this was lowered from.
        /// Used by codegen to assign unique machine names.
        pub node_id: crate::ast::NodeId,
    }

#[derive(Clone, Debug)]
pub struct AnonFunc {
    pub span: Span,
    pub params: Vec<FuncParam>,
    pub body: Box<HirExpr>,
}
#[derive(Clone, Debug)]
pub struct Call {
    pub span: Span,
    pub name: IdentId,
    pub args: Vec<HirExpr>,
    /// True when this call invokes a builtin function (map, filter,
    /// etc.) rather than a user-defined function.
    pub is_builtin: bool,
    /// The AST NodeId of the called function's FuncDef expression.
    /// Used by codegen to look up the machine name.
    pub def_node: crate::ast::NodeId,
}

#[derive(Clone, Debug)]
pub struct DirectCall {
    pub span: Span,
    pub callee: Box<HirExpr>,
    pub args: Vec<HirExpr>,
}

// ── Pattern matching ──

#[derive(Clone, Debug)]
pub struct Match {
    pub span: Span,
    pub scrutinee: Box<HirExpr>,
    pub arms: Vec<MatchArm>,
}

// ===========================================================================
// span() convenience
// ===========================================================================

impl HirExpr {
    pub fn span(&self) -> Span {
        match self {
            HirExpr::IntLit(e) => e.span,
            HirExpr::NumLit(e) => e.span,
            HirExpr::StrLit(e) => e.span,
            HirExpr::BoolLit(e) => e.span,
            HirExpr::NoneLit(e) => e.span,
            HirExpr::Ident(e) => e.span,
            HirExpr::ArrLit(e) => e.span,
            HirExpr::TupleLit(e) => e.span,
            HirExpr::RangeLit(e) => e.span,
            HirExpr::StructLit(e) => e.span,
            HirExpr::EnumLit(e) => e.span,
            HirExpr::TypeDescriptor(e) => e.span,
            HirExpr::Binary(e) => e.span,
            HirExpr::Unary(e) => e.span,
            HirExpr::Assign(e) => e.span,
            HirExpr::FieldAccess(e) => e.span,
            HirExpr::FieldAssign(e) => e.span,
            HirExpr::TupleIndex(e) => e.span,
            HirExpr::Block(e) => e.span,
            HirExpr::If(e) => e.span,
            HirExpr::ForLoop(e) => e.span,
            HirExpr::Break(e) => e.span,
            HirExpr::Continue(e) => e.span,
            HirExpr::Return(e) => e.span,
            HirExpr::FuncDef(e) => e.span,
            HirExpr::AnonFunc(e) => e.span,
            HirExpr::Call(e) => e.span,
            HirExpr::DirectCall(e) => e.span,
            HirExpr::Match(e) => e.span,
            HirExpr::Error => Span::empty_at(0),
        }
    }
}

// ===========================================================================
// Display impls
// ===========================================================================

impl std::fmt::Display for HirBinaryOp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HirBinaryOp::Add => write!(f, "+"),
            HirBinaryOp::Sub => write!(f, "-"),
            HirBinaryOp::Mul => write!(f, "*"),
            HirBinaryOp::Div => write!(f, "/"),
            HirBinaryOp::IntDiv => write!(f, "//"),
            HirBinaryOp::Mod => write!(f, "%"),
            HirBinaryOp::EucMod => write!(f, "%%"),
            HirBinaryOp::Pow => write!(f, "^"),
            HirBinaryOp::Eq => write!(f, "=="),
            HirBinaryOp::Ne => write!(f, "!="),
            HirBinaryOp::Lt => write!(f, "<"),
            HirBinaryOp::Le => write!(f, "<="),
            HirBinaryOp::Gt => write!(f, ">"),
            HirBinaryOp::Ge => write!(f, ">="),
            HirBinaryOp::And => write!(f, "and"),
            HirBinaryOp::Or => write!(f, "or"),
        }
    }
}

impl std::fmt::Display for HirUnaryOp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HirUnaryOp::Neg => write!(f, "-"),
            HirUnaryOp::Not => write!(f, "!"),
        }
    }
}

// ===========================================================================
// Convenience constructors (for tests)
// ===========================================================================

pub fn hir_int(span: Span, value: impl Into<String>) -> HirExpr {
    HirExpr::IntLit(IntLit {
        span,
        value: value.into(),
    })
}

pub fn hir_num(span: Span, value: impl Into<String>) -> HirExpr {
    HirExpr::NumLit(NumLit {
        span,
        value: value.into(),
    })
}

pub fn hir_str(span: Span, value: impl Into<String>) -> HirExpr {
    HirExpr::StrLit(StrLit {
        span,
        value: value.into(),
    })
}

pub fn hir_bool(span: Span, value: bool) -> HirExpr {
    HirExpr::BoolLit(BoolLit { span, value })
}

pub fn hir_none(span: Span) -> HirExpr {
    HirExpr::NoneLit(NoneLit { span })
}

pub fn hir_ident(span: Span, name: IdentId) -> HirExpr {
    HirExpr::Ident(IdentNode { span, name, def_node: None })
}

pub fn hir_block(span: Span, stmts: Vec<HirExpr>) -> HirExpr {
    HirExpr::Block(Block { span, stmts })
}

pub fn hir_type_descriptor(
    span: Span,
    type_name: IdentId,
    methods: Vec<(IdentId, HirExpr)>,
) -> HirExpr {
    HirExpr::TypeDescriptor(TypeDescriptor {
        span,
        type_name,
        methods,
    })
}

pub fn hir_tuple_index(span: Span, obj: HirExpr, index: usize) -> HirExpr {
    HirExpr::TupleIndex(TupleIndex {
        span,
        obj: Box::new(obj),
        index,
    })
}

pub fn hir_binary(span: Span, op: HirBinaryOp, left: HirExpr, right: HirExpr) -> HirExpr {
    HirExpr::Binary(Binary {
        span,
        op,
        left: Box::new(left),
        right: Box::new(right),
    })
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::interner::Interner;

    fn ident(interner: &mut Interner, s: &str) -> IdentId {
        interner.intern(s)
    }

    // ── Span access ──

    #[test]
    fn span_accessor_for_literals() {
        assert_eq!(hir_int(Span::new(0, 3), "42").span(), Span::new(0, 3));
        assert_eq!(hir_num(Span::new(0, 4), "3.14").span(), Span::new(0, 4));
        assert_eq!(hir_str(Span::new(0, 7), "hello").span(), Span::new(0, 7));
        assert_eq!(hir_bool(Span::new(0, 4), true).span(), Span::new(0, 4));
        assert_eq!(hir_none(Span::new(0, 4)).span(), Span::new(0, 4));
    }

    #[test]
    fn span_accessor_for_ident() {
        let mut interner = Interner::new();
        let name = ident(&mut interner, "x");
        assert_eq!(hir_ident(Span::new(0, 1), name).span(), Span::new(0, 1));
    }

    #[test]
    fn span_accessor_for_block() {
        let block = hir_block(Span::new(0, 5), vec![hir_int(Span::new(1, 3), "42")]);
        assert_eq!(block.span(), Span::new(0, 5));
    }

    #[test]
    fn span_accessor_for_binary() {
        let expr = hir_binary(
            Span::new(0, 5),
            HirBinaryOp::Add,
            hir_int(Span::new(0, 2), "1"),
            hir_int(Span::new(3, 5), "2"),
        );
        assert_eq!(expr.span(), Span::new(0, 5));
    }

    #[test]
    fn error_expr_span_is_empty() {
        assert_eq!(HirExpr::Error.span(), Span::empty_at(0));
    }

    #[test]
    fn span_accessor_for_control_flow() {
        assert_eq!(
            HirExpr::Break(Break {
                span: Span::new(0, 5)
            })
            .span(),
            Span::new(0, 5)
        );
        assert_eq!(
            HirExpr::Continue(Continue {
                span: Span::new(0, 8)
            })
            .span(),
            Span::new(0, 8)
        );
        assert_eq!(
            HirExpr::Return(Return {
                span: Span::new(0, 6),
                value: None,
            })
            .span(),
            Span::new(0, 6)
        );
    }

    #[test]
    fn span_accesor_for_call() {
        let mut interner = Interner::new();
        let name = ident(&mut interner, "foo");
        let call = HirExpr::Call(Call {
            span: Span::new(0, 5),
            name,
            args: vec![],
            is_builtin: false,
            def_node: dummy_node_id(),
        });
    }

    fn dummy_node_id() -> crate::ast::NodeId {
        let mut arena = crate::ast::AstArena::new();
        arena.alloc(crate::ast::Expr::ErrorExpr)
    }

#[test]
    fn span_accessor_for_func_def() {
        let mut interner = Interner::new();
        let name = ident(&mut interner, "f");
        let node_id = dummy_node_id();
        let fd = HirExpr::FuncDef(FuncDef {
            span: Span::new(0, 20),
            name,
            params: vec![],
            body: Box::new(hir_int(Span::new(15, 19), "42")),
            type_params: vec![],
            node_id,
        });
        assert_eq!(fd.span(), Span::new(0, 20));
    }

    #[test]
    fn span_accessor_for_anon_func() {
        let mut interner = Interner::new();
        let name = ident(&mut interner, "x");
        let af = HirExpr::AnonFunc(AnonFunc {
            span: Span::new(0, 10),
            params: vec![FuncParam { name }],
            body: Box::new(hir_ident(Span::new(8, 9), name)),
        });
        assert_eq!(af.span(), Span::new(0, 10));
    }

    #[test]
    fn span_accessor_for_match() {
        let m = HirExpr::Match(Match {
            span: Span::new(0, 20),
            scrutinee: Box::new(hir_ident(Span::new(6, 7), IdentId::from_u32(0))),
            arms: vec![],
        });
        assert_eq!(m.span(), Span::new(0, 20));
    }

    // ── Construction ──

    #[test]
    fn int_lit_value_and_span() {
        let lit = hir_int(Span::new(0, 3), "42");
        match lit {
            HirExpr::IntLit(IntLit { value, span }) => {
                assert_eq!(value, "42");
                assert_eq!(span, Span::new(0, 3));
            }
            _ => panic!("expected IntLit"),
        }
    }

    #[test]
    fn binary_ops_have_children() {
        let left = hir_int(Span::new(0, 1), "1");
        let right = hir_int(Span::new(4, 5), "2");
        let expr = hir_binary(Span::new(0, 5), HirBinaryOp::Mul, left, right);
        match expr {
            HirExpr::Binary(Binary { op, .. }) => assert_eq!(op, HirBinaryOp::Mul),
            _ => panic!("expected Binary"),
        }
    }

    #[test]
    fn block_with_statements() {
        let block = hir_block(
            Span::new(0, 10),
            vec![
                hir_int(Span::new(1, 2), "1"),
                hir_int(Span::new(3, 4), "2"),
                hir_int(Span::new(5, 6), "3"),
            ],
        );
        match block {
            HirExpr::Block(Block { stmts, .. }) => assert_eq!(stmts.len(), 3),
            _ => panic!("expected Block"),
        }
    }

    #[test]
    fn block_can_be_empty() {
        let block = hir_block(Span::new(0, 2), vec![]);
        match block {
            HirExpr::Block(Block { stmts, .. }) => assert!(stmts.is_empty()),
            _ => panic!("expected Block"),
        }
    }

    #[test]
    fn array_lit() {
        let arr = HirExpr::ArrLit(ArrLit {
            span: Span::new(0, 5),
            elements: vec![hir_int(Span::new(1, 2), "1")],
        });
        match arr {
            HirExpr::ArrLit(a) => assert_eq!(a.elements.len(), 1),
            _ => panic!("expected ArrLit"),
        }
    }

    #[test]
    fn tuple_lit() {
        let tup = HirExpr::TupleLit(TupleLit {
            span: Span::new(0, 5),
            elements: vec![hir_int(Span::new(1, 2), "1")],
        });
        match tup {
            HirExpr::TupleLit(t) => assert_eq!(t.elements.len(), 1),
            _ => panic!("expected TupleLit"),
        }
    }

    #[test]
    fn range_lit_without_end() {
        let r = HirExpr::RangeLit(RangeLit {
            span: Span::new(0, 3),
            start: Box::new(hir_int(Span::new(0, 1), "1")),
            end: None,
        });
        match r {
            HirExpr::RangeLit(ra) => assert!(ra.end.is_none()),
            _ => panic!("expected RangeLit"),
        }
    }

    #[test]
    fn range_lit_with_end() {
        let r = HirExpr::RangeLit(RangeLit {
            span: Span::new(0, 5),
            start: Box::new(hir_int(Span::new(0, 1), "1")),
            end: Some(Box::new(hir_int(Span::new(3, 5), "10"))),
        });
        match r {
            HirExpr::RangeLit(ra) => assert!(ra.end.is_some()),
            _ => panic!("expected RangeLit"),
        }
    }

    #[test]
    fn struct_lit() {
        let mut interner = Interner::new();
        let name = ident(&mut interner, "Point");
        let field_name = ident(&mut interner, "x");
        let sl = HirExpr::StructLit(StructLit {
            span: Span::new(0, 10),
            name,
            fields: vec![(field_name, hir_num(Span::new(5, 8), "1.0"))],
        });
        match sl {
            HirExpr::StructLit(s) => {
                assert_eq!(s.fields.len(), 1);
                assert_eq!(s.fields[0].0, field_name);
            }
            _ => panic!("expected StructLit"),
        }
    }

    #[test]
    fn enum_lit_tagged_union() {
        let mut interner = Interner::new();
        let en = ident(&mut interner, "Option");
        let tag = ident(&mut interner, "some");
        let el = HirExpr::EnumLit(EnumLit {
            span: Span::new(0, 15),
            enum_name: en,
            tag,
            value: Some(Box::new(hir_int(Span::new(12, 14), "42"))),
            is_tagged_union: true,
        });
        match el {
            HirExpr::EnumLit(e) => {
                assert!(e.is_tagged_union);
                assert!(e.value.is_some());
            }
            _ => panic!("expected EnumLit"),
        }
    }

    #[test]
    fn enum_lit_plain() {
        let mut interner = Interner::new();
        let en = ident(&mut interner, "Color");
        let tag = ident(&mut interner, "red");
        let el = HirExpr::EnumLit(EnumLit {
            span: Span::new(0, 10),
            enum_name: en,
            tag,
            value: None,
            is_tagged_union: false,
        });
        match el {
            HirExpr::EnumLit(e) => {
                assert!(!e.is_tagged_union);
                assert!(e.value.is_none());
            }
            _ => panic!("expected EnumLit"),
        }
    }

    #[test]
    fn func_def_with_type_params() {
        let mut interner = Interner::new();
        let name = ident(&mut interner, "id");
        let tp = ident(&mut interner, "T");
        let param = ident(&mut interner, "x");
        let fd = HirExpr::FuncDef(FuncDef {
            span: Span::new(0, 20),
            name,
            params: vec![FuncParam { name: param }],
            body: Box::new(hir_ident(Span::new(15, 16), param)),
            type_params: vec![TypeParam {
                name: tp,
                trait_bounds: vec![],
            }],
            node_id: dummy_node_id(),
        });
        match fd {
            HirExpr::FuncDef(f) => {
                assert_eq!(f.params.len(), 1);
                assert_eq!(f.type_params.len(), 1);
            }
            _ => panic!("expected FuncDef"),
        }
    }

    #[test]
    fn match_arms() {
        let mut interner = Interner::new();
        let binding = ident(&mut interner, "v");
        let m = HirExpr::Match(Match {
            span: Span::new(0, 20),
            scrutinee: Box::new(hir_ident(Span::new(6, 7), IdentId::from_u32(0))),
            arms: vec![
                MatchArm {
                    kind: HirMatchArmKind::Some { binding },
                    body: Box::new(hir_ident(Span::new(14, 15), binding)),
                    span: Span::new(8, 15),
                },
                MatchArm {
                    kind: HirMatchArmKind::None,
                    body: Box::new(hir_int(Span::new(17, 18), "0")),
                    span: Span::new(16, 18),
                },
            ],
        });
        match m {
            HirExpr::Match(mt) => assert_eq!(mt.arms.len(), 2),
            _ => panic!("expected Match"),
        }
    }

    #[test]
    fn if_with_branches() {
        let cond = HirExpr::BoolLit(BoolLit {
            span: Span::new(3, 7),
            value: true,
        });
        let body = hir_int(Span::new(10, 12), "42");
        let if_expr = HirExpr::If(If {
            span: Span::new(0, 20),
            branches: vec![ConditionalBranch {
                condition: Box::new(cond),
                body: Box::new(body),
            }],
            else_branch: None,
        });
        match if_expr {
            HirExpr::If(i) => {
                assert_eq!(i.branches.len(), 1);
                assert!(i.else_branch.is_none());
            }
            _ => panic!("expected If"),
        }
    }

    #[test]
    fn for_loop() {
        let mut interner = Interner::new();
        let var = ident(&mut interner, "x");
        let fl = HirExpr::ForLoop(ForLoop {
            span: Span::new(0, 15),
            var,
            iter: Box::new(hir_ident(Span::new(5, 9), ident(&mut interner, "range"))),
            body: Box::new(hir_ident(Span::new(12, 13), var)),
        });
        match fl {
            HirExpr::ForLoop(f) => assert_eq!(f.var, var),
            _ => panic!("expected ForLoop"),
        }
    }

    #[test]
    fn assign() {
        let mut interner = Interner::new();
        let name = ident(&mut interner, "x");
        let a = HirExpr::Assign(Assign {
            span: Span::new(0, 6),
            name,
            value: Box::new(hir_int(Span::new(4, 6), "42")),
            is_mut: true,
        });
        match a {
            HirExpr::Assign(assign) => {
                assert!(assign.is_mut);
                assert_eq!(assign.name, name);
            }
            _ => panic!("expected Assign"),
        }
    }

    #[test]
    fn direct_call() {
        let callee = HirExpr::Ident(IdentNode {
            span: Span::new(0, 5),
            name: IdentId::from_u32(0),
            def_node: None,
        });
        let dc = HirExpr::DirectCall(DirectCall {
            span: Span::new(0, 8),
            callee: Box::new(callee),
            args: vec![hir_int(Span::new(6, 7), "1")],
        });
        match dc {
            HirExpr::DirectCall(d) => assert_eq!(d.args.len(), 1),
            _ => panic!("expected DirectCall"),
        }
    }

    #[test]
    fn tuple_index() {
        let obj = hir_ident(Span::new(0, 5), IdentId::from_u32(0));
        let ti = hir_tuple_index(Span::new(0, 8), obj, 0);
        match ti {
            HirExpr::TupleIndex(TupleIndex { index, .. }) => assert_eq!(index, 0),
            _ => panic!("expected TupleIndex"),
        }
    }

    #[test]
    fn type_descriptor() {
        let td = HirExpr::TypeDescriptor(TypeDescriptor {
            span: Span::new(0, 5),
            type_name: IdentId::from_u32(0),
            methods: vec![],
        });
        assert_eq!(td.span(), Span::new(0, 5));
    }

    #[test]
    fn field_access_and_assign() {
        let mut interner = Interner::new();
        let field = ident(&mut interner, "x");
        let obj = hir_ident(Span::new(0, 3), ident(&mut interner, "obj"));
        let fa = HirExpr::FieldAccess(FieldAccess {
            span: Span::new(0, 5),
            obj: Box::new(obj),
            field,
        });
        match fa {
            HirExpr::FieldAccess(f) => assert_eq!(f.field, field),
            _ => panic!("expected FieldAccess"),
        }

        let obj2 = hir_ident(Span::new(0, 3), IdentId::from_u32(0));
        let fas = HirExpr::FieldAssign(FieldAssign {
            span: Span::new(0, 10),
            obj: Box::new(obj2),
            field,
            value: Box::new(hir_int(Span::new(8, 10), "42")),
        });
        match fas {
            HirExpr::FieldAssign(f) => assert_eq!(f.field, field),
            _ => panic!("expected FieldAssign"),
        }
    }

    #[test]
    fn call_with_builtin_flag() {
        let mut interner = Interner::new();
        let name = ident(&mut interner, "map");
        let call = HirExpr::Call(Call {
            span: Span::new(0, 10),
            name,
            args: vec![],
            is_builtin: true,
            def_node: dummy_node_id(),
        });
        match call {
            HirExpr::Call(c) => assert!(c.is_builtin),
            _ => panic!("expected Call"),
        }
    }

    #[test]
    fn unary_ops() {
        let neg = HirExpr::Unary(Unary {
            span: Span::new(0, 4),
            op: HirUnaryOp::Neg,
            child: Box::new(hir_int(Span::new(1, 3), "42")),
        });
        match neg {
            HirExpr::Unary(u) => assert_eq!(u.op, HirUnaryOp::Neg),
            _ => panic!("expected Unary"),
        }

        let not = HirExpr::Unary(Unary {
            span: Span::new(0, 5),
            op: HirUnaryOp::Not,
            child: Box::new(hir_bool(Span::new(1, 5), true)),
        });
        match not {
            HirExpr::Unary(u) => assert_eq!(u.op, HirUnaryOp::Not),
            _ => panic!("expected Unary"),
        }
    }

    // ── Display ──

    #[test]
    fn binary_op_display() {
        assert_eq!(HirBinaryOp::Add.to_string(), "+");
        assert_eq!(HirBinaryOp::IntDiv.to_string(), "//");
        assert_eq!(HirBinaryOp::And.to_string(), "and");
        assert_eq!(HirBinaryOp::Pow.to_string(), "^");
    }

    #[test]
    fn unary_op_display() {
        assert_eq!(HirUnaryOp::Neg.to_string(), "-");
        assert_eq!(HirUnaryOp::Not.to_string(), "!");
    }

    // ── HirTypeParam ──

    #[test]
    fn type_param_with_trait_bounds() {
        let mut interner = Interner::new();
        let name = ident(&mut interner, "T");
        let hash_trait = ident(&mut interner, "Hash");
        let eq_trait = ident(&mut interner, "Eq");
        let tp = TypeParam {
            name,
            trait_bounds: vec![hash_trait, eq_trait],
        };
        assert_eq!(tp.trait_bounds.len(), 2);
    }

    // ── HirMatchArmKind ──

    #[test]
    fn match_arm_kind_variants() {
        let mut interner = Interner::new();
        let _ = HirMatchArmKind::Variant {
            name: ident(&mut interner, "Some"),
            binding: Some(ident(&mut interner, "v")),
        };
        let _ = HirMatchArmKind::Some {
            binding: ident(&mut interner, "x"),
        };
        let _ = HirMatchArmKind::None;
        let _ = HirMatchArmKind::Else;
    }

    // ── Edge cases ──

    #[test]
    fn return_with_and_without_value() {
        let rv = HirExpr::Return(Return {
            span: Span::new(0, 10),
            value: Some(Box::new(hir_int(Span::new(7, 9), "42"))),
        });
        assert!(matches!(rv, HirExpr::Return(Return { value: Some(_), .. })));

        let rn = HirExpr::Return(Return {
            span: Span::new(0, 6),
            value: None,
        });
        assert!(matches!(rn, HirExpr::Return(Return { value: None, .. })));
    }

    #[test]
    fn func_def_no_type_params() {
        let mut interner = Interner::new();
        let name = ident(&mut interner, "simple");
        let fd = HirExpr::FuncDef(FuncDef {
            span: Span::new(0, 15),
            name,
            params: vec![],
            body: Box::new(hir_none(Span::new(10, 14))),
            type_params: vec![],
            node_id: dummy_node_id(),
        });
        match fd {
            HirExpr::FuncDef(f) => assert!(f.type_params.is_empty()),
            _ => panic!("expected FuncDef"),
        }
    }

    #[test]
    fn all_variants_have_span() {
        let mut interner = Interner::new();
        let mut id = |s| ident(&mut interner, s);

        let cases: Vec<(HirExpr, Span)> = vec![
            (hir_int(Span::new(0, 3), "42"), Span::new(0, 3)),
            (hir_num(Span::new(0, 4), "3.14"), Span::new(0, 4)),
            (hir_str(Span::new(0, 7), "hello"), Span::new(0, 7)),
            (hir_bool(Span::new(0, 4), true), Span::new(0, 4)),
            (hir_none(Span::new(0, 4)), Span::new(0, 4)),
            (hir_ident(Span::new(0, 1), id("x")), Span::new(0, 1)),
            (
                HirExpr::Break(Break {
                    span: Span::new(0, 5),
                }),
                Span::new(0, 5),
            ),
            (
                HirExpr::Continue(Continue {
                    span: Span::new(0, 8),
                }),
                Span::new(0, 8),
            ),
            (
                HirExpr::Return(Return {
                    span: Span::new(0, 6),
                    value: None,
                }),
                Span::new(0, 6),
            ),
            (HirExpr::Error, Span::empty_at(0)),
            (
                hir_tuple_index(
                    Span::new(0, 8),
                    hir_ident(Span::new(0, 5), IdentId::from_u32(0)),
                    0,
                ),
                Span::new(0, 8),
            ),
            (
                HirExpr::TypeDescriptor(TypeDescriptor {
                    span: Span::new(0, 5),
                    type_name: IdentId::from_u32(0),
                    methods: vec![],
                }),
                Span::new(0, 5),
            ),
        ];

        for (expr, expected) in cases {
            assert_eq!(expr.span(), expected, "span mismatch for variant");
        }
    }

    #[test]
    fn hir_type_param_debug() {
        let mut interner = Interner::new();
        let tp = TypeParam {
            name: ident(&mut interner, "T"),
            trait_bounds: vec![ident(&mut interner, "Hash")],
        };
        let debug_str = format!("{:?}", tp);
        assert!(debug_str.contains("T"));
    }

    #[test]
    fn if_with_else() {
        let if_expr = HirExpr::If(If {
            span: Span::new(0, 30),
            branches: vec![ConditionalBranch {
                condition: Box::new(hir_bool(Span::new(3, 7), true)),
                body: Box::new(hir_int(Span::new(10, 12), "1")),
            }],
            else_branch: Some(Box::new(hir_int(Span::new(22, 24), "2"))),
        });
        match if_expr {
            HirExpr::If(i) => assert!(i.else_branch.is_some()),
            _ => panic!("expected If"),
        }
    }

    #[test]
    fn for_loop_trailing_semicolon() {
        let mut interner = Interner::new();
        let var = ident(&mut interner, "i");
        let fl = HirExpr::ForLoop(ForLoop {
            span: Span::new(0, 15),
            var,
            iter: Box::new(hir_ident(Span::new(5, 9), ident(&mut interner, "items"))),
            body: Box::new(hir_block(Span::new(12, 14), vec![])),
        });
        match fl {
            HirExpr::ForLoop(f) => assert_eq!(f.var, var),
            _ => panic!("expected ForLoop"),
        }
    }
}
