import type * as AST from "./ast/index";
import { ArrayType, FuncType, type Type } from "./ast/types";

const INDENT = "    ";

// Full set of Rust 2021 edition reserved words + strict keywords
const RUST_RESERVED_WORDS = new Set([
    "as",
    "async",
    "await",
    "break",
    "const",
    "continue",
    "crate",
    "dyn",
    "else",
    "enum",
    "extern",
    "false",
    "fn",
    "for",
    "if",
    "impl",
    "in",
    "let",
    "loop",
    "match",
    "mod",
    "move",
    "mut",
    "pub",
    "ref",
    "return",
    "self",
    "Self",
    "static",
    "struct",
    "super",
    "trait",
    "true",
    "type",
    "union",
    "unsafe",
    "use",
    "where",
    "while",
    "yield",
    // Edition 2021 reserved
    "try",
]);

/** Map a name to a safe Rust identifier if it conflicts with a reserved word.
 *  Also replaces `$` with `_` since `$` is not valid in Rust identifiers. */
export function safeRustName(name: string): string {
    // Replace $ with _ (mangled names like "foo$Int$Int" become "foo_Int_Int")
    const cleaned = name.replace(/\$/g, "_");
    // Check if the base name (before any _ from replacements) is reserved
    const baseName = cleaned.split("_")[0];
    if (RUST_RESERVED_WORDS.has(baseName)) {
        return `_gema_${cleaned}`;
    }
    return cleaned;
}

// ── Type mapping ──

/** Map a Gema Type to a Rust type annotation string. */
export function rustTypeName(type: Type | null): string {
    if (type === null || type === "Null") return "()";
    if (type === "Int") return "i64";
    if (type === "Float") return "f64";
    if (type === "Bool") return "bool";
    if (type === "Str") return "Rc<String>";
    if (type instanceof ArrayType) return `Rc<Vec<${rustTypeName(type.innerType)}>>`;
    if (type instanceof FuncType) {
        const params = type.paramTypes.map((t) => rustTypeName(t)).join(", ");
        return `Box<dyn Fn(${params}) -> ${rustTypeName(type.returnType)}>`;
    }
    // Fallback — should not reach here for the POC subset
    return "i64";
}

// ── Scope tracking (simplified for Rust — no hoisting) ──

class Scope {
    parent: Scope | null;
    lines: string[] = [];

    constructor(
        parent: Scope | null = null,
        public baseIndentLevel = 0
    ) {
        this.parent = parent;
    }
}

// ── Runtime helpers (injected into generated Rust programs) ──

const RUNTIME_HELPERS = `
#![allow(dead_code)]
use std::rc::Rc;

// ── String helpers ──

fn gema_str_concat(a: &str, b: &str) -> Rc<String> {
    let mut s = String::with_capacity(a.len() + b.len());
    s.push_str(a);
    s.push_str(b);
    Rc::new(s)
}

fn gema_str_from_char(c: char) -> Rc<String> {
    Rc::new(c.to_string())
}

fn gema_str_index(s: &str, index: i64) -> Rc<String> {
    let idx = if index < 0 { 0 } else { index as usize };
    if let Some(c) = s.chars().nth(idx) {
        Rc::new(c.to_string())
    } else {
        panic!("string index out of bounds: index={}, len={}", index, s.chars().count());
    }
}

fn gema_to_string_i64(x: i64) -> Rc<String> {
    Rc::new(x.to_string())
}

fn gema_to_string_f64(x: f64) -> Rc<String> {
    Rc::new(x.to_string())
}

fn gema_to_string_bool(x: bool) -> Rc<String> {
    Rc::new(x.to_string())
}

fn gema_to_string_rc_string(x: &str) -> Rc<String> {
    Rc::new(x.to_string())
}

// ── Numeric helpers ──

fn gema_mod(a: i64, b: i64) -> i64 {
    ((a % b) + b) % b
}

fn gema_pow_f64(a: f64, b: f64) -> f64 {
    a.powf(b)
}

fn gema_pow_i64(a: i64, b: i64) -> i64 {
    if b < 0 { return 0; }
    let mut result: i64 = 1;
    let mut base = a;
    let mut exp = b;
    while exp > 0 {
        if exp & 1 == 1 {
            result = result.saturating_mul(base);
        }
        base = base.saturating_mul(base);
        exp >>= 1;
    }
    result
}

// ── Array helpers ──

fn gema_array_get<T: Clone>(arr: &[T], index: i64) -> T {
    let idx = if index < 0 {
        panic!("array index out of bounds: negative index {}", index);
    } else {
        index as usize
    };
    if idx >= arr.len() {
        panic!("array index out of bounds: index={}, len={}", index, arr.len());
    }
    arr[idx].clone()
}

fn gema_array_len<T>(arr: &[T]) -> i64 {
    arr.len() as i64
}

fn gema_array_eq<T: PartialEq>(a: &[T], b: &[T]) -> bool {
    if a.len() != b.len() { return false; }
    for (ai, bi) in a.iter().zip(b.iter()) {
        if ai != bi { return false; }
    }
    true
}

// ── Display helper ──
// Uses a trait-based dispatch so we can display any Gema type.

trait GemaDisplay {
    fn gema_display(&self) -> String;
}

impl GemaDisplay for i64 {
    fn gema_display(&self) -> String { format!("{}", self) }
}
impl GemaDisplay for f64 {
    fn gema_display(&self) -> String { format!("{}", self) }
}
impl GemaDisplay for bool {
    fn gema_display(&self) -> String { format!("{}", self) }
}
impl GemaDisplay for Rc<String> {
    fn gema_display(&self) -> String { format!("{}", self) }
}
impl<T: GemaDisplay> GemaDisplay for Vec<T> {
    fn gema_display(&self) -> String {
        let items: Vec<String> = self.iter().map(|x| x.gema_display()).collect();
        format!("[{}]", items.join(", "))
    }
}
impl<T: GemaDisplay> GemaDisplay for Rc<Vec<T>> {
    fn gema_display(&self) -> String { (**self).gema_display() }
}
`;

// ── RustWriter ──

export class RustWriter {
    ast: AST.Expression;
    currentLine: string = "";
    indentLevel: number = 0;
    /** All generated lines are collected into the current scope's lines array */
    scopeStack: Scope[];
    /** Set of runtime helper names that need to be included */
    runtimeHelpers: Set<string> = new Set();
    /** Unique ID counter for generated names */
    nextUniqueId: number = 0;

    constructor(ast: AST.Expression) {
        this.ast = ast;
        this.scopeStack = [new Scope(null, 0)];
    }

    /** Get the current scope */
    get scope(): Scope {
        return this.scopeStack[this.scopeStack.length - 1];
    }

    uniqueName(prefix: string): string {
        return `${prefix}${this.nextUniqueId++}`;
    }

    /** Flush current line to scope, start a fresh line at current indent */
    newLine() {
        this.scope.lines.push(this.currentLine);
        this.currentLine = INDENT.repeat(this.indentLevel);
    }

    /** Write text to the current line */
    write(text: string) {
        this.currentLine += text;
    }

    indentIn() {
        this.indentLevel += 1;
    }

    indentOut() {
        this.indentLevel -= 1;
    }

    safeName(name: string): string {
        return safeRustName(name);
    }

    /** Record that a runtime helper function is needed */
    useBuiltin(name: string) {
        this.runtimeHelpers.add(name);
    }

    /** Emit `{` and push a new scope */
    beginScope() {
        this.write("{");
        this.indentIn();
        this.newLine();
        this.scopeStack.push(new Scope(this.scope, this.indentLevel));
    }

    /** Pop the current scope and emit `}` */
    endScope() {
        if (this.scopeStack.length <= 1) {
            throw new Error("Tried to exit top-level scope");
        }
        const finishedLines = this.scope.lines;
        this.scopeStack.pop();
        // Append the finished scope's lines to the parent scope
        this.scope.lines.push(...finishedLines);
        this.indentOut();
        // If current line is empty (whitespace only), reset it; otherwise flush then write "}"
        if (/^\s*$/.test(this.currentLine)) {
            this.currentLine = INDENT.repeat(this.indentLevel);
        } else {
            this.newLine();
        }
        this.write("}");
    }

    /** Open a function body scope (same as beginScope but used for readability) */
    beginFunction() {
        this.write("{");
        this.indentIn();
        this.newLine();
        this.scopeStack.push(new Scope(this.scope, this.indentLevel));
    }

    /** Close a function body scope */
    endFunction() {
        this.endScope();
    }

    /** Write a variable declaration: `let name: Type = value;` */
    writeLet(name: string, type: Type | null, valueExpr: string) {
        const safe = this.safeName(name);
        const typeAnn = type !== null && type !== "Null" ? `: ${rustTypeName(type)}` : "";
        this.write(`let ${safe}${typeAnn} = ${valueExpr};`);
    }

    /** Get the Rust source for a runtime helper by name */
    private getRuntimeHelper(name: string): string | null {
        // Map from builtin names to the functions defined in RUNTIME_HELPERS
        const helperMap: Record<string, string> = {
            gema_mod: "gema_mod",
            gema_pow_i64: "gema_pow_i64",
            gema_pow_f64: "gema_pow_f64",
            gema_array_get: "gema_array_get",
            gema_array_len: "gema_array_len",
            gema_array_eq: "gema_array_eq",
            gema_str_concat: "gema_str_concat",
            gema_str_index: "gema_str_index",
            gema_to_string_i64: "gema_to_string_i64",
            gema_to_string_f64: "gema_to_string_f64",
            gema_to_string_bool: "gema_to_string_bool",
            gema_to_string_rc_string: "gema_to_string_rc_string",
        };
        const mapped = helperMap[name];
        if (mapped) return mapped;
        return null;
    }

    /**
     * Assemble the final Rust source.
     * In "export" mode, the generated code is a standalone program with `fn main()`.
     */
    compile(_mode: "immediate" | "inline" | "export"): string {
        // Generate the main program body by visiting the AST
        this.ast.toRust(this);

        // Flush the final line
        this.newLine();

        // Collect all lines from the top-level scope
        const bodyLines = this.scope.lines;

        // Build the main function
        const body = bodyLines.join("\n");

        // Build runtime helper includes
        const runtimeSrc = RUNTIME_HELPERS.trimStart();

        const program = `\
${runtimeSrc}
fn main() {
${INDENT}let result = {
${body}
${INDENT}};
${INDENT}println!("{}", result.gema_display());
}`;

        return program;
    }
}

// ── Entry point ──

export function writeRust(
    ast: AST.Expression,
    mode: "immediate" | "inline" | "export" = "immediate",
    _minify: boolean = false
): string {
    const compiler = new RustWriter(ast);
    return compiler.compile(mode);
}
