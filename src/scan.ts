import { KEYWORDS, SINGLE_CHAR_TOKENS, STRING_TO_TOKEN_MAP, TokenType, type Token } from "./tokens";

class Scanner {
    text: string;
    index: number = 0;
    line: number = 0;
    lineStartIndex: number = 0;
    tokenStartIndex: number = 0;

    constructor(text: string) {
        this.text = text;
    }

    atEnd(): boolean {
        return this.index >= this.text.length;
    }

    error(message: string): Error {
        return new Error(`At line ${this.line + 1}, column ${this.tokenStartIndex - this.lineStartIndex + 1}, ${message}`);
    }

    makeToken(c: string): Token {
        const tokenType = STRING_TO_TOKEN_MAP[c];
        if (tokenType === undefined) {
            throw this.error(`got invalid value as token type: ${c}`);
        }
        return {
            type: tokenType,
            text: this.text.slice(this.tokenStartIndex, this.index),
            line: this.line,
            col: this.tokenStartIndex - this.lineStartIndex,
        }
    }

    handleCommentsAndWhitespace() {
        while (!this.atEnd()) {
            if (this.text[this.index] === "\n") {
                this.line += 1;
                this.lineStartIndex = this.index + 1;
            } else if (this.text[this.index] === "#") {
                // Comment, skip until end of line
                while (!this.atEnd() && this.text[this.index] !== "\n") {
                    this.index += 1;
                }
            } else if (!/\s/.test(this.text[this.index])) {
                break;
            }
            this.index += 1;
        }
    }

    disambiguateTokens(char: string, nextChar: string, secondCharTarget: string): Token {
        if (nextChar === secondCharTarget) {
            return this.makeToken(char + secondCharTarget);
        } else {
            return this.makeToken(char);
        }
    }

    readStringLiteral(): Token {
        while (!this.atEnd() && this.text[this.index] != "\"") {
            if (this.text[this.index] === "\n") {
                this.line += 1;
                this.lineStartIndex = this.index;
            }
            this.index += 1;
        }
        if (this.atEnd()) {
            throw this.error("found unterminated string");
        }
        this.index += 1;
        return this.makeToken(TokenType.String);
    }

    readNumber(): Token {
        while (/^\d$/.test(this.text[this.index])) {
            this.index += 1;
        }
        if (this.text[this.index] === ".") {
            this.index += 1;
            while (/^\d$/.test(this.text[this.index])) {
                this.index += 1;
            }
            return this.makeToken(TokenType.Float);
        }
        return this.makeToken(TokenType.Integer);
    }

    readIdentifierOrKeyword(): Token {
        while (/^[A-Za-z\d]$/.test(this.text[this.index])) {
            this.index += 1;
        }
        const text = this.text.slice(this.tokenStartIndex, this.index);
        if (KEYWORDS.has(text)) {
            return this.makeToken(text);
        }
        return {
            type: TokenType.Identifier,
            text,
            line: this.line,
            col: this.tokenStartIndex - this.lineStartIndex,
        }
    }

    scanToken(): Token | null {
        this.handleCommentsAndWhitespace();
        this.tokenStartIndex = this.index;
        if (this.atEnd()) {
            return null;
        }
        const c = this.text[this.index];
        this.index += 1;

        if (SINGLE_CHAR_TOKENS.has(c)) {
            return this.makeToken(c);
        }

        if (!this.atEnd()) {
            const nextChar = this.text[this.index];
            // Handle two-character tokens
            if (c === "!" || c === ">" || c === "<") {
                return this.disambiguateTokens(c, nextChar, "=");
            } else if (c === "=") {
                return this.disambiguateTokens(c, nextChar, "=");
            }
        }

        // Handle literals
        if (c === "\"") {
            return this.readStringLiteral();
        }
        if (/^[0-9]$/.test(c)) {
            return this.readNumber();
        }
        if (/^[A-Za-z]/.test(c)) {
            return this.readIdentifierOrKeyword();
        }
        
        throw this.error(`found unexpected character ${c}`);
    }
}

export function scan(text: string): Token[] {
    const scanner = new Scanner(text);
    const tokens = [];
    while (!scanner.atEnd()) {
        const token = scanner.scanToken();
        if (token === null) {
            break;
        }
        tokens.push(token);
    }

    return tokens;
}