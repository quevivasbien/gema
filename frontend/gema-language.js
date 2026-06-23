import { StreamLanguage } from "@codemirror/language";

const KEYWORDS = new Set([
    "and",
    "or",
    "func",
    "struct",
    "enum",
    "trait",
    "where",
    "is",
    "match",
    "if",
    "else",
    "for",
    "break",
    "continue",
    "return",
    "mut",
    "use",
    "from",
]);

const TYPE_NAMES = new Set([
    "Int",
    "Float",
    "Str",
    "Bool",
    "Func",
    "Arr",
    "MutArr",
    "Iter",
    "Self",
    "Dict",
    "MutDict",
    "Set",
    "MutSet",
]);

// A very simple parser for use in syntax highlighting
const gemaStreamParser = StreamLanguage.define({
    startState: () => ({ inString: false }),

    token: (stream, state) => {
        // Multi-line string continuation from previous line
        if (state.inString) {
            const nextQuote = stream.string.indexOf('"', stream.pos);
            if (nextQuote === -1) {
                stream.skipToEnd();
                return "string";
            }
            stream.match('"');
            state.inString = false;
            return "string";
        }

        if (stream.eatSpace()) return null;
        if (stream.eol()) return null;

        const ch = stream.peek();

        // Comments
        if (ch === "#") {
            stream.skipToEnd();
            return "comment";
        }

        // String literals
        if (ch === '"') {
            stream.next();
            const rest = stream.string.slice(stream.pos);
            const closeIdx = rest.indexOf('"');
            if (closeIdx === -1) {
                stream.skipToEnd();
                state.inString = true;
            } else {
                stream.match(rest.slice(0, closeIdx + 1));
            }
            return "string";
        }

        // Numbers (Int and Float)
        if (/[0-9]/.test(ch)) {
            stream.eatWhile(/[0-9]/);
            // Check for float (1.5) vs range start (1..) — peek ahead without consuming
            if (stream.peek() === "." && stream.string.charAt(stream.pos + 1) !== ".") {
                stream.next(); // consume the dot
                stream.eatWhile(/[0-9]/);
            }
            return "number";
        }

        // Identifiers and keywords
        if (/[A-Za-z_]/.test(ch)) {
            stream.eatWhile(/[A-Za-z0-9_]/);
            const word = stream.current();
            if (word === "true" || word === "false") return "number";
            if (KEYWORDS.has(word)) return "keyword";
            if (TYPE_NAMES.has(word)) return "typeName";
            return "variable";
        }

        // Operators and punctuation — consume one or two characters
        stream.next();
        if (ch === "." && stream.peek() === ".") {
            stream.next(); // consume second dot for ..
        } else if (
            ["!", ">", "<", "=", "+", "-", "*", "/", "%", "^"].includes(ch) &&
            stream.peek() === "="
        ) {
            stream.next(); // consume = for compound/compare operators
        }
        return "operator";
    },
    languageData: {
        commentTokens: { line: "#" },
    },
});

export function gema() {
    return [gemaStreamParser];
}
