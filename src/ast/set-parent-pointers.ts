import type { Expression } from "./expression";
// Import all Expression subclass types for instanceof checks
import { Call, DirectCall } from "./calls";
import { DropValue, ErrorExpression } from "./expression";
import { Literal } from "./literals";
import {
    AnonymousFunction,
    Assignment,
    Block,
    ForLoop,
    FunctionDef,
    If,
    Match,
    RangeIter,
    Return,
    TupleLit,
    TupleUnpack,
    UseModule,
    Variable,
} from "./nodes";
import { Binary, Unary } from "./operators";
import { ArrLit, FieldAccess, FieldAssignment, StructDef } from "./structs";
import { Trait } from "./traits";

/**
 * Walk an AST tree and set the `parent` pointer on every child node.
 * Must be called after any tree construction or cloning to ensure parent links
 * are valid for upward traversal (e.g. findEnclosing()).
 */
export function setParentPointers(node: Expression, parent: Expression | null = null): void {
    node.parent = parent;

    if (node instanceof Block) {
        for (const child of node.expressions) {
            setParentPointers(child, node);
        }
    } else if (node instanceof If) {
        for (const { condition, branch } of node.conditionalBranches) {
            setParentPointers(condition, node);
            setParentPointers(branch, node);
        }
        setParentPointers(node.elseBranch, node);
    } else if (node instanceof ForLoop) {
        if (node.iter) setParentPointers(node.iter, node);
        setParentPointers(node.body, node);
    } else if (node instanceof Match) {
        setParentPointers(node.scrutinee, node);
        if (node.someArm) {
            setParentPointers(node.someArm.body, node);
        }
        if (node.noneArm) {
            setParentPointers(node.noneArm, node);
        }
    } else if (node instanceof Return) {
        setParentPointers(node.value, node);
    } else if (node instanceof Assignment) {
        setParentPointers(node.value, node);
    } else if (node instanceof DropValue) {
        setParentPointers(node.child, node);
    } else if (node instanceof FunctionDef) {
        setParentPointers(node.body, node);
    } else if (node instanceof AnonymousFunction) {
        setParentPointers(node.body, node);
    } else if (node instanceof Call) {
        for (const arg of node.args) {
            setParentPointers(arg, node);
        }
        for (const kw of node.keywordArgs) {
            setParentPointers(kw.value, node);
        }
    } else if (node instanceof DirectCall) {
        setParentPointers(node.caller, node);
        for (const arg of node.args) {
            setParentPointers(arg, node);
        }
    } else if (node instanceof Unary) {
        setParentPointers(node.child, node);
    } else if (node instanceof Binary) {
        setParentPointers(node.left, node);
        setParentPointers(node.right, node);
    } else if (node instanceof Literal) {
        // Leaf node — no children
    } else if (node instanceof ArrLit) {
        for (const child of node.expressions) {
            setParentPointers(child, node);
        }
    } else if (node instanceof StructDef) {
        // Leaf node — no children
    } else if (node instanceof FieldAccess) {
        setParentPointers(node.obj, node);
    } else if (node instanceof FieldAssignment) {
        setParentPointers(node.obj, node);
        setParentPointers(node.value, node);
    } else if (node instanceof Variable) {
        // Leaf node — no children
    } else if (node instanceof TupleLit) {
        for (const elem of node.elements) {
            setParentPointers(elem, node);
        }
    } else if (node instanceof TupleUnpack) {
        setParentPointers(node.source, node);
    } else if (node instanceof RangeIter) {
        if (node.start) setParentPointers(node.start, node);
        if (node.end) setParentPointers(node.end, node);
        if (node.step) setParentPointers(node.step, node);
    } else if (node instanceof UseModule) {
        // Leaf node — no children
    } else if (node instanceof ErrorExpression) {
        // Leaf node — no children
    } else if (node instanceof Trait) {
        // Leaf node — no children
    }
    // Note: Add new Expression subclass cases here as they are introduced
}
