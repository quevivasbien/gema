export const BUILTINS: Record<string, string> = {
    // ── Math helpers ──
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

    // ── Iterator classes ──
    // Base iterator that wraps an array
    $ArrayIterator$: `class $ArrayIterator$ {
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
    clone() {
        return new $ArrayIterator$(this.array);
    }
}`,
    // Numeric range: start..end with optional step
    // Different versions implemented for Num and Int inputs
    $RangeIterator$: `class $RangeIterator$ {
    constructor(start, end, step=1) {
        this.value = start;
        this.start = start;
        this.end = end;
        this.step = step;
    }
    next() {
        if (this.end !== undefined) {
            if (this.step > 0 ? this.value > this.end : this.value < this.end) {
                this.reset();
                return undefined;
            }
        }
        const value = this.value;
        this.value += this.step;
        return value;
    }
    reset() {
        this.value = this.start;
    }
    clone() {
        return new $RangeIterator$(this.start, this.end, this.step);
    }
}`,
    $IntRangeIterator$: `class $IntRangeIterator$ {
    constructor(start, end, step=1n) {
        this.value = start;
        this.start = start;
        this.end = end;
        this.step = step;
    }
    next() {
        if (this.end !== undefined) {
            if (this.step > 0n ? this.value > this.end : this.value < this.end) {
                this.reset();
                return undefined;
            }
        }
        const value = this.value;
        this.value += this.step;
        return value;
    }
    reset() {
        this.value = this.start;
    }
    clone() {
        return new $IntRangeIterator$(this.start, this.end, this.step);
    }
}`,
    $ConcatIterator$: `class $ConcatIterator$ {
    constructor(iter1, iter2) {
        this.iter1 = iter1;
        this.iter2 = iter2;
        this.currentIter = 0;
    }
    next() {
        if (this.currentIter === 0) {
            const value = this.iter1.next();
            if (value === undefined) {
                this.currentIter++;
                return this.next();
            }
            return value;
        }
        const value = this.iter2.next();
        if (value === undefined) {
            this.reset();
        }
        return value;
    }
    reset() {
        this.currentIter = 0;
        this.iter1.reset();
        this.iter2.reset();
    }
    clone() {
        return new $ConcatIterator$(this.iter1.clone(), this.iter2.clone());
    }
}`,
    // Transforms each element via a mapping function
    $MapIterator$: `class $MapIterator$ {
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
    clone() {
        return new $MapIterator$(this.mapfn, this.innerIter.clone());
    }
}`,
    // Map via array index lookup (arr.map(indexIter))
    $ArrayMapIterator$: `class $ArrayMapIterator$ {
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
    clone() {
        return new $ArrayMapIterator$(this.arr, this.innerIter.clone());
    }
}`,
    // Filters elements by predicate
    $FilterIterator$: `class $FilterIterator$ {
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
    clone() {
        return new $FilterIterator$(this.filterFn, this.innerIter.clone());
    }
}`,
    // Takes the first N elements
    $TakeIterator$: `class $TakeIterator$ {
    constructor(count, innerIter) {
        this.remaining = count;
        this.innerIter = innerIter;
        this.originalCount = count;
    }
    next() {
        if (!this.remaining) {
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
    clone() {
        return new $TakeIterator$(this.originalCount, this.innerIter.clone());
    }
}`,
    // Takes elements while predicate holds
    $TakeWhileIterator$: `class $TakeWhileIterator$ {
    constructor(pred, innerIter) {
        this.pred = pred;
        this.innerIter = innerIter;
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
    clone() {
        return new $TakeWhileIterator$(this.pred, this.innerIter.clone());
    }
}`,
    // Skips the first N elements
    $DropIterator$: `class $DropIterator$ {
    constructor(count, innerIter) {
        this.toSkip = count;
        this.innerIter = innerIter;
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
    clone() {
        return new $DropIterator$(this.toSkip, this.innerIter.clone());
    }
}`,
    // Skips elements while predicate holds
    $DropWhileIterator$: `class $DropWhileIterator$ {
    constructor(pred, innerIter) {
        this.pred = pred;
        this.innerIter = innerIter;
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
    clone() {
        return new $DropWhileIterator$(this.pred, this.innerIter.clone());
    }
}`,
    // Repeatedly applies fn: iterate(fn, start) → start, fn(start), fn(fn(start)), …
    $IterateIterator$: `class $IterateIterator$ {
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
    clone() {
        return new $IterateIterator$(this.fn, this.start);
    }
}`,
    // Yields every stepSize-th element from an iterator
    $StepIterator$: `class $StepIterator$ {
    constructor(stepSize, innerIter) {
        this.stepSize = stepSize;
        this.innerIter = innerIter;
        this.count = 0;
    }
    next() {
        while (true) {
            const value = this.innerIter.next();
            if (value === undefined) {
                this.reset();
                return undefined;
            }
            if (this.count % this.stepSize === 0) {
                this.count++;
                return value;
            }
            this.count++;
        }
    }
    reset() {
        this.innerIter.reset();
        this.count = 0;
    }
    clone() {
        return new $StepIterator$(this.stepSize, this.innerIter.clone());
    }
}`,
    // Zips multiple iterators together, yielding arrays of values
    $ZipIterator$: `class $ZipIterator$ {
    constructor(...iterators) {
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
    clone() {
        return new $ZipIterator$(...this.iterators.map(i => i.clone()));
    }
}`,
    // Repeats an iterator n times (infinitely if n <= 0)
    $RepeatIterator$: `class $RepeatIterator$ {
    constructor(count, innerIter) {
        this.count = count;
        this.remaining = count;
        this.innerIter = innerIter;
    }
    next() {
        const value = this.innerIter.next();
        if (value !== undefined) return value;
        this.innerIter.reset();
        if (this.remaining > 0) {
            this.remaining--;
            if (this.remaining === 0) return undefined;
        }
        // remaining <= 0 means infinite — keep going
        return this.innerIter.next();
    }
    reset() {
        this.innerIter.reset();
        this.remaining = this.count;
    }
    clone() {
        return new $RepeatIterator$(this.count, this.remaining, this.innerIter.clone());
    }
}`,
    // Repeats each element n times before moving to the next
    $RepeatInnerIterator$: `class $RepeatInnerIterator$ {
    constructor(count, innerIter) {
        this.repeatCount = count;
        this.innerIter = innerIter;
        this.currentValue = undefined;
        this.timesYielded = 0;
    }
    next() {
        if (this.timesYielded > 0 && this.timesYielded < this.repeatCount) {
            this.timesYielded++;
            return this.currentValue;
        }
        this.currentValue = this.innerIter.next();
        if (this.currentValue === undefined) {
            this.reset();
            return undefined;
        }
        this.timesYielded = 1;
        return this.currentValue;
    }
    reset() {
        this.innerIter.reset();
        this.currentValue = undefined;
        this.timesYielded = 0;
    }
    clone() {
        return new $RepeatInnerIterator$(this.count, this.innerIter.clone());
    }
}`,
    // Generates the cartesian product of multiple iterators
    $CartesianIterator$: `class $CartesianIterator$ {
    constructor(...iterators) {
        this.iterators = iterators.map(i => ({ iter: i, saved: [] }));
        this.finished = false;
        // Collect all elements upfront since we need random access
        for (const entry of this.iterators) {
            while (true) {
                const v = entry.iter.next();
                if (v === undefined) break;
                entry.saved.push(v);
            }
            entry.iter.reset();
            if (entry.saved.length === 0) {
                this.finished = true;
                break;
            }
        }
        this.indices = new Array(this.iterators.length).fill(0);
    }
    next() {
        if (this.finished) return undefined;
        const result = this.indices.map((idx, i) => this.iterators[i].saved[idx]);
        // Advance indices (rightmost first, like odometer)
        let pos = this.indices.length - 1;
        while (pos >= 0) {
            this.indices[pos]++;
            if (this.indices[pos] < this.iterators[pos].saved.length) break;
            this.indices[pos] = 0;
            pos--;
        }
        if (pos < 0) this.finished = true;
        return result;
    }
    reset() {
        this.indices = new Array(this.iterators.length).fill(0);
        this.finished = false;
        for (const entry of this.iterators) {
            if (entry.saved.length === 0) { this.finished = true; break; }
        }
    }
    clone() {
        return new $CartesianIterator$(...this.iterators.map(i => i.clone()));
    }
}`,
    // Generates all permutations of an iterator
    $PermutationsIterator$: `class $PermutationsIterator$ {
    constructor(innerIter, innerIsArray=false) {
        if (innerIsArray) {
            this.elements = innerIter;
        } else {
            // Collecting and storing inner iterator makes this a lot more efficient
            this.elements = [];
            while (true) {
                const nextElement = innerIter.next();
                if (nextElement === undefined) {
                    break;
                }
                this.elements.push(nextElement);
            }
            innerIter.reset();
        }
        this.n = this.elements.length;
        this.indices = new Array(this.n).fill(0).map((_, i) => i);
        this.done = this.n === 0;
    }
    next() {
        if (this.done) return undefined;
        const result = this.indices.map(i => this.elements[i]);
        // Generate next permutation of indices in lexicographic order
        let i = this.n - 2;
        while (i >= 0 && this.indices[i] >= this.indices[i + 1]) i--;
        if (i < 0) {
            this.done = true;
        } else {
            let j = this.n - 1;
            while (this.indices[j] <= this.indices[i]) j--;
            [this.indices[i], this.indices[j]] = [this.indices[j], this.indices[i]];
            // Reverse suffix
            let left = i + 1;
            let right = this.n - 1;
            while (left < right) {
                [this.indices[left], this.indices[right]] = [this.indices[right], this.indices[left]];
                left++;
                right--;
            }
        }
        return result;
    }
    reset() {
        this.indices = new Array(this.n).fill(0).map((_, i) => i);
        this.done = this.n === 0;
    }
    clone() {
        return new $PermutationsIterator$(this.elements, true);
    }
}`,
    // Generates all combinations of n elements from an iterator
    $CombinationsIterator$: `class $CombinationsIterator$ {
    constructor(choose, innerIter, innerIsArray=false) {
        if (innerIsArray) {
            this.elements = innerIter;
        } else {
            // Collecting and storing inner iterator makes this a lot more efficient
            this.elements = [];
            while (true) {
                const nextElement = innerIter.next();
                if (nextElement === undefined) {
                    break;
                }
                this.elements.push(nextElement);
            }
            innerIter.reset();
        }
        this.choose = choose;
        this.indices = new Array(this.choose).fill(0).map((_, i) => i);
        this.done = this.choose > this.elements.length || this.choose === 0;
    }
    next() {
        if (this.done) return undefined;
        const result = this.indices.map(i => this.elements[i]);
        // Advance to next combination
        let i = this.choose - 1;
        while (i >= 0 && this.indices[i] === this.elements.length - this.choose + i) i--;
        if (i < 0) {
            this.done = true;
        } else {
            this.indices[i]++;
            for (let j = i + 1; j < this.choose; j++) {
                this.indices[j] = this.indices[j - 1] + 1;
            }
        }
        return result;
    }
    reset() {
        this.indices = new Array(this.choose).fill(0).map((_, i) => i);
        this.done = this.choose > this.elements.length || this.choose === 0;
    }
    clone() {
        return new $CombinationsIterator$(this.choose, this.elements, true);
    }
}`,
    // ── Iterator terminal operations ──
    // Collect an iterator into an array
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
    // Left-fold: reduce(fn, init, iter)
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
    // Indexed access into an iterator
    $iterGet$: `function $iterGet$(index, iter) {
    let count = 0;
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
    // Last element (undefined if empty)
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
    // Number of elements
    $length$: `function $length$(iter) {
    let count = 0;
    while (true) {
        const value = iter.next();
        if (value === undefined) {
            iter.reset();
            return count;
        }
        count++;
    }
}`,

    // ── Iterator search helpers ──
    // contains(iter, value) — check if value exists in iterator
    $contains$: `function $contains$(value, iter) {
    while (true) {
        const v = iter.next();
        if (v === undefined) {
            iter.reset();
            return false;
        }
        if (v === value) return true;
    }
}`,
    // find(iter, value) — find index of value in iterator (returns undefined if not found)
    $find$: `function $find$(value, iter) {
    let idx = 0;
    while (true) {
        const v = iter.next();
        if (v === undefined) {
            iter.reset();
            return undefined;
        }
        if (v === value) return idx;
        idx++;
    }
}`,

    // ── Mutable array operations ──
    // arr.push(val)
    $push$: `function $push$(val, mutarr) {
    mutarr.push(val);
    return mutarr;
}`,
    // arr[idx] = val
    $put$: `function $put$(val, idx, mutarr) {
    mutarr[idx] = val;
    return mutarr;
}`,

    // ── Mutable dict operations ──
    // dict.set(key, val)
    $putMutDict$: `function $putMutDict$(val, key, mutdict) {
    mutdict.set(key, val);
    return mutdict;
}`,
    // dict.delete(key)
    $removeMutDict$: `function $removeMutDict$(key, mutdict) {
    mutdict.delete(key);
    return mutdict;
}`,

    // ── Mutable set operations ──
    // set.add(val)
    $pushMutSet$: `function $pushMutSet$(val, mutset) {
    mutset.add(val);
    return mutset;
}`,
    // set.delete(val)
    $removeMutSet$: `function $removeMutSet$(val, mutset) {
    mutset.delete(val);
    return mutset;
}`,

    // ── Control flow sentinel classes ──
    // Used for Gema `return` — thrown to unwind IIFEs and caught at function boundary
    $Return$: `class $Return$ {
    constructor(value) {
        this.value = value;
    }
}`,
    // Used for Gema `continue` — thrown to unwind IIFEs and caught at loop boundary
    $Continue$: `class $Continue$ {
    constructor() {}
}`,
    // Used for Gema `break` — thrown to unwind IIFEs and caught at loop boundary
    $Break$: `class $Break$ {
    constructor() {}
}`,

    // ── Maybe / None handling ──
    // Unwrap a Maybe value; returns the value or fallback (throws if no fallback)
    $unwrapWithFallback$: `function $unwrapWithFallback$(fallback, value) {
    if (value === undefined) {
        return fallback;
    }
    return value;
}`,
    // Unwrap a Maybe value; returns the value or fallback (throws if no fallback)
    $unwrapNoFallback$: `function $unwrapNoFallback$(value) {
    if (value === undefined) {
        throw new Error("Unwrapped on None without a fallback value");
    }
    return value;
}`,
};
