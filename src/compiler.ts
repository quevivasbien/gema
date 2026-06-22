import { scan } from "./scan";
import { parse } from "./parse";
import { writeJS } from "./write-js";
import { TokenType } from "./tokens";
import {
    resetRegistries,
    registerStruct,
    registerTrait,
    setSelectiveImportRule,
    registerFunction,
    getSelectiveImportRules,
} from "./ast";
import { setParentPointers } from "./ast/set-parent-pointers";
import { ASTError, Expression, DropValue } from "./ast/expression";
import { Block, UseModule, Function, Assignment } from "./ast/nodes";
import { StructDef } from "./ast/structs";
import { computeReachable } from "./ast/reachability";

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
        if (e instanceof Function && !e.isGeneric && e.fullName) {
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
 * Compile Gema source code to JavaScript.
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
    // Normalize arguments
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

        // Phase 0: Pre-register struct and trait names from all dependency modules
        // before parsing the entry file. This ensures the Function constructor
        // can resolve type names like struct names from modules.
        const preRegVisited = new Set<string>();
        const usePaths = collectUseDirectives(entryTokens);
        for (const depPath of usePaths) {
            preRegisterModuleTypes(depPath, files, preRegVisited);
        }

        // Phase 1: Parse the entry file (AST only, no type resolution yet)
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
                        message: `Entry file has no top-level block.`,
                        filename: entry,
                    },
                ],
                runtimeError: null,
            };
        }

        // Phase 2: Link modules — flatten all `use` directives into the entry's Block
        const visiting = new Set<string>();
        const visited = new Set<string>();
        const linkedExpressions: Expression[] = [];

        for (const expr of entryAst.expressions) {
            if (expr instanceof UseModule) {
                // Record selective import rules in the global registry
                if (expr.symbols && expr.symbols.length > 0) {
                    setSelectiveImportRule(entry!, expr.path, new Set(expr.symbols));
                }
                const subExprs = flattenModule(expr.path, files, visiting, visited, errors);
                if (subExprs === null) {
                    return { js: "", result: null, errors, runtimeError: null };
                }
                linkedExpressions.push(...subExprs);
            } else {
                // Tag entry expressions with the entry filename
                tagSourceFileTree(expr, entry!);
                linkedExpressions.push(expr);
            }
        }

        // Re-register entry functions so they take priority over module functions
        // that may have been registered during flattenModule above.
        for (const expr of linkedExpressions) {
            if (!expr.sourceFile || expr.sourceFile !== entry) continue;
            let e = expr;
            while (e instanceof DropValue) e = e.child;
            if (e instanceof Function && !e.isGeneric && e.fullName) {
                registerFunction(e);
            }
        }

        if (errors.length > 0) {
            return { js: "", result: null, errors, runtimeError: null };
        }

        // Build the unified Block AST
        const rootToken = { line: 0, col: 0, text: "", type: TokenType.LBrace };
        const unifiedBlock = new Block(rootToken, linkedExpressions);

        // Phase 3: Type-check the unified AST
        // Selective import validation happens inside Call.cascadeTypes() and
        // similar resolution methods, which check the target function's
        // sourceFile against the call site's sourceFile.
        setParentPointers(unifiedBlock);
        try {
            unifiedBlock.cascadeTypes(true);
        } catch (e) {
            if (e instanceof ASTError) {
                errors.push({ line: e.line, col: e.col, message: e.message });
                return { js: "", result: null, errors, runtimeError: null };
            }
            if (e instanceof Error) {
                errors.push({ line: 0, col: 0, message: e.message });
                return { js: "", result: null, errors, runtimeError: null };
            }
            throw e;
        }

        if (unifiedBlock.type === "Null") {
            // If after linking the last expression is still Null, it's an error
            // (module-only programs with no value expression)
            errors.push({ line: 0, col: 0, message: "Program must end with a value expression." });
            return { js: "", result: null, errors, runtimeError: null };
        }

        // Phase 3.5: Tree-shaking — remove unreachable definitions
        const reachable = computeReachable(unifiedBlock);

        // When multiple modules define the same fullName, only keep the one
        // from the module allowed by the entry's selective import rules.
        const keptFullNames = new Map<string, boolean>(); // fullName → already kept
        const filteredExprs = unifiedBlock.expressions.filter((expr) => {
            let e = expr;
            while (e instanceof DropValue) e = e.child;
            // Keep concrete functions only if reachable
            if (e instanceof Function && !e.isGeneric && e.fullName) {
                if (!reachable.has(e.fullName)) return false;
                // Deduplicate: if multiple modules define the same fullName,
                // prefer the one from the module allowed by import rules.
                if (keptFullNames.has(e.fullName)) return false;
                if (e.sourceFile && e.sourceFile !== entry) {
                    const rules = getSelectiveImportRules(entry!);
                    if (rules) {
                        const dollarIdx = e.fullName.indexOf("$");
                        const baseName =
                            dollarIdx === -1 ? e.fullName : e.fullName.slice(0, dollarIdx);
                        const allowed = rules.get(e.sourceFile);
                        // If this module has selective import rules and the
                        // name is NOT in the allowed list, check if it might
                        // be a duplicate from another module that does allow it.
                        if (allowed && !allowed.has(baseName)) {
                            // Look for another definition of this fullName
                            // from a module that allows this name
                            for (const other of unifiedBlock.expressions) {
                                let oe = other;
                                while (oe instanceof DropValue) oe = oe.child;
                                if (
                                    oe === e ||
                                    !(oe instanceof Function) ||
                                    oe.fullName !== e.fullName
                                )
                                    continue;
                                const otherRules = rules.get(oe.sourceFile ?? "");
                                if (!otherRules || otherRules.has(baseName)) {
                                    return false; // another module has a better claim
                                }
                            }
                            // No other module claims it — keep it (transitive dep)
                        }
                    }
                }
                keptFullNames.set(e.fullName, true);
                return true;
            }
            // Keep top-level variable assignments (non-reassignment) only if reachable
            if (e instanceof Assignment && e.name && !e.isReassignment) {
                if (!reachable.has(e.name)) return false;
                // Deduplicate variable names across modules
                if (keptFullNames.has(e.name)) return false;
                if (e.sourceFile && e.sourceFile !== entry) {
                    const rules = getSelectiveImportRules(entry!);
                    if (rules) {
                        const allowed = rules.get(e.sourceFile);
                        if (allowed && !allowed.has(e.name)) {
                            // Check if another module has a better claim
                            for (const other of unifiedBlock.expressions) {
                                let oe = other;
                                while (oe instanceof DropValue) oe = oe.child;
                                if (oe === e || !(oe instanceof Assignment) || oe.name !== e.name)
                                    continue;
                                const otherRules = rules.get(oe.sourceFile ?? "");
                                if (!otherRules || otherRules.has(e.name)) {
                                    return false;
                                }
                            }
                        }
                    }
                }
                keptFullNames.set(e.name, true);
                return true;
            }
            // Keep structs only if reachable (referenced in some type)
            if (e instanceof StructDef && e.name) {
                return reachable.has(e.name);
            }
            // Keep everything else (traits, generics, entry expressions, calls, etc.)
            return true;
        });
        const filteredBlock = new Block(rootToken, filteredExprs);

        // Phase 4: Codegen — one pass over the filtered AST
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
