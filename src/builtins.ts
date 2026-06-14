export const BUILTINS: Record<string, string> = {
    $mod$: `function $mod$(a, b) {
    return ((a % b) + b) % b;
}`,
    $arrayEq$: `function $arrayEq$(a, b) {
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
    $collect$: `function $collect$(iter) {
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
    $arrayIter$: `class $ArrayIterator$ {
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
function $arrayIter$(array) {
    return new $ArrayIterator$(array);
}`,
    $rangeIter$: `class $RangeIterator$ {
    constructor(start, end, step) {
        this.value = start;
        this.start = start;
        this.end = end;
        this.step = step;
    }
    next() {
        if (this.end !== undefined && (this.step > 0 ? this.value > this.end : this.value < this.end)) {
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
function $rangeIter$(start, end, step = 1n) {
    return new $RangeIterator$(start, end, step);
}`,
    $mapIter$: `class $MapIterator$ {
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
function $mapIter$(mapfn, innerIter) {
    return new $MapIterator$(mapfn, innerIter);
}`,
    $arrayMapIter$: `class _ARRAY$MapIterator$ {
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
function $arrayMapIter$(arr, innerIter) {
    return new _ARRAY$MapIterator$(arr, innerIter);
}`,
    $filterIter$: `class $FilterIterator$ {
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
function $filterIter$(filterFn, innerIter) {
    return new $FilterIterator$(filterFn, innerIter);
}`,
    $reduce$: `function $reduce$(reduceFn, initValue, iter) {
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
    $iterGet$: `function $iterGet$(iter, index) {
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
    $takeIter$: `class $TakeIterator$ {
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
function $takeIter$(count, iter) {
    return new $TakeIterator$(iter, count);
}`,
    $takeWhileIter$: `class $TakeWhileIterator$ {
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
function $takeWhileIter$(pred, iter) {
    return new $TakeWhileIterator$(iter, pred);
}`,
    $dropIter$: `class $DropIterator$ {
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
function $dropIter$(count, iter) {
    return new $DropIterator$(iter, count);
}`,
    $dropWhileIter$: `class $DropWhileIterator$ {
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
function $dropWhileIter$(pred, iter) {
    return new $DropWhileIterator$(iter, pred);
}`,
    $iterateIter$: `class $IterateIterator$ {
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
function $iterateIter$(fn, start) {
    return new $IterateIterator$(fn, start);
}`,
    $last$: `function $last$(iter) {
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
    $length$: `function $length$(iter) {
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
    $push$: `function $push$(mutarr, val) {
    mutarr.push(val);
    return mutarr;
}`,
    $put$: `function $put$(mutarr, idx, val) {
    mutarr[idx] = val;
    return val;
}`,
    $putMutDict$: `function $putMutDict$(mutdict, key, val) {
    mutdict.set(key, val);
    return mutdict;
}`,
    $removeMutDict$: `function $removeMutDict$(mutdict, key) {
    mutdict.delete(key);
    return mutdict;
}`,
    $pushMutSet$: `function $pushMutSet$(mutset, val) {
    mutset.add(val);
    return mutset;
}`,
    $removeMutSet$: `function $removeMutSet$(mutset, val) {
    mutset.delete(val);
    return mutset;
}`,
    $stepIter$: `class $StepIterator$ {
    constructor(innerIter, stepSize) {
        this.innerIter = innerIter;
        this.stepSize = stepSize;
        this.count = 0n;
    }
    next() {
        while (true) {
            const value = this.innerIter.next();
            if (value === undefined) {
                this.reset();
                return undefined;
            }
            if (this.count % this.stepSize === 0n) {
                this.count++;
                return value;
            }
            this.count++;
        }
    }
    reset() {
        this.innerIter.reset();
        this.count = 0n;
    }
}
function $stepIter$(innerIter, stepSize) {
    if (typeof innerIter.next !== "function") {
        innerIter = $arrayIter$(innerIter);
    }
    return new $StepIterator$(innerIter, stepSize);
}`,
    $zip$: `function $zip$(...iters) {
    const iterators = iters.map((it) =>
        typeof it.next === "function" ? it : $arrayIter$(it)
    );
    return new $ZipIterator$(iterators);
}
class $ZipIterator$ {
    constructor(iterators) {
        this.iterators = iterators;
    }
    next() {
        const values = [];
        for (const iter of this.iterators) {
            const v = iter.next();
            if (v === undefined) {
                this.reset();
                return undefined;
            }
            values.push(v);
        }
        return values;
    }
    reset() {
        for (const iter of this.iterators) {
            iter.reset();
        }
    }
}`,
    $unwrap$: `function $unwrap$(value, fallback) {
    if (value === undefined) {
        if (arguments.length === 1) {
            throw new Error("Unwrapped on None without a fallback value");
        }
        return fallback;
    }
    return value;
}`,
    $isnone$: `function $isnone$(value) {
    return value === undefined;
}`,
};
