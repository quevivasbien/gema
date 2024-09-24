export const BUILTINS: Record<string, string> = {
    "__MOD__": (
`function __MOD__(a, b) {
    return ((a % b) + b) % b;
}`
    ),
};