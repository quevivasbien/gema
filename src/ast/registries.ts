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

// Reset tracking state between compilations
export function resetRegistries(): void {
    consumedVars.clear();
}
