import type { FunctionDef } from "./nodes";
import {
    EnumType,
    type EnumVariant,
    setEnumTypeResolver,
    type TemplateTypes,
    type Type,
} from "./types";

// Global registry of trait definitions, keyed by trait name
const traitRegistry: Map<string, { name: string; paramNames: string[]; types: TemplateTypes }[]> =
    new Map();

export function registerTrait(
    name: string,
    requiredFunctions: { name: string; paramNames: string[]; types: TemplateTypes }[]
): void {
    traitRegistry.set(name, requiredFunctions);
}

export function getTrait(
    name: string
): { name: string; paramNames: string[]; types: TemplateTypes }[] | undefined {
    return traitRegistry.get(name);
}

// Global registry of struct definitions, keyed by struct name
const structRegistry: Map<
    string,
    { name: string; fields: { name: string; type: Type; mutable: boolean }[] }
> = new Map();

export function registerStruct(
    name: string,
    fields: { name: string; type: Type; mutable: boolean }[]
): void {
    structRegistry.set(name, { name, fields });
}

export function getStruct(
    name: string
): { name: string; fields: { name: string; type: Type; mutable: boolean }[] } | undefined {
    return structRegistry.get(name);
}

// Global registry of enum definitions, keyed by enum name
const enumRegistry: Map<string, { name: string; variants: EnumVariant[] }> = new Map();

export function registerEnum(name: string, variants: EnumVariant[]): void {
    enumRegistry.set(name, { name, variants });
}

// Register the enum type resolver so getType() can return EnumType for enum names
setEnumTypeResolver((name: string) => {
    const enumInfo = enumRegistry.get(name);
    if (enumInfo) {
        return new EnumType(enumInfo.name, enumInfo.variants);
    }
    return null;
});

export function getEnum(name: string): { name: string; variants: EnumVariant[] } | undefined {
    return enumRegistry.get(name);
}

// Global cache of monomorphized functions, keyed by fullName
const monomorphizedCache: Map<string, FunctionDef> = new Map();

// Global registry of all named functions, keyed by fullName (non-generic) or name (generic)
const functionRegistry: Map<string, FunctionDef> = new Map();

// Per-module function registries: modulePath → fullName → Function
const functionRegistryByModule = new Map<string, Map<string, FunctionDef>>();

export function registerFunction(fn: FunctionDef): void {
    if (!fn.isGeneric) {
        functionRegistry.set(fn.fullName, fn);
        // Also index by sourceFile for scoped lookups
        if (fn.sourceFile) {
            let modReg = functionRegistryByModule.get(fn.sourceFile);
            if (!modReg) {
                modReg = new Map();
                functionRegistryByModule.set(fn.sourceFile, modReg);
            }
            modReg.set(fn.fullName, fn);
        }
    }
}

export function findFunction(fullName: string): FunctionDef | undefined {
    return functionRegistry.get(fullName) ?? monomorphizedCache.get(fullName);
}

/**
 * Look up a function scoped to a specific module and its selective imports.
 * Searches the module's own registry first, then imported modules (checking
 * the selective import rules), then the monomorphized cache.
 */
export function findFunctionInModule(
    fullName: string,
    modulePath: string | undefined,
    getImportRules: (sourceModule: string) => Map<string, Set<string>> | undefined
): FunctionDef | undefined {
    if (!modulePath) {
        // No module context — fall back to global lookup
        return findFunction(fullName);
    }

    // 1. Own module
    const ownReg = functionRegistryByModule.get(modulePath);
    if (ownReg) {
        const fn = ownReg.get(fullName);
        if (fn) return fn;
    }

    // 2. Imported modules (checking selective import rules)
    const baseName = fullName.includes("$") ? fullName.slice(0, fullName.indexOf("$")) : fullName;
    const importRules = getImportRules(modulePath);
    if (importRules) {
        for (const [importedModule, allowedSymbols] of importRules) {
            if (!allowedSymbols.has(baseName)) continue;
            const importedReg = functionRegistryByModule.get(importedModule);
            if (importedReg) {
                const fn = importedReg.get(fullName);
                if (fn) return fn;
            }
        }
    }

    // 3. Monomorphized cache (global)
    return monomorphizedCache.get(fullName);
}

export function getMonomorphized(fullName: string): FunctionDef | undefined {
    return monomorphizedCache.get(fullName);
}

export function registerMonomorphized(fullName: string, fn: FunctionDef): void {
    monomorphizedCache.set(fullName, fn);
    // Also index monomorphized functions in per-module registry
    if (fn.sourceFile) {
        let modReg = functionRegistryByModule.get(fn.sourceFile);
        if (!modReg) {
            modReg = new Map();
            functionRegistryByModule.set(fn.sourceFile, modReg);
        }
        modReg.set(fullName, fn);
    }
}

export function getAllMonomorphized(): Map<string, FunctionDef> {
    return monomorphizedCache;
}

// Track variable names that have been consumed (e.g., by detrans).
// After detrans(mutarr), 'mutarr' is added here and cannot be used as a MutArr.
const consumedVars = new Map<string, boolean>();

export function isVarConsumed(name: string): boolean {
    return consumedVars.has(name);
}

export function markVarConsumed(name: string): void {
    consumedVars.set(name, true);
}

/** Snapshot the current consumedVars state (for scoping around function bodies). */
export function saveConsumedVars(): Map<string, boolean> {
    return new Map(consumedVars);
}

/** Restore consumedVars to a prior snapshot. */
export function restoreConsumedVars(snapshot: Map<string, boolean>): void {
    consumedVars.clear();
    for (const [k, v] of snapshot) {
        consumedVars.set(k, v);
    }
}

// Selective import rules: sourceModule → { targetModule → allowedSymbols }
const selectiveImportRules = new Map<string, Map<string, Set<string>>>();

export function setSelectiveImportRule(
    sourceModule: string,
    targetModule: string,
    symbols: Set<string>
): void {
    let targetMap = selectiveImportRules.get(sourceModule);
    if (!targetMap) {
        targetMap = new Map();
        selectiveImportRules.set(sourceModule, targetMap);
    }
    targetMap.set(targetModule, symbols);
}

/**
 * Check whether `symbol` may be used in `sourceModule` when it was defined in
 * `targetModule`. Returns true if there are no selective import restrictions,
 * or if the symbol is in the allowed list.
 */
export function checkSelectiveImport(
    sourceModule: string,
    targetModule: string,
    symbol: string
): boolean {
    const targetMap = selectiveImportRules.get(sourceModule);
    if (!targetMap) return true; // no selective import rules for this source
    const allowed = targetMap.get(targetModule);
    if (!allowed) return true; // no selective import rules for this target
    return allowed.has(symbol);
}

/** Get the selective import rules for a source module. */
export function getSelectiveImportRules(
    sourceModule: string
): Map<string, Set<string>> | undefined {
    return selectiveImportRules.get(sourceModule);
}

/**
 * Check whether a cross-module reference from `sourceFile` to a definition in
 * `targetFile` with the given `name` is allowed. Returns true if either module
 * has no selective import rules, or if the name is in the allowed list.
 */
export function isCrossModuleRefAllowed(
    sourceFile: string | undefined,
    targetFile: string | undefined,
    name: string
): boolean {
    if (!sourceFile || !targetFile || sourceFile === targetFile) return true;
    const importRules = selectiveImportRules.get(sourceFile);
    if (!importRules) return true;
    const allowed = importRules.get(targetFile);
    if (!allowed) return true;
    return allowed.has(name);
}

// Reset all global registries (useful between tests)
export function resetRegistries(): void {
    traitRegistry.clear();
    structRegistry.clear();
    enumRegistry.clear();
    functionRegistry.clear();
    monomorphizedCache.clear();
    consumedVars.clear();
    selectiveImportRules.clear();
    functionRegistryByModule.clear();
}
