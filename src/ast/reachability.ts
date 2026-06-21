import type { Type } from "../types";
import {
    ArrayType,
    IterType,
    MutArrType,
    TupleType,
    DictType,
    MutDictType,
    SetType,
    MutSetType,
    MaybeType,
    FuncType,
    CustomType,
} from "../types";
import { findFunction } from "./registries";
import { Block, Function, Assignment, Variable } from "./nodes";
import { StructDef } from "./structs";
import { Call } from "./calls";
import { DropValue, Expression } from "./expression";

/**
 * Collect all CustomType names referenced anywhere in a type tree.
 */
function collectCustomTypeNames(type: Type, names: Set<string>): void {
    if (type instanceof CustomType) {
        names.add(type.name);
    } else if (
        type instanceof ArrayType ||
        type instanceof IterType ||
        type instanceof MutArrType
    ) {
        collectCustomTypeNames(type.innerType, names);
    } else if (type instanceof TupleType) {
        for (const t of type.types) collectCustomTypeNames(t, names);
    } else if (type instanceof DictType || type instanceof MutDictType) {
        collectCustomTypeNames(type.keyType, names);
        collectCustomTypeNames(type.valueType, names);
    } else if (type instanceof SetType || type instanceof MutSetType) {
        collectCustomTypeNames(type.innerType, names);
    } else if (type instanceof MaybeType) {
        collectCustomTypeNames(type.innerType, names);
    } else if (type instanceof FuncType) {
        for (const t of type.paramTypes) collectCustomTypeNames(t, names);
        collectCustomTypeNames(type.returnType, names);
    }
}

/**
 * Walk an expression subtree and collect referenced fullNames and CustomType names.
 */
function collectReferences(
    node: Expression,
    referencedNames: Set<string>,
    referencedTypes: Set<string>
): void {
    if (node.type) {
        collectCustomTypeNames(node.type, referencedTypes);
    }

    // Extract name references from key node types (these are stored in string
    // fields, not as Expression children, so the generic walk won't find them).
    if (node instanceof Call && node.referToByName) {
        referencedNames.add(node.referToByName);
    } else if (node instanceof Variable && node.fullName) {
        referencedNames.add(node.fullName);
    } else if (node instanceof Function && node.fullName) {
        referencedNames.add(node.fullName);
    }

    // Recurse into children
    if (node instanceof DropValue) {
        collectReferences(node.child, referencedNames, referencedTypes);
    } else if (node instanceof Block) {
        for (const expr of node.expressions) {
            collectReferences(expr, referencedNames, referencedTypes);
        }
    } else if (node instanceof Assignment) {
        collectReferences(node.value, referencedNames, referencedTypes);
    } else {
        // Generic walk for other AST node properties.
        // Skip 'parent' to avoid walking up the tree (creates infinite recursion).
        const skipKeys = new Set(["parent", "type"]);
        for (const key of Object.keys(node) as (keyof Expression)[]) {
            if (skipKeys.has(key as string)) continue;
            const val = (node as unknown as Record<string, unknown>)[key as string];
            if (val instanceof Expression) {
                collectReferences(val, referencedNames, referencedTypes);
            } else if (Array.isArray(val)) {
                for (const item of val) {
                    if (item instanceof Expression) {
                        collectReferences(item, referencedNames, referencedTypes);
                    } else if (
                        item &&
                        typeof item === "object" &&
                        "value" in (item as Record<string, unknown>)
                    ) {
                        const kw = item as { value: Expression };
                        if (kw.value instanceof Expression) {
                            collectReferences(kw.value, referencedNames, referencedTypes);
                        }
                    }
                }
            }
        }
    }
}

/**
 * Compute the set of reachable definitions in a unified Block after cascadeTypes.
 *
 * Phase 1: Scan the entire Block for CustomType names (struct/trait type references).
 * Phase 2: Trace function/variable references starting from the last expression
 *          (the entry's return value), following transitive function body refs.
 * Phase 3: Mark structs that appear in any expression's type as reachable.
 *
 * Returns a Set of fullNames that are reachable.
 */
export function computeReachable(block: Block): Set<string> {
    const reachable = new Set<string>();
    const referencedTypes = new Set<string>();

    // Phase 1: Collect all type references from the entire Block
    for (const expr of block.expressions) {
        const names = new Set<string>();
        const types = new Set<string>();
        collectReferences(expr, names, types);
        for (const t of types) referencedTypes.add(t);
    }

    // Phase 2: Trace reachable references starting from the entry's return value
    const queue: Expression[] = [block.expressions[block.expressions.length - 1]];

    while (queue.length > 0) {
        const node = queue.pop()!;
        const names = new Set<string>();
        const types = new Set<string>();
        collectReferences(node, names, types);

        for (const name of names) {
            if (reachable.has(name)) continue;
            reachable.add(name);

            const fn = findFunction(name);
            if (fn && fn.body) {
                queue.push(fn.body);
            }
        }
        for (const t of types) referencedTypes.add(t);
    }

    // Phase 3: Structs referenced in any type are reachable
    for (const expr of block.expressions) {
        let e = expr;
        while (e instanceof DropValue) e = e.child;
        if (e instanceof StructDef && e.name && referencedTypes.has(e.name)) {
            reachable.add(e.name);
        }
    }

    return reachable;
}
