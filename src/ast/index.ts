// Registries & global state
export {
    checkSelectiveImport,
    findFunction,
    findFunctionInModule,
    getAllMonomorphized,
    getMonomorphized,
    getEnum,
    getSelectiveImportRules,
    getStruct,
    getTrait,
    isCrossModuleRefAllowed,
    isVarConsumed,
    markVarConsumed,
    registerEnum,
    registerFunction,
    registerMonomorphized,
    registerStruct,
    registerTrait,
    resetRegistries,
    setSelectiveImportRule,
} from "./registries";

// Base expression classes
export { ASTError, Block, DropValue, ErrorExpression, Expression } from "./expression";

// Control flow
export { Break, Continue, ForLoop, If, Return } from "./control-flow";

// Literals
export { Literal } from "./literals";

// Operators
export { Binary, Unary } from "./operators";

// Nodes (variables, functions, tuples)
export { AnonymousFunction, FunctionDef, RangeIter, TupleLit, UseModule, Variable } from "./nodes";

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
export { findCaller } from "./caller";

// Parent pointer setup
export { setParentPointers } from "./set-parent-pointers";

// Reachability (for tree shaking)
export { computeReachable } from "./reachability";
