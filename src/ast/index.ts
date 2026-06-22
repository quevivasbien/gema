// Registries & global state
export {
    checkSelectiveImport,
    findFunction,
    findFunctionInModule,
    getAllMonomorphized,
    getMonomorphized,
    getSelectiveImportRules,
    getStruct,
    getTrait,
    isCrossModuleRefAllowed,
    isVarConsumed,
    markVarConsumed,
    registerFunction,
    registerMonomorphized,
    registerStruct,
    registerTrait,
    resetRegistries,
    setSelectiveImportRule,
} from "./registries";

// Base expression classes
export { ASTError, DropValue, ErrorExpression, Expression } from "./expression";

// Literals
export { Literal } from "./literals";

// Operators
export { Binary, Unary } from "./operators";

// Nodes (variables, control flow, functions)
export {
    AnonymousFunction,
    Assignment,
    Block,
    Break,
    Continue,
    ForLoop,
    FunctionDef,
    If,
    RangeIter,
    Return,
    UseModule,
    Variable,
} from "./nodes";

// Calls
export { Call, DirectCall } from "./calls";

// Tuples
export { TupleLit, TupleUnpack } from "./nodes";

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
