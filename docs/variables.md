# Variables: Declaration, Reassignment, and Shadowing

## Declarations

A variable is declared by assigning a value to a name:

```gema
x = 1             # immutable variable
mut y = 1         # mutable variable
```

A declaration creates a new variable in the **current scope**. The `mut`
keyword is only meaningful on a declaration — it cannot appear on a
reassignment.

The `Assign` node produced by the parser carries `is_mut: true` when `mut`
is present.  During name resolution, if the name is **not** already
defined in the current scope, a new `Variable` symbol is registered.

Using `mut` on a name that already exists in the current scope is an
error, since it indicates confusion between declaration and reassignment.

## Reassignments

An existing mutable variable can be reassigned by assigning to its name
without `mut`:

```gema
mut y = 1
y = 2             # valid — reassigns the outer mutable
y += 1            # valid — compound assignment, same rule
```

The parser produces the same `Assign` node for both declarations and
reassignments.  During name resolution:

1. If the name is already defined in the **current scope**, it is a
   reassignment — no new symbol is registered.  The type checker later
   verifies that the variable is marked `is_mut`.
2. If the name is already defined in an **ancestor scope** and that
   symbol is a `Variable` with `is_mut: true`, it is a reassignment of
   the ancestor's mutable variable — no new symbol is registered.
3. Otherwise, it is a new declaration.

A reassignment to an immutable variable is valid at the name resolution
level; the type checker will reject it with an appropriate error.

## Shadowing

A new declaration in a child scope **shadows** any variable with the same
name in an ancestor scope:

```gema
x = 1             # immutable in root scope
{
    x = 2         # new immutable in block scope (shadows outer)
    x             # resolves to 2
}
x                 # resolves to 1
```

Shadowing applies regardless of whether the outer variable is mutable or
immutable.  The inner declaration is an independent variable with its own
type and mutability.

If the intent is to **modify** an outer mutable variable rather than
shadow it, write the reassignment **without** a `mut` keyword:

```gema
mut y = 1
{
    y = 2         # reassigns the outer mutable y (not a shadow)
}
y                 # resolves to 2
```

To explicitly create a new variable in a child scope (even when the
parent has a mutable variable with the same name), use `mut`:

```gema
mut y = 1
{
    mut y = 2     # new mutable in block scope (shadows outer)
    y             # resolves to 2
}
y                 # resolves to 1
```

## Summary of rules

| Pattern | Resolver behavior | Type checker |
|---------|------------------|-------------|
| `x = N` (name not in scope chain) | Register Variable | — |
| `mut x = N` (name not in scope chain) | Register Variable(`is_mut`) | — |
| `x = N` (name in current scope) | Skip (reassignment) | Error if immutable |
| `mut x = N` (name in current scope) | **Error**: `mut` cannot be used on reassignment | — |
| `x = N` (name in ancestor, parent `is_mut`) | Skip (reassignment of parent) | OK |
| `x = N` (name in ancestor, parent not `is_mut`) | Register (shadow) | Independent type |
| `mut x = N` (name in any ancestor) | Register (explicit shadow) | Independent type |
| `func f() {}` then `f = N` | Skip (treats as reassign) | Error: cannot assign to function |
