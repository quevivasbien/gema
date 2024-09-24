# gema

A simple programming language that transpiles to JavaScript.


## Setup

This project uses the [Bun](https://bun.sh) JavaScript runtime and package manager, though you should also be able to use Node + NPM (or similar) as drop-in replacements.

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

## Language examples

### Assign variables
```
x = 1
y = 2.17828

z = x + y
# z = 3.17828
```

### Conditional expressions
```
x = 2

zeroIfOdd = if (x % 2 == 0) {
    x
} else {
    0
}

# zeroIfOdd = 2


x = 3

zeroIfOdd = if (x % 2 == 0) {
    x
} else {
    0
}

# zeroIfOdd = 0
```

### Functions
```
func isOdd(x: Int): Bool {
    x % 2 == 0
}
```