// Base expression classes
export { ASTError, Block, DropValue, ErrorExpression, Expression } from "./expression";

// Control flow
export { Break, Continue, ForLoop, If, Return } from "./control-flow";

// Literals
export { Literal } from "./literals";

// Operators
export { Binary, Unary } from "./operators";

// Nodes (variables, tuples)
export {
    RangeIter,
    TupleLit,
    UseModule,
    UseJSModule,
    type JSImportSymbol,
    Variable,
} from "./nodes";

// Functions
export {
    FunctionDef,
    AnonymousFunction,
} from "./functions";

// Calls
export { Call, DirectCall } from "./calls";

// Variable assignment, including tuple unpacking
export { Assignment, TupleUnpack } from "./assignment";

// Enums and match
export {
    EnumDef,
    Match,
    NoneLit,
    type ElseArm,
    type MatchArm,
    type NoneArm,
    type SomeArm,
    type VariantArm,
} from "./enums";

// Structs and arrays
export { ArrLit, FieldAccess, FieldAssignment, StructDef } from "./structs";

// Traits
export { Trait } from "./traits";

// Caller resolution
export { findCaller } from "./caller-resolution";

// Reachability (for tree shaking)
export { computeReachable } from "./reachability";
