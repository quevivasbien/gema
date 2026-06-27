import {
    Assignment,
    Block,
    DropValue,
    EnumDef,
    type Expression,
    FunctionDef,
    StructDef,
    computeReachable,
    UseModule,
} from "./ast";
import { TokenType } from "./tokens";

/**
 * Check whether an expression from a different module should be kept despite
 * not being in the entry's selective import list. Returns true if another
 * module has a better claim to this name (meaning the other module's definition
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
function shouldKeepDefinition(e: Expression, reachable: Set<string>): boolean {
    if (e instanceof FunctionDef && !e.isGeneric && e.fullName) {
        return reachable.has(e.fullName);
    }

    if (e instanceof Assignment && e.name && !e.isReassignment) {
        return reachable.has(e.name);
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
/** Extract the base name (before any type-suffix `$`) from a fullName. */
function baseNameOf(fullName: string): string {
    const idx = fullName.indexOf("$");
    return idx === -1 ? fullName : fullName.slice(0, idx);
}

/**
 * Build a map of symbol → source module path for all selective imports.
 * The first module that selectively imports a symbol claims it.
 */
function buildSelectiveClaimMap(block: Block): Map<string, string> {
    const claimMap = new Map<string, string>();
    for (const expr of block.expressions) {
        let e = expr;
        while (e instanceof DropValue) e = e.child;
        if (e instanceof UseModule && e.symbols && e.symbols.length > 0) {
            for (const sym of e.symbols) {
                if (!claimMap.has(sym)) {
                    claimMap.set(sym, e.path);
                }
            }
        }
    }
    return claimMap;
}

/** Filter expressions inside a UseModule's moduleBlock through tree-shaking as well. */
function filterUseModule(
    um: UseModule,
    reachable: Set<string>,
    keptFullNames: Map<string, boolean>,
    claimMap: Map<string, string>
) {
    if (!um.moduleBlock) return;
    const isSelective = um.symbols && um.symbols.length > 0;
    const explicitSymbols = isSelective ? new Set(um.symbols!) : null;
    um.moduleBlock.expressions = um.moduleBlock.expressions.filter((expr) => {
        let e = expr;
        while (e instanceof DropValue) e = e.child;
        // Determine the base name for this definition
        let baseName: string | null = null;
        if (e instanceof FunctionDef && !e.isGeneric && e.fullName) {
            baseName = baseNameOf(e.fullName);
        } else if (e instanceof Assignment && e.name && !e.isReassignment) {
            baseName = e.name;
        } else if (e instanceof StructDef && e.name) {
            baseName = e.name;
        } else if (e instanceof EnumDef && e.name) {
            baseName = e.name;
        }
        if (baseName === null) return true; // non-definition expressions always kept

        // Check reachability
        const key = e instanceof FunctionDef && e.fullName ? e.fullName : baseName;
        if (!reachable.has(key)) return false;

        if (isSelective) {
            if (explicitSymbols!.has(baseName)) {
                // Explicitly imported: keep it (if not already claimed by another module)
                if (keptFullNames.has(key)) return false;
                keptFullNames.set(key, true);
                return true;
            } else {
                // Not explicitly imported — it's a transitive dependency.
                // Keep it only if no other module has explicitly claimed this symbol.
                const claimedModule = claimMap.get(baseName);
                if (claimedModule && claimedModule !== um.path) {
                    // Another module provides this symbol — drop it from here
                    return false;
                }
                if (keptFullNames.has(key)) return false;
                keptFullNames.set(key, true);
                return true;
            }
        } else {
            // Bare import: keep all reachable defs (dedup by keptFullNames)
            if (keptFullNames.has(key)) return false;
            keptFullNames.set(key, true);
            return true;
        }
    });
    // Also filter any nested UseModules inside this module
    for (const expr of um.moduleBlock.expressions) {
        let e = expr;
        while (e instanceof DropValue) e = e.child;
        if (e instanceof UseModule) {
            filterUseModule(e, reachable, keptFullNames, claimMap);
        }
    }
}

export function treeShake(unifiedBlock: Block): Block {
    const reachable = computeReachable(unifiedBlock);
    const keptFullNames = new Map<string, boolean>();
    const claimMap = buildSelectiveClaimMap(unifiedBlock);
    const filteredExprs = unifiedBlock.expressions.filter((expr) => {
        let e = expr;
        while (e instanceof DropValue) e = e.child;
        if (e instanceof UseModule) {
            // Filter the module's internal definitions too
            filterUseModule(e, reachable, keptFullNames, claimMap);
            return true;
        }
        return shouldKeepDefinition(e, reachable);
    });
    const rootToken = { line: 0, col: 0, text: "", type: TokenType.LBrace };
    return new Block(rootToken, filteredExprs);
}
