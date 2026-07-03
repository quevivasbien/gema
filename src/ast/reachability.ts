import { Call, DirectCall } from "./calls";
import { DropValue, Expression, Block } from "./expression";
import { Assignment, TupleUnpack } from "./assignment";
import { ForLoop, If } from "./control-flow";
import { FunctionDef } from "./function-defs";
import { UseModule, Variable } from "./nodes";
import { Binary } from "./operators";
import { FieldAccess, StructDef } from "./structs";
import { Trait } from "./traits";
import type { Type } from "./types";
import {
    ArrayType,
    CustomType,
    DictType,
    FuncType,
    IterType,
    MaybeType,
    MutArrType,
    MutDictType,
    MutSetType,
    SetType,
    TupleType,
} from "./types";

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
export function collectReferences(
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
    } else if (node instanceof FunctionDef && node.fullName) {
        referencedNames.add(node.fullName);
    } else if (node instanceof DirectCall && node.caller instanceof FieldAccess) {
        // Type-associated function call: TypeName.funcName(args)
        const fa = node.caller;
        if (fa.tafTargetName) {
            referencedNames.add(fa.tafTargetName);
        } else if (fa.obj instanceof Variable && fa.obj.fullName) {
            const tafName = `${fa.obj.fullName}.${fa.fieldName}`;
            // TAF function lookup uses scope; without global registry, add the name directly
            referencedNames.add(tafName);
        }
    } else if (node instanceof Assignment && node.name) {
        referencedNames.add(node.name);
    } else if (node instanceof TupleUnpack) {
        for (const binding of node.bindings) {
            referencedNames.add(binding.name);
        }
    }

    // Check for operator-overloaded Binary nodes where the resolved function
    // name is stored in overloadedAs.name (a string), not as a child Expression.
    if (node instanceof Binary && node.overloadedAs?.name) {
        referencedNames.add(node.overloadedAs.name);
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
    } else if (node instanceof If) {
        // If conditionalBranches and elseBranch contain Expression children
        for (const { condition, branch } of node.conditionalBranches) {
            collectReferences(condition, referencedNames, referencedTypes);
            collectReferences(branch, referencedNames, referencedTypes);
        }
        if (node.elseBranch !== null) {
            collectReferences(node.elseBranch, referencedNames, referencedTypes);
        }
    } else if (node instanceof ForLoop) {
        if (node.iter) collectReferences(node.iter, referencedNames, referencedTypes);
        collectReferences(node.body, referencedNames, referencedTypes);
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

    // Phase 2: Trace reachable references starting from all non-definition
    // top-level expressions (calls, for-loops, variables, etc.) so that
    // transitive dependencies are followed even for mid-block expressions.
    // Falls back to the last expression if everything is a definition.
    const explored = new Set<string>();
    const queue: Expression[] = [];
    for (const expr of block.expressions) {
        let e = expr;
        while (e instanceof DropValue) e = e.child;
        if (e instanceof FunctionDef) continue;
        if (e instanceof StructDef) continue;
        if (e instanceof Trait) continue;
        if (e instanceof Assignment) continue;
        if (e instanceof UseModule) continue; // Skip UseModule — inner defs traced via their callers
        queue.push(e);
    }
    // If nothing non-definition, start from the last expression (which may be
    // an Assignment — its name is found via collectReferences' new Assignment
    // handling).
    if (queue.length === 0) {
        queue.push(block.expressions[block.expressions.length - 1]);
    }
    while (queue.length > 0) {
        const node = queue.pop()!;
        const names = new Set<string>();
        const types = new Set<string>();
        collectReferences(node, names, types);

        for (const name of names) {
            reachable.add(name);
            if (explored.has(name)) continue;
            explored.add(name);

            // Follow function references: find the FunctionDef in the block (or
            // inside UseModule nodes) and recurse into its body.
            const searchExprs = (exprs: Expression[]) => {
                for (const expr of exprs) {
                    let e = expr;
                    while (e instanceof DropValue) e = e.child;
                    if (
                        e instanceof FunctionDef &&
                        (e.fullName === name ||
                            e.name === name ||
                            (name.includes("$") && e.name === name.split("$")[0]))
                    ) {
                        queue.push(e.body);
                        // Also trace into monomorphized versions
                        for (const mv of e.monomorphizedVersions) {
                            if (mv.fullName === name) {
                                queue.push(mv.body);
                            }
                        }
                    }
                    if (e instanceof Assignment && e.name === name && e.value) {
                        queue.push(e.value);
                    }
                    // Also search inside UseModule module blocks
                    if (e instanceof UseModule && e.moduleBlock) {
                        searchExprs(e.moduleBlock.expressions);
                    }
                }
            };
            searchExprs(block.expressions);
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
