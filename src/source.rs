/// Source-level representation: a single input file with a name,
/// plus a global source map that maps between byte offsets and
/// line/column positions.
use std::sync::Arc;

/// A single source file.
#[derive(Clone, Debug)]
pub struct SourceText {
    /// The user-visible name (filename or `<stdin>`).
    pub name: Arc<str>,
    /// The raw source text.
    pub text: Arc<str>,
}

impl SourceText {
    pub fn new<N: Into<Arc<str>>, T: Into<Arc<str>>>(name: N, text: T) -> Self {
        Self {
            name: name.into(),
            text: text.into(),
        }
    }

    /// Number of bytes in the source.
    pub fn len(&self) -> usize {
        self.text.len()
    }

    pub fn is_empty(&self) -> bool {
        self.text.is_empty()
    }
}

/// A half-open byte range `[start, end)` within a `SourceText`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Span {
    pub start: u32,
    pub end: u32,
}

impl Span {
    pub const fn new(start: u32, end: u32) -> Self {
        Self { start, end }
    }

    /// Create a zero-length span at the given position (useful for
    /// synthetic tokens or error placeholders).
    pub const fn empty_at(pos: u32) -> Self {
        Self {
            start: pos,
            end: pos,
        }
    }

    /// Merge two adjacent or overlapping spans into one covering span.
    pub fn union(self, other: Span) -> Self {
        Self {
            start: self.start.min(other.start),
            end: self.end.max(other.end),
        }
    }

    pub fn len(&self) -> u32 {
        self.end - self.start
    }

    pub fn is_empty(&self) -> bool {
        self.start == self.end
    }
}

impl From<(u32, u32)> for Span {
    fn from((start, end): (u32, u32)) -> Self {
        Self { start, end }
    }
}

/// A collection of source files, providing fast line/column lookup
/// for any `Span`.
#[derive(Clone, Debug, Default)]
pub struct SourceMap {
    files: Vec<SourceText>,
    /// For each file, precomputed newline offsets so we can do O(log n)
    /// line/column lookups without rescanning every time.
    newlines: Vec<Vec<u32>>,
}

impl SourceMap {
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a source file and return its index.
    pub fn add(&mut self, source: SourceText) -> usize {
        let newlines = compute_newlines(&source.text);
        let idx = self.files.len();
        self.files.push(source);
        self.newlines.push(newlines);
        idx
    }

    pub fn get(&self, idx: usize) -> Option<&SourceText> {
        self.files.get(idx)
    }

    /// Look up the 1-based line and column for a byte offset in a file.
    pub fn line_col(&self, file_idx: usize, offset: u32) -> (usize, usize) {
        let newlines = match self.newlines.get(file_idx) {
            Some(nl) => nl,
            None => return (0, 0),
        };

        match newlines.binary_search(&offset) {
            Ok(line) => {
                // Offset is exactly at a newline character — it's the end
                // of line `line` (0-based), column is 0 conceptually.
                (line + 1, 0)
            }
            Err(line) => {
                // `line` is the number of newlines *before* this offset.
                let line_start = if line == 0 { 0 } else { newlines[line - 1] + 1 };
                (line + 1, (offset - line_start) as usize)
            }
        }
    }

    /// Convenience: get the source text snippet covered by a span in
    /// a particular file.
    pub fn source_snippet(&self, file_idx: usize, span: Span) -> Option<&str> {
        let source = self.files.get(file_idx)?;
        Some(&source.text[span.start as usize..span.end as usize])
    }
}

fn compute_newlines(text: &str) -> Vec<u32> {
    text.bytes()
        .enumerate()
        .filter(|(_, b)| *b == b'\n')
        .map(|(i, _)| i as u32)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_text_basics() {
        let s = SourceText::new("test.gema", "hello\nworld");
        assert_eq!(s.len(), 11);
        assert!(!s.is_empty());
    }

    #[test]
    fn span_union() {
        let a = Span::new(5, 10);
        let b = Span::new(2, 7);
        assert_eq!(a.union(b), Span::new(2, 10));
    }

    #[test]
    fn span_empty() {
        let s = Span::empty_at(42);
        assert!(s.is_empty());
        assert_eq!(s.start, 42);
        assert_eq!(s.end, 42);
    }

    #[test]
    fn line_col_simple() {
        let mut map = SourceMap::new();
        let idx = map.add(SourceText::new("test.gema", "abc\ndef\nghi"));
        // 'a' is at line 1, col 0
        assert_eq!(map.line_col(idx, 0), (1, 0));
        // 'd' is at line 2, col 0
        assert_eq!(map.line_col(idx, 4), (2, 0));
        // 'e' is at line 2, col 1
        assert_eq!(map.line_col(idx, 5), (2, 1));
        // 'i' is at line 3, col 2
        assert_eq!(map.line_col(idx, 10), (3, 2));
    }

    #[test]
    fn line_col_empty_file() {
        let mut map = SourceMap::new();
        let idx = map.add(SourceText::new("empty.gema", ""));
        assert_eq!(map.line_col(idx, 0), (1, 0));
    }

    #[test]
    fn source_snippet() {
        let mut map = SourceMap::new();
        let idx = map.add(SourceText::new("test.gema", "hello world"));
        let span = Span::new(0, 5);
        assert_eq!(map.source_snippet(idx, span), Some("hello"));
    }
}
