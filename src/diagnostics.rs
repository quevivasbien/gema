/// Diagnostic reporting infrastructure.
///
/// Collects errors, warnings, and notes during compilation, then
/// formats them for display.  Uses `SourceMap` to resolve byte offsets
/// to line/column positions.
use crate::source::{SourceMap, Span};
use std::fmt;

/// How serious a diagnostic is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Severity {
    /// A note or hint — not a problem, but potentially useful context.
    Note,
    /// A warning — the code compiles but may not behave as expected.
    Warning,
    /// An error — the compilation cannot proceed normally.
    Error,
}

impl fmt::Display for Severity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Severity::Note => write!(f, "note"),
            Severity::Warning => write!(f, "warning"),
            Severity::Error => write!(f, "error"),
        }
    }
}

/// A single diagnostic message.
#[derive(Clone, Debug)]
pub struct Diagnostic {
    pub severity: Severity,
    pub message: String,
    /// The source file index in the `SourceMap`.
    pub file_idx: usize,
    /// The span within the source file.
    pub span: Span,
    /// Optional secondary labels (e.g., "previous definition here").
    pub notes: Vec<String>,
}

impl Diagnostic {
    pub fn error(file_idx: usize, span: Span, message: impl Into<String>) -> Self {
        Self {
            severity: Severity::Error,
            message: message.into(),
            file_idx,
            span,
            notes: Vec::new(),
        }
    }

    pub fn warning(file_idx: usize, span: Span, message: impl Into<String>) -> Self {
        Self {
            severity: Severity::Warning,
            message: message.into(),
            file_idx,
            span,
            notes: Vec::new(),
        }
    }

    pub fn note(file_idx: usize, span: Span, message: impl Into<String>) -> Self {
        Self {
            severity: Severity::Note,
            message: message.into(),
            file_idx,
            span,
            notes: Vec::new(),
        }
    }

    pub fn with_note(mut self, note: impl Into<String>) -> Self {
        self.notes.push(note.into());
        self
    }
}

/// A collection of diagnostics produced during a compilation pass.
///
/// This is threaded through the compiler and checked at the end of
/// each pass to determine whether to continue.
#[derive(Clone, Debug, Default)]
pub struct DiagnosticsBag {
    diagnostics: Vec<Diagnostic>,
}

impl DiagnosticsBag {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, diag: Diagnostic) {
        self.diagnostics.push(diag);
    }

    /// Convenience: push an error.
    pub fn error(&mut self, file_idx: usize, span: Span, message: impl Into<String>) {
        self.push(Diagnostic::error(file_idx, span, message));
    }

    /// Convenience: push a warning.
    pub fn warning(&mut self, file_idx: usize, span: Span, message: impl Into<String>) {
        self.push(Diagnostic::warning(file_idx, span, message));
    }

    /// Convenience: push a note.
    pub fn note(&mut self, file_idx: usize, span: Span, message: impl Into<String>) {
        self.push(Diagnostic::note(file_idx, span, message));
    }

    pub fn has_errors(&self) -> bool {
        self.diagnostics
            .iter()
            .any(|d| d.severity == Severity::Error)
    }

    pub fn has_warnings(&self) -> bool {
        self.diagnostics
            .iter()
            .any(|d| d.severity == Severity::Warning)
    }

    pub fn len(&self) -> usize {
        self.diagnostics.len()
    }

    pub fn is_empty(&self) -> bool {
        self.diagnostics.is_empty()
    }

    /// Consume the bag and return all diagnostics.
    pub fn into_vec(self) -> Vec<Diagnostic> {
        self.diagnostics
    }

    /// Iterate over diagnostics.
    pub fn iter(&self) -> impl Iterator<Item = &Diagnostic> {
        self.diagnostics.iter()
    }

    /// Format all diagnostics to a string, using a `SourceMap` for
    /// position information.
    pub fn format(&self, source_map: &SourceMap) -> String {
        if self.diagnostics.is_empty() {
            return String::new();
        }

        let mut out = String::new();
        for diag in &self.diagnostics {
            let (line, col) = source_map.line_col(diag.file_idx, diag.span.start);
            let filename = source_map
                .get(diag.file_idx)
                .map(|s| s.name.as_ref())
                .unwrap_or("<unknown>");

            out.push_str(&format!(
                "  {sev} [{filename}:{line}:{col}]: {msg}\n",
                sev = diag.severity,
                filename = filename,
                line = line,
                col = col,
                msg = diag.message,
            ));

            for note in &diag.notes {
                out.push_str(&format!("    note: {note}\n"));
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::SourceText;

    #[test]
    fn empty_bag() {
        let bag = DiagnosticsBag::new();
        assert!(!bag.has_errors());
        assert!(bag.is_empty());
    }

    #[test]
    fn has_errors_detection() {
        let mut bag = DiagnosticsBag::new();
        let span = Span::new(0, 1);
        bag.error(0, span, "test error");
        assert!(bag.has_errors());
    }

    #[test]
    fn warnings_are_not_errors() {
        let mut bag = DiagnosticsBag::new();
        let span = Span::new(0, 1);
        bag.warning(0, span, "test warning");
        assert!(!bag.has_errors());
        assert!(bag.has_warnings());
    }

    #[test]
    fn format_output() {
        let mut bag = DiagnosticsBag::new();
        let mut source_map = SourceMap::new();
        let file_idx = source_map.add(SourceText::new("foo.gema", "abc\ndef\nghi"));

        bag.error(file_idx, Span::new(4, 5), "something went wrong");

        let formatted = bag.format(&source_map);
        assert!(formatted.contains("error"));
        assert!(formatted.contains("foo.gema"));
        assert!(formatted.contains("something went wrong"));
        // 'd' is at line 2, column 0 (0-indexed column)
        assert!(formatted.contains(":2:0]"));
    }

    #[test]
    fn diagnostic_with_note() {
        let diag =
            Diagnostic::error(0, Span::new(0, 1), "main error").with_note("first saw this here");
        assert_eq!(diag.notes.len(), 1);
        assert_eq!(diag.notes[0], "first saw this here");
    }
}
