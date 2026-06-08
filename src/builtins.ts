export const BUILTINS: Record<string, string> = {
    "__MOD__": (
`function __MOD__(a, b) {
    return ((a % b) + b) % b;
}`
    ),
    "__ARRAY_EQUAL__": (
`function __ARRAY_EQUAL__(a, b) {
    if (a.length !== b.length) {
        return false;
    }
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            return false;
        }
    }
    return true;
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
    "__RANGEITER__": (
`class _RANGE_ITERATOR_ {
    constructor(start, end, step) {
        this.value = start;
        this.end = end;
        this.step = step;
    }
    next() {
        if (this.step > 0 ? this.value > this.end : this.value < this.end) {
            return undefined;
        }
        const value = this.value;
        this.value += this.step;
        return value;
    }
}
function __RANGEITER__(start, end, step = 1n) {
    return new _RANGE_ITERATOR_(start, end, step);
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
    "__ARRAYMAPITER__": (
`class _ARRAY_MAP_ITERATOR_ {
    constructor(arr, innerIter) {
        this.arr = arr;
        this.innerIter = innerIter;
    }
    next() {
        const value = this.innerIter.next();
        if (value === undefined) {
            return undefined;
        }
        return this.arr[value];
    }
}
function __ARRAYMAPITER__(arr, innerIter) {
    return new _ARRAY_MAP_ITERATOR_(arr, innerIter);
}`
    ),
    "__FILTERITER__": (
`class _FILTER_ITERATOR_ {
    constructor(filterFn, innerIter) {
        this.filterFn = filterFn;
        this.innerIter = innerIter;
    }
    next() {
        while (true) {
            const value = this.innerIter.next();
            if (value === undefined) {
                break;
            }
            if (this.filterFn(value)) {
                return value;
            }
        }
        return undefined;
    }
}
function __FILTERITER__(filterFn, innerIter) {
    return new _FILTER_ITERATOR_(filterFn, innerIter);
}`
    ),
    "__REDUCE__": (
`function __REDUCE__(reduceFn, innerIter, initValue) {
    let accumulated = initValue;
    while (true) {
        const value = innerIter.next();
        if (value === undefined) {
            break;
        }
        accumulated = reduceFn(accumulated, value);
    }
    return accumulated;
}`
    ),
    "__ITER_GET__": (
`function __ITER_GET__(iter, index) {
    let count = 0n;
    while (true) {
        const value = iter.next();
        if (value === undefined) {
            return undefined;
        }
        if (count === index) {
            return value;
        }
        count++;
    }
}`
    )
};