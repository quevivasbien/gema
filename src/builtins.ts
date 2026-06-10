export const BUILTINS: Record<string, string> = {
    __MOD__: `function __MOD__(a, b) {
    return ((a % b) + b) % b;
}`,
    __ARRAY_EQUAL__: `function __ARRAY_EQUAL__(a, b) {
    if (a.length !== b.length) {
        return false;
    }
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            return false;
        }
    }
    return true;
}`,
    __COLLECT__: `function __COLLECT__(iter) {
    const out = [];
    while (true) {
        const value = iter.next();
        if (value === undefined) {
            iter.reset();
            break;
        }
        out.push(value);
    }
    return out;
}`,
    __ARRAYITER__: `class _ARRAY_ITERATOR_ {
    constructor(array) {
        this.array = array;
        this.index = 0;
    }
    next() {
        const value = this.array[this.index++];
        if (value === undefined) {
            this.reset();
        }
        return value;
    }
    reset() {
        this.index = 0;
    }
}
function __ARRAYITER__(array) {
    return new _ARRAY_ITERATOR_(array);
}`,
    __RANGEITER__: `class _RANGE_ITERATOR_ {
    constructor(start, end, step) {
        this.value = start;
        this.start = start;
        this.end = end;
        this.step = step;
    }
    next() {
        if (this.step > 0 ? this.value > this.end : this.value < this.end) {
            this.reset();
            return undefined;
        }
        const value = this.value;
        this.value += this.step;
        return value;
    }
    reset() {
        this.value = this.start;
    }
}
function __RANGEITER__(start, end, step = 1n) {
    return new _RANGE_ITERATOR_(start, end, step);
}`,
    __MAPITER__: `class _MAP_ITERATOR_ {
    constructor(mapfn, innerIter) {
        this.mapfn = mapfn;
        this.innerIter = innerIter;
    }
    next() {
        const value = this.innerIter.next();
        if (value === undefined) {
            this.reset();
            return undefined;
        }
        return this.mapfn(value);
    }
    reset() {
        this.innerIter.reset();
    }
}
function __MAPITER__(mapfn, innerIter) {
    return new _MAP_ITERATOR_(mapfn, innerIter);
}`,
    __ARRAYMAPITER__: `class _ARRAY_MAP_ITERATOR_ {
    constructor(arr, innerIter) {
        this.arr = arr;
        this.innerIter = innerIter;
    }
    next() {
        const value = this.innerIter.next();
        if (value === undefined) {
            this.reset();
            return undefined;
        }
        return this.arr[value];
    }
    reset() {
        this.innerIter.reset();
    }
}
function __ARRAYMAPITER__(arr, innerIter) {
    return new _ARRAY_MAP_ITERATOR_(arr, innerIter);
}`,
    __FILTERITER__: `class _FILTER_ITERATOR_ {
    constructor(filterFn, innerIter) {
        this.filterFn = filterFn;
        this.innerIter = innerIter;
    }
    next() {
        while (true) {
            const value = this.innerIter.next();
            if (value === undefined) {
                this.reset();
                break;
            }
            if (this.filterFn(value)) {
                return value;
            }
        }
        return undefined;
    }
    reset() {
        this.innerIter.reset();
    }
}
function __FILTERITER__(filterFn, innerIter) {
    return new _FILTER_ITERATOR_(filterFn, innerIter);
}`,
    __REDUCE__: `function __REDUCE__(reduceFn, initValue, iter) {
    let accumulated = initValue;
    while (true) {
        const value = iter.next();
        if (value === undefined) {
            iter.reset();
            break;
        }
        accumulated = reduceFn(accumulated, value);
    }
    return accumulated;
}`,
    __ITER_GET__: `function __ITER_GET__(iter, index) {
    let count = 0n;
    while (true) {
        const value = iter.next();
        if (value === undefined) {
            iter.reset();
            return undefined;
        }
        if (count === index) {
            iter.reset();
            return value;
        }
        count++;
    }
}`,
    __TAKEITER__: `class _TAKE_ITERATOR_ {
    constructor(innerIter, count) {
        this.innerIter = innerIter;
        this.remaining = count;
        this.originalCount = count;
    }
    next() {
        if (this.remaining <= 0) {
            this.reset();
            return undefined;
        }
        const value = this.innerIter.next();
        if (value === undefined) {
            this.reset();
            return undefined;
        }
        this.remaining--;
        return value;
    }
    reset() {
        this.innerIter.reset();
        this.remaining = this.originalCount;
    }
}
function __TAKEITER__(count, iter) {
    return new _TAKE_ITERATOR_(iter, count);
}`,
    __TAKEWHILEITER__: `class _TAKEWHILE_ITERATOR_ {
    constructor(innerIter, pred) {
        this.innerIter = innerIter;
        this.pred = pred;
    }
    next() {
        const value = this.innerIter.next();
        if (value === undefined || !this.pred(value)) {
            this.reset();
            return undefined;
        }
        return value;
    }
    reset() {
        this.innerIter.reset();
    }
}
function __TAKEWHILEITER__(pred, iter) {
    return new _TAKEWHILE_ITERATOR_(iter, pred);
}`,
    __DROPITER__: `class _DROP_ITERATOR_ {
    constructor(innerIter, count) {
        this.innerIter = innerIter;
        this.toSkip = count;
        this.dropping = true;
    }
    next() {
        if (this.dropping) {
            for (let i = 0; i < this.toSkip; i++) {
                const value = this.innerIter.next();
                if (value === undefined) {
                    this.reset();
                    return undefined;
                }
            }
            this.dropping = false;
        }
        const value = this.innerIter.next();
        if (value === undefined) {
            this.reset();
            return undefined;
        }
        return value;
    }
    reset() {
        this.innerIter.reset();
        this.dropping = true;
    }
}
function __DROPITER__(count, iter) {
    return new _DROP_ITERATOR_(iter, count);
}`,
    __DROPWHILEITER__: `class _DROPWHILE_ITERATOR_ {
    constructor(innerIter, pred) {
        this.innerIter = innerIter;
        this.pred = pred;
        this.dropping = true;
    }
    next() {
        if (this.dropping) {
            while (true) {
                const value = this.innerIter.next();
                if (value === undefined) {
                    this.reset();
                    return undefined;
                }
                if (!this.pred(value)) {
                    this.dropping = false;
                    return value;
                }
            }
        }
        const value = this.innerIter.next();
        if (value === undefined) {
            this.reset();
            return undefined;
        }
        return value;
    }
    reset() {
        this.innerIter.reset();
        this.dropping = true;
    }
}
function __DROPWHILEITER__(pred, iter) {
    return new _DROPWHILE_ITERATOR_(iter, pred);
}`,
    __ITERATEITER__: `class _ITERATE_ITERATOR_ {
    constructor(fn, start) {
        this.fn = fn;
        this.current = start;
        this.first = true;
        this.start = start;
    }
    next() {
        if (this.first) {
            this.first = false;
            return this.current;
        }
        this.current = this.fn(this.current);
        return this.current;
    }
    reset() {
        this.current = this.start;
        this.first = true;
    }
}
function __ITERATEITER__(fn, start) {
    return new _ITERATE_ITERATOR_(fn, start);
}`,
    __LAST__: `function __LAST__(iter) {
    let lastValue;
    while (true) {
        const value = iter.next();
        if (value === undefined) {
            iter.reset();
            return lastValue;
        }
        lastValue = value;
    }
}`,
    __LENGTH__: `function __LENGTH__(iter) {
    let count = 0n;
    while (true) {
        const value = iter.next();
        if (value === undefined) {
            iter.reset();
            return count;
        }
        count++;
    }
}`,
};
