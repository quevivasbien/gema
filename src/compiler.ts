import { ASTError, Block, Expression, UseModule } from "./ast";
import { parse } from "./parse";
import { scan } from "./scan";
import { treeShake } from "./tree-shake";
import { writeJS } from "./write-js";

interface CompileResult {
    js: string;
    result: null;
    errors: { line: number; col: number; message: string; filename?: string }[];
}

// TODO: This should happen as part of parsing instead
/**
 * Recursively set sourceFile on every node in an expression tree.
 * Walks into UseModule.moduleBlock children to tag module expressions too.
 */
function tagSourceFileTree(node: Expression, sourceFile: string): void {
    node.sourceFile = sourceFile;
    // Walk into UseModule blocks with their own path
    if (node instanceof UseModule && node.moduleBlock) {
        // Tag the module block with the module's path, not the entry path
        tagSourceFileTree(node.moduleBlock, node.path);
        return;
    }
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
 * Type-check a Block and verify it produces a non-Null value.
 * Returns false on error (errors are pushed into the `errors` array).
 */
function typeCheckBlock(
    block: Block,
    errors: { line: number; col: number; message: string; filename?: string }[]
): boolean {
    try {
        block.cascadeTypes(null, true);
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
    if (block.type === "Null") {
        const lastExpr = block.expressions[block.expressions.length - 1];
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
            };
        }

        // Scan all files upfront so the parser can look up module tokens
        const moduleTokens: Record<string, ReturnType<typeof scan>> = {};
        for (const [filename, source] of Object.entries(files)) {
            moduleTokens[filename] = scan(source);
        }

        const entryTokens = moduleTokens[entry];

        // Parse entry — this recursively parses imported modules via child parsers.
        // Pass skipCascadeTypes=true so we cascade the unified tree once.
        const visitedModules = new Set<string>();
        visitedModules.add(entry); // mark entry as visited to prevent self-import
        const { ast: entryAst, errors: parseErrors } = parse(
            entryTokens,
            false,
            true, // skipCascadeTypes — we'll cascade the unified tree
            moduleTokens,
            visitedModules
        );
        if (parseErrors.length > 0) {
            for (const e of parseErrors) {
                errors.push({ line: e.line, col: e.col, message: e.message, filename: entry });
            }
            return { js: "", result: null, errors };
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
            };
        }

        // Tag entry expressions with sourceFile and set up selective import rules.
        // This ensures the global function registry only finds entry-level functions,
        // and selective import rules restrict cross-module lookups.
        Expression.entryFile = entry;
        tagSourceFileTree(entryAst, entry);
        // Import rules are now enforced by UseModule.cascadeTypes scope injection.
        // No need for global registry or per-module function indexing.

        // Type-check the AST (cascadeTypes sets parent pointers and resolves types)
        if (!typeCheckBlock(entryAst, errors)) {
            return { js: "", result: null, errors };
        }

        // Tree-shaking — remove unreachable definitions
        const filteredBlock = treeShake(entryAst);

        // Codegen
        const js = writeJS(filteredBlock, mode);
        return { js, result: null, errors: [] };
    } catch (e) {
        const message =
            e instanceof ASTError ? e.message : e instanceof Error ? e.message : String(e);
        const line = e instanceof ASTError ? e.line : 0;
        const col = e instanceof ASTError ? e.col : 0;
        return {
            js: "",
            result: null,
            errors: [{ line, col, message, filename: entry }],
        };
    }
}
