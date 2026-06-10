# Roadmap for `gema` development

## More iterator ops

Here are some new operations on iterators that would be nice to have:

- `take(iter, i)` which gives us a iterator with up to `i` of the first consecutive elements of `iter`
- `takeWhile(iter, f)` which gives us an iterator that takes elements as long as we meet some predicate, similar to how `filter` works
- Analogously: `drop` and `dropWhile`
- `iterate(f, start)` repeatedly applies f; gives `start, f(start), f(f(start)), f(f(f(start))), ...`
- `last(iter)` gives the final element in the iterator -- will probably want to specially handle the case where we provide a list to this one, instead of implicitly converting, so we can take advantage of the known length of a list.
- `length(iter)` gives the length of an iterator (again, will want a special case for arrays)

## Mutable variables

Here is the basic syntax that we want to be able to support:

```gema
mut x = 1;
x = x + 1;  # x == 2
x = 0;  # x == 0

mut y = 1;
y += 1;  # y == 2
y = x;  # y == 0

mut arr = [1, 2, 3];
arr += [1];  # arr == [1, 2, 3, 1]
arr = [];  # arr = [0]

struct Point { x: Int, y: Int }
mut p = Point(1, 2);
p = Point(2, 3);  # p == Point(2, 3)

func add(a: Point, b: Point) {
  Point(a.x + b.x, a.y + b.y)
}
# add is defined, so += should also work
p += Point(4, 5)  # p == Point(6, 8)
```

Here are some examples of code that should fail at parsing:

```gema
x = 1;
# Both of the below should fail -- Can't re-assign or shadow non-mutable var
x += 1;
x = 0;

mut arr = [1, 2, 3];
# Both of these will fail because elements of an array are immutable even if the array itself is mutable -- Will have a separate data type for arrays with mutable contents
push(arr, 4)
arr(0) = 1

struct Point { x: Int, y: Int }
mut p = Point(1, 2);
# Should fail because we can't mutate a non-mutable member of a struct, even if the struct itself is mutable
p.x = 2;
```

### How to mutate elements of arrays or members of structs?

We have a separate mutable array type with special rules

```gema
mutarr = mut([]:Int);  # This creates a new empty mutable array
push(mutarr, 1);
set(mutarr, 0, 2);
arr = freeze(mutarr);  # This converts the mutable array to a non-mutable array. In JS, this is a no-op; trying to access mutarr after this point should give a compile-time error.
```

Another example

```gema
x = [1, 2, 3];

# Here we need to a deep copy of x so that if we access x later, it won't have changed from its original value.
# Maybe we should also have an `unsafe mut` operation that avoids copying
y = mut(x);
y(0) += 1;  # Array access to an element of an Arr[mut T] should give us a value that behaves like a variable of type mut T.
mut a = y(1); a += 1;  # Modifying a won't modify y, since basic numeric types create copies when they assigned from other vars.

z = freeze(y);  # z == [2, 2 3]
x == z  # Evaluates to false since [1, 2, 3] != [2, 2, 3]
```

A more complicated example

```
x = [[1], [2], [3]];
y = mut(x);
mut a = y(0);
b = y(0);
a = [1, 2];
a == b  # Will evaluate to false; we've reassigned a, but that doesn't modify the array that a originally pointed to.

# Note that we haven't actually modified y; we've just created copies of pointers to its first element.

# We cannot do this, because the elements of y are not mutable even if y itself is mutable
# push(y(0), 2);
```

Structs must be declared with mutable members in order to mutate their contents:

```gema
struct MutPoint {
    mut x: Int,
    mut y: Int,
}
p = MutPoint(1, 2);
p.x = 2;  # This is allowed!
p = MutPoint(2, 2);  # This is not allowed, since p itself was not declared as mutable.

struct HalfMutPoint {
    mut x: Int,
    y: Int,
}
q = HalfMutPoint(1, 2);
q.y = 2;  # This is not allowed, since field y was not declared as mutable.
```

## For loops

We should introduce for a for loop along with this:

```gema
func factorial(i: Int) {
    mut result = 1;
    # Syntax is <variable> = <iterator>
    # Loop runs until iterator is exhausted
    # This is itself an expression; its value is the last value it has when its source iterator runs out
    for j = range(1, i) {
        result *= j
    }
}
```

## Tuples

We need some sort of data structure that (1) is both guaranteed to have a fixed length, (2) can hold multiple data types at the same time, and (3) doesn't require special declaration beforehand (so we can't just use structs for this purpose).

Proposed syntax:
```gema
tup = (1, 2.0, "hello");  # Creates a Tuple[Int, Float, Str]
first = tup(0);

func getThreeTypes(x: Int): Tuple[Int, Float, Str] {
    (x, toFloat(x), toStr(x))
}
```

It would be nice to have automatic unpacking, so we can do things like:
```gema
x = (1, 2, 3);
(a, b, c) = x;
# Or, if we want to be able to mutate one of the resulting vars:
(mut d, e, mut f) = x;
d = 0;  # Note that this won't impact x, since automatic unpacking will always copy values.
```

We this data type, we can support a zip iterator:
```gema
zipped = zip([1, 2, 3], range(1, 3));

zipped(0)  # Evaluates to (1, 1)
```
