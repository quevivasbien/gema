import { type TemplateTypes, type Type } from "../types";
import type { Function } from "./nodes";

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

// Global cache of monomorphized functions, keyed by fullName
const monomorphizedCache: Map<string, Function> = new Map();

// Global registry of all named functions (non-generic), keyed by fullName
const functionRegistry: Map<string, Function> = new Map();

export function registerFunction(fn: Function): void {
    if (!fn.isGeneric) {
        functionRegistry.set(fn.fullName, fn);
    }
}

export function findFunction(fullName: string): Function | undefined {
    return functionRegistry.get(fullName) ?? monomorphizedCache.get(fullName);
}

export function getMonomorphized(fullName: string): Function | undefined {
    return monomorphizedCache.get(fullName);
}

export function registerMonomorphized(fullName: string, fn: Function): void {
    monomorphizedCache.set(fullName, fn);
}

export function getAllMonomorphized(): Map<string, Function> {
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

// Reset all global registries (useful between tests)
export function resetRegistries(): void {
    traitRegistry.clear();
    structRegistry.clear();
    functionRegistry.clear();
    monomorphizedCache.clear();
    consumedVars.clear();
}
