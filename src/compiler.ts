import {
    ASTError,
    Block,
    DropValue,
    Expression,
    FunctionDef,
    registerFunction,
    registerStruct,
    registerTrait,
    resetRegistries,
    setSelectiveImportRule,
    UseModule,
} from "./ast";
import { parse } from "./parse";
import { scan } from "./scan";
import { TokenType } from "./tokens";
import { writeJS } from "./write-js";

import { treeShake } from "./tree-shake";

interface CompileResult {
    js: string;
    result: null;
    errors: { line: number; col: number; message: string; filename?: string }[];
    runtimeError: null;
}

/**
 * Scan tokens for `use "..."` directives and collect the module paths.
 */
function collectUseDirectives(tokens: { type: TokenType; text: string }[]): string[] {
    const paths: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].type === TokenType.Use) {
            // Scan forward past (foo, bar) from / as ns to find the path string
            for (let j = i + 1; j < tokens.length; j++) {
                if (tokens[j].type === TokenType.String) {
                    let path = tokens[j].text;
                    if (path.length >= 2 && path.startsWith('"') && path.endsWith('"')) {
                        path = path.slice(1, -1);
                    }
                    paths.push(path);
                    i = j;
                    break;
                }
                if (tokens[j].type === TokenType.Semicolon || tokens[j].type === TokenType.RBrace)
                    break;
            }
        }
    }
    return paths;
}

/**
 * Pre-register struct and trait names from module files so the Function
 * constructor can resolve them during entry parsing. Does a lightweight
 * token scan to find `struct <Name>` and `trait <Name>` patterns.
 */
function preRegisterModuleTypes(
    filename: string,
    files: Record<string, string>,
    visited: Set<string>
): void {
    if (visited.has(filename)) return;
    visited.add(filename);

    const source = files[filename];
    if (source === undefined) return;

    const tokens = scan(source);

    // Recursively process dependencies first
    const usePaths = collectUseDirectives(tokens);
    for (const depPath of usePaths) {
        preRegisterModuleTypes(depPath, files, visited);
    }

    // Scan for struct and trait declarations
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].type === TokenType.Struct) {
            // struct <Name> { ... }
            if (i + 1 < tokens.length && tokens[i + 1].type === TokenType.Identifier) {
                const name = tokens[i + 1].text;
                registerStruct(name, []);
            }
        }
        if (tokens[i].type === TokenType.Trait) {
            // trait <Name> { ... }
            if (i + 1 < tokens.length && tokens[i + 1].type === TokenType.Identifier) {
                const name = tokens[i + 1].text;
                registerTrait(name, []);
            }
        }
    }
}

/**
 * Recursively link module dependencies into a single flattened array of expressions.
 * Replaces each `use "path"` node with the target module's top-level expressions.
 * Returns the flattened expressions, or null on error.
 */
function flattenModule(
    filename: string,
    files: Record<string, string>,
    visiting: Set<string>,
    visited: Set<string>,
    errors: { line: number; col: number; message: string; filename?: string }[]
): Expression[] | null {
    if (visited.has(filename)) return [];
    if (visiting.has(filename)) {
        errors.push({
            line: 0,
            col: 0,
            message: `Circular dependency detected: module '${filename}' is already being compiled.`,
            filename,
        });
        return null;
    }

    const source = files[filename];
    if (source === undefined) {
        errors.push({
            line: 0,
            col: 0,
            message: `Module '${filename}' not found. Make sure it is included in the provided files.`,
            filename,
        });
        return null;
    }

    visiting.add(filename);

    // Parse without cascadeTypes — we'll resolve types on the unified AST
    const tokens = scan(source);
    const { ast, errors: parseErrors } = parse(tokens, true, true);
    if (parseErrors.length > 0) {
        for (const e of parseErrors) {
            errors.push({ line: e.line, col: e.col, message: e.message, filename });
        }
        return null;
    }
    if (!(ast instanceof Block)) {
        errors.push({
            line: 0,
            col: 0,
            message: `Module '${filename}' has no top-level block.`,
            filename,
        });
        return null;
    }

    // Tag all expressions in this module with their source file
    tagSourceFileTree(ast, filename);

    // Re-register functions so the per-module registry gets them with sourceFile
    for (const expr of ast.expressions) {
        let e = expr;
        while (e instanceof DropValue) e = e.child;
        if (e instanceof FunctionDef && !e.isGeneric && e.fullName) {
            registerFunction(e);
        }
    }

    // Recursively flatten dependencies, then replace UseModule nodes
    const result: Expression[] = [];
    for (const expr of ast.expressions) {
        if (expr instanceof UseModule) {
            const subExprs = flattenModule(expr.path, files, visiting, visited, errors);
            if (subExprs === null) return null;
            result.push(...subExprs);
        } else {
            result.push(expr);
        }
    }

    visiting.delete(filename);
    visited.add(filename);
    return result;
}

/**
 * Recursively set sourceFile on every node in an expression tree.
 * TODO: This function is extremely inelegant. The way this should probably work instead
 *  is to have sourceFile be a required attribute of the Expression class, and set it for all
 *  expressions when they are first constructed during parsing.
 */
function tagSourceFileTree(node: Expression, sourceFile: string): void {
    node.sourceFile = sourceFile;
    const skipKeys = new Set(["parent", "type"]);
    for (const key of Object.keys(node) as (keyof Expression)[]) {
        if (skipKeys.has(key as string)) continue;
        const val = (node as unknown as Record<string, unknown>)[key as string];
        if (val instanceof Expression) {
            tagSourceFileTree(val, sourceFile);
        } else if (Array.isArray(val)) {
            for (const item of val) {
                if (item instanceof Expression) {
                    tagSourceFileTree(item, sourceFile);
                } else if (
                    item &&
                    typeof item === "object" &&
                    "value" in (item as Record<string, unknown>)
                ) {
                    const kw = item as { value: Expression };
                    if (kw.value instanceof Expression) {
                        tagSourceFileTree(kw.value, sourceFile);
                    }
                } else if (
                    item &&
                    typeof item === "object" &&
                    ("condition" in (item as Record<string, unknown>) ||
                        "branch" in (item as Record<string, unknown>))
                ) {
                    const cb = item as { condition?: Expression; branch?: Expression };
                    if (cb.condition instanceof Expression)
                        tagSourceFileTree(cb.condition, sourceFile);
                    if (cb.branch instanceof Expression) tagSourceFileTree(cb.branch, sourceFile);
                }
            }
        }
    }
}

/**
 * Phase 0: Pre-register struct and trait names from dependency modules so the
 * Function constructor can resolve type names during entry parsing.
 */
function preRegisterDependencies(
    entryTokens: { type: TokenType; text: string }[],
    files: Record<string, string>
): void {
    const visited = new Set<string>();
    const usePaths = collectUseDirectives(entryTokens);
    for (const depPath of usePaths) {
        preRegisterModuleTypes(depPath, files, visited);
    }
}

/**
 * Phase 2: Link modules — flatten all `use` directives into a single array of
 * expressions, tag every node with its source file, and record selective import
 * rules. Entry functions are re-registered last so they take priority over
 * module functions with the same name.
 */
function linkModules(
    entryAst: Block,
    entry: string,
    files: Record<string, string>,
    errors: { line: number; col: number; message: string; filename?: string }[]
): Expression[] | null {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const expressions: Expression[] = [];

    for (const expr of entryAst.expressions) {
        if (expr instanceof UseModule) {
            if (expr.symbols && expr.symbols.length > 0) {
                setSelectiveImportRule(entry, expr.path, new Set(expr.symbols));
            }
            const subExprs = flattenModule(expr.path, files, visiting, visited, errors);
            if (subExprs === null) return null;
            expressions.push(...subExprs);
        } else {
            tagSourceFileTree(expr, entry);
            expressions.push(expr);
        }
    }

    // Re-register entry functions after flattening so they take priority
    for (const expr of expressions) {
        if (expr.sourceFile !== entry) continue;
        let e = expr;
        while (e instanceof DropValue) e = e.child;
        if (e instanceof FunctionDef && !e.isGeneric && e.fullName) {
            registerFunction(e);
        }
    }

    return expressions;
}

/**
 * Phase 3: Set parent pointers, type-check the unified AST, and verify it
 * produces a non-Null value. Returns null on error (errors are pushed into
 * the `errors` array).
 */
function typeCheckBlock(
    unifiedBlock: Block,
    errors: { line: number; col: number; message: string; filename?: string }[]
): boolean {
    try {
        unifiedBlock.cascadeTypes(null, true);
    } catch (e) {
        if (e instanceof ASTError) {
            errors.push({ line: e.line, col: e.col, message: e.message, filename: e.sourceFile });
        } else if (e instanceof Error) {
            errors.push({ line: 0, col: 0, message: e.message });
        } else {
            throw e;
        }
        return false;
    }
    if (unifiedBlock.type === "Null") {
        const lastExpr = unifiedBlock.expressions[unifiedBlock.expressions.length - 1];
        errors.push({
            line: lastExpr.line,
            col: lastExpr.col,
            message: "Program must end with a value expression.",
            filename: lastExpr.sourceFile,
        });
        return false;
    }
    return true;
}

/**
 *
 * Single-file mode (backwards compatible):
 *   compile(source: string, mode)
 *
 * Multi-file mode:
 *   compile(files: Record<string, string>, mode, entry?)
 *
 * Returns the compiled JS and any compile-time errors.
 */
export function compile(
    filesOrSource: Record<string, string> | string,
    mode: "immediate" | "inline" | "export" = "immediate",
    entry?: string
): CompileResult {
    let files: Record<string, string>;
    if (typeof filesOrSource === "string") {
        files = { "main.gema": filesOrSource };
        entry = "main.gema";
    } else {
        files = filesOrSource;
        entry = entry ?? "main.gema";
    }

    resetRegistries();
    const errors: { line: number; col: number; message: string; filename?: string }[] = [];

    try {
        const entrySource = files[entry];
        if (entrySource === undefined) {
            return {
                js: "",
                result: null,
                errors: [
                    {
                        line: 0,
                        col: 0,
                        message: `Entry file '${entry}' not found.`,
                        filename: entry,
                    },
                ],
                runtimeError: null,
            };
        }

        const entryTokens = scan(entrySource);

        // Phase 0: Pre-register struct/trait names from dependencies
        preRegisterDependencies(entryTokens, files);

        // Phase 1: Parse entry (AST only, no type resolution yet)
        const { ast: entryAst, errors: parseErrors } = parse(entryTokens, false, true);
        if (parseErrors.length > 0) {
            for (const e of parseErrors) {
                errors.push({ line: e.line, col: e.col, message: e.message, filename: entry });
            }
            return { js: "", result: null, errors, runtimeError: null };
        }
        if (!(entryAst instanceof Block)) {
            return {
                js: "",
                result: null,
                errors: [
                    {
                        line: 0,
                        col: 0,
                        message: "Entry file has no top-level block.",
                        filename: entry,
                    },
                ],
                runtimeError: null,
            };
        }

        // Phase 2: Link modules into a unified expression list
        const linkedExprs = linkModules(entryAst, entry!, files, errors);
        if (linkedExprs === null || errors.length > 0) {
            return { js: "", result: null, errors, runtimeError: null };
        }

        // Phase 3: Type-check the unified AST
        const rootToken = { line: 0, col: 0, text: "", type: TokenType.LBrace };
        const unifiedBlock = new Block(rootToken, linkedExprs);
        if (!typeCheckBlock(unifiedBlock, errors)) {
            return { js: "", result: null, errors, runtimeError: null };
        }

        // Phase 3.5: Tree-shaking — remove unreachable definitions
        const filteredBlock = treeShake(unifiedBlock, entry);

        // Phase 4: Codegen
        const js = writeJS(filteredBlock, mode);
        return { js, result: null, errors: [], runtimeError: null };
    } catch (e) {
        const message =
            e instanceof ASTError ? e.message : e instanceof Error ? e.message : String(e);
        const line = e instanceof ASTError ? e.line : 0;
        const col = e instanceof ASTError ? e.col : 0;
        return {
            js: "",
            result: null,
            errors: [{ line, col, message, filename: entry }],
            runtimeError: null,
        };
    }
}
