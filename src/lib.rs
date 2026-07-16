//! Gema compiler — a statically-typed programming language that
//! transpiles to JavaScript.
//!
//! This is the Rust rewrite of the Gema compiler.  It follows a
//! multi-phase pipeline:
//!
//!   scan -> parse -> resolve -> infer -> monomorphize -> lower -> codegen
//!
//! See [`ROADMAP-RUST-REWRITE.md`](https://github.com/quevivasbien/gema)
//! for the full architecture plan.

pub mod ast;
pub mod builtins;
pub mod codegen;
pub mod diagnostics;
pub mod hir;
pub mod infer;
pub mod interner;
pub mod lower;
pub mod parse;
pub mod resolve;
pub mod scan;
pub mod source;
pub mod symbol;
pub mod token;
pub mod types;
