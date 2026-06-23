import {
    Assignment,
    Block,
    DropValue,
    EnumDef,
    type Expression,
    FunctionDef,
    StructDef,
    computeReachable,
    getSelectiveImportRules,
} from "./ast";
import { TokenType } from "./tokens";

/**
 * Check whether an expression from a different module should be kept despite
 * not being in the entry's selective import list. Returns true if another
 * module has a better claim to this name (meaning the other module's definition
 * is the one the entry actually imported, so this one can be dropped).
 */
function hasBetterClaim(
    baseName: string,
    e: Expression,
    entry: string,
    rules: Map<string, Set<string>> | undefined,
    block: Block
): boolean {
    if (!rules) return false;
    for (const other of block.expressions) {
        let oe = other;
        while (oe instanceof DropValue) oe = oe.child;
        if (oe === e) continue;
        // Check if another function/variable with the same name exists and
        // comes from a module whose import rules allow it.
        const sameName =
            (oe instanceof FunctionDef &&
                oe.fullName !== null &&
                baseNameOf(oe.fullName) === baseName) ||
            (oe instanceof Assignment && oe.name === baseName);
        if (!sameName) continue;
        const otherRules = rules.get(oe.sourceFile ?? "");
        if (!otherRules || otherRules.has(baseName)) {
            return true; // another module claims this name
        }
    }
    return false;
}

/** Extract the base name (before any type-suffix `$`) from a fullName. */
function baseNameOf(fullName: string): string {
    const idx = fullName.indexOf("$");
    return idx === -1 ? fullName : fullName.slice(0, idx);
}

/**
 * Determine whether a top-level expression survives tree-shaking.
 *
 * Rules:
 * - Non-definition expressions (traits, calls, generics, etc.) always survive.
 * - Concrete functions, variable assignments, and structs survive only if
 *   their name is reachable AND (if they come from a module) the entry's
 *   selective import rules prefer this particular definition over any other
 *   module's definition with the same name.
 */
function shouldKeepDefinition(
    e: Expression,
    reachable: Set<string>,
    entry: string | undefined,
    keptFullNames: Map<string, boolean>,
    block: Block
): boolean {
    const rules = entry ? getSelectiveImportRules(entry) : undefined;

    if (e instanceof FunctionDef && !e.isGeneric && e.fullName) {
        if (!reachable.has(e.fullName)) return false;
        if (keptFullNames.has(e.fullName)) return false;
        if (e.sourceFile && e.sourceFile !== entry) {
            const base = baseNameOf(e.fullName);
            const allowed = rules?.get(e.sourceFile);
            if (
                allowed &&
                !allowed.has(base) &&
                hasBetterClaim(base, e, entry ?? "", rules, block)
            ) {
                return false;
            }
        }
        keptFullNames.set(e.fullName, true);
        return true;
    }

    if (e instanceof Assignment && e.name && !e.isReassignment) {
        if (!reachable.has(e.name)) return false;
        if (keptFullNames.has(e.name)) return false;
        if (e.sourceFile && e.sourceFile !== entry) {
            const allowed = rules?.get(e.sourceFile);
            if (
                allowed &&
                !allowed.has(e.name) &&
                hasBetterClaim(e.name, e, entry ?? "", rules, block)
            ) {
                return false;
            }
        }
        keptFullNames.set(e.name, true);
        return true;
    }

    if (e instanceof StructDef && e.name) {
        return reachable.has(e.name);
    }
    if (e instanceof EnumDef && e.name) {
        return reachable.has(e.name);
    }

    return true;
}

/**
 * Tree-shaking — remove unreachable definitions from the unified
 * block. Returns a new Block containing only the expressions that survived.
 */
export function treeShake(unifiedBlock: Block, entry: string | undefined): Block {
    const reachable = computeReachable(unifiedBlock);
    const keptFullNames = new Map<string, boolean>();
    const filteredExprs = unifiedBlock.expressions.filter((expr) => {
        let e = expr;
        while (e instanceof DropValue) e = e.child;
        return shouldKeepDefinition(e, reachable, entry, keptFullNames, unifiedBlock);
    });
    const rootToken = { line: 0, col: 0, text: "", type: TokenType.LBrace };
    return new Block(rootToken, filteredExprs);
}
