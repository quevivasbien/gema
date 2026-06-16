import { StreamLanguage, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

const KEYWORDS = new Set([
    "and",
    "or",
    "func",
    "struct",
    "trait",
    "where",
    "is",
    "if",
    "else",
    "true",
    "false",
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
            if (stream.peek() === ".") {
                stream.next();
                stream.eatWhile(/[0-9]/);
                return "number";
            }
            return "number";
        }

        // Identifiers and keywords
        if (/[A-Za-z_]/.test(ch)) {
            stream.eatWhile(/[A-Za-z0-9_]/);
            const word = stream.current();
            if (KEYWORDS.has(word)) return "keyword";
            if (TYPE_NAMES.has(word)) return "typeName";
            return "variable";
        }

        // Operators and punctuation — consume one or two characters
        stream.next();
        if (["!", ">", "<", "=", "%", "^"].includes(ch) && stream.peek() === "=") {
            stream.next();
        }
        return "operator";
    },
});

export function gema() {
    return [gemaStreamParser];
}
