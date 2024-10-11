export const BUILTINS: Record<string, string> = {
    "__MOD__": (
`function __MOD__(a, b) {
    return ((a % b) + b) % b;
}`
    ),
    "__COLLECT__": (
`function __COLLECT__(iter) {
    const out = [];
    while (true) {
        const value = iter.next();
        if (value === undefined) {
            break;
        }
        out.push(value);
    }
    return out;
}`
    ),
    "__ARRAYITER__": (
`class _ARRAY_ITERATOR_ {
    constructor(array) {
        this.array = array;
        this.index = 0;
    }
    next() {
        return this.array[this.index++];
    }
}
function __ARRAYITER__(array) {
    return new _ARRAY_ITERATOR_(array);
}`
    ),
    "__MAPITER__": (
`class _MAP_ITERATOR_ {
    constructor(mapfn, innerIter) {
        this.mapfn = mapfn;
        this.innerIter = innerIter;
    }

    next() {
        const value = this.innerIter.next();
        if (value === undefined) {
            return undefined;
        }
        return this.mapfn(value);
    }
}
function __MAPITER__(mapfn, innerIter) {
    return new _MAP_ITERATOR_(mapfn, innerIter);
}`
    ),
};