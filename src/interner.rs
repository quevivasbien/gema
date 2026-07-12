/// Identifier interning — cheaply stores and compares strings.
///
/// Every distinct identifier in the source gets a unique `IdentId`.
/// This makes name comparisons O(1) and storage compact.
use rustc_hash::FxHashMap;

/// An interned identifier — a `u32` index into the interner's string
/// table.  Two `IdentId`s compare by pointer (cheap `Copy` + `Eq`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct IdentId(u32);

/// Simple string interner.  Thread through the compiler as
/// `&mut Interner`.
#[derive(Clone, Debug, Default)]
pub struct Interner {
    strings: Vec<Box<str>>,
    lookup: FxHashMap<Box<str>, IdentId>,
}

impl Interner {
    pub fn new() -> Self {
        Self::default()
    }

    /// Intern a string, returning a stable `IdentId`.  If the string
    /// has already been interned, returns the existing ID.
    pub fn intern(&mut self, s: &str) -> IdentId {
        if let Some(&id) = self.lookup.get(s) {
            return id;
        }
        let id = IdentId(self.strings.len() as u32);
        let boxed: Box<str> = s.into();
        self.lookup.insert(boxed.clone(), id);
        self.strings.push(boxed);
        id
    }

    /// Retrieve the string for an `IdentId`.  Panics if the ID is
    /// invalid (should never happen if IDs are produced by `intern`).
    pub fn lookup(&self, id: IdentId) -> &str {
        &self.strings[id.0 as usize]
    }

    /// Number of unique identifiers interned.
    pub fn len(&self) -> usize {
        self.strings.len()
    }

    pub fn is_empty(&self) -> bool {
        self.strings.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn intern_and_lookup() {
        let mut interner = Interner::new();
        let a = interner.intern("hello");
        let b = interner.intern("world");
        let c = interner.intern("hello");
        assert_eq!(a, c);
        assert_ne!(a, b);
        assert_eq!(interner.lookup(a), "hello");
        assert_eq!(interner.lookup(b), "world");
    }

    #[test]
    fn empty_interner() {
        let interner = Interner::new();
        assert!(interner.is_empty());
    }

    #[test]
    fn interner_count() {
        let mut interner = Interner::new();
        interner.intern("a");
        interner.intern("b");
        interner.intern("a");
        assert_eq!(interner.len(), 2);
    }
}
