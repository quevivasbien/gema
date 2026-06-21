// Registries & global state
export {
    registerTrait,
    getTrait,
    registerStruct,
    getStruct,
    registerFunction,
    findFunction,
    getMonomorphized,
    registerMonomorphized,
    getAllMonomorphized,
    isVarConsumed,
    markVarConsumed,
    registerModuleVar,
    findModuleVar,
    resetRegistries,
} from "./registries";

// Base expression classes
export { ASTError, Expression, ErrorExpression, DropValue } from "./expression";

// Literals
export { Literal } from "./literals";

// Operators
export { Unary, Binary } from "./operators";

// Nodes (variables, control flow, functions)
export {
    Block,
    If,
    ForLoop,
    Break,
    Continue,
    Return,
    RangeIter,
    UseModule,
    Variable,
    Assignment,
    AnonymousFunction,
    Function,
} from "./nodes";

// Calls
export { Call, DirectCall } from "./calls";

// Tuples
export { TupleLit, TupleUnpack } from "./nodes";

// Structs and arrays
export { ArrLit, StructDef, FieldAccess, FieldAssignment } from "./structs";

// Traits
export { Trait } from "./traits";

// Caller resolution
export { findCaller } from "./caller";

// Parent pointer setup
export { setParentPointers } from "./set-parent-pointers";
