mod utils;

use utils::{assert_run, compile};

// ── Generated JS structure tests ──

#[test]
fn generic_func_no_overload_suffix() {
    // Generic function names should NOT have $N overload suffixes.
    let js = compile("func [T] id(x: T): T { x }");
    assert!(
        js.contains("function id("),
        "Generic func should not have suffix, got:\n{js}"
    );
    assert!(
        !js.contains("function id$"),
        "Generic func should not have $N suffix, got:\n{js}"
    );
}

#[test]
fn non_generic_func_has_overload_suffix() {
    // Non-generic functions should still have $N overload suffixes.
    let js = compile("func id(x: Int): Int { x }");
    assert!(
        js.contains("function id$0("),
        "Non-generic func should have $N suffix, got:\n{js}"
    );
}

#[test]
fn impl_block_emits_dictionary() {
    // Impl blocks should produce dictionary objects with trait methods.
    let js = compile(
        "trait Hash { hash: Func[Self: Int] }; \
         impl Int: Hash { func hash(x: Int): Int { x } }; \
         func [T: Hash] id(x: T): T { T::hash(x) }; \
         id(1i)",
    );
    // The impl block should produce a named dictionary (e.g., $impl_Int_Hash)
    assert!(
        js.contains("$impl_Int_Hash"),
        "Impl block should emit a named dictionary ($impl_Int_Hash), got:\n{js}"
    );
    // The generic function should reference the dictionary, not inline it
    assert!(
        js.contains("$impl_Int_Hash"),
        "Call site should reference the named impl dictionary, got:\n{js}"
    );
}

// ── Runtime tests ──

#[test]
fn generic_identity() {
    assert_run("func [T] id(x: T): T { x }; id(42i)", "42");
}
#[test]
fn generic_identity_str() {
    assert_run("func [T] id(x: T): T { x }; id(\"hello\")", "hello");
}
#[test]
fn generic_identity_bool() {
    assert_run("func [T] id(x: T): T { x }; id(true)", "true");
}
#[test]
fn generic_with_variable_arg() {
    assert_run("func [T] id(x: T): T { x }; y = 42i; id(y)", "42");
}
#[test]
fn generic_with_variable_arg_str() {
    assert_run("func [T] id(x: T): T { x }; y = \"hello\"; id(y)", "hello");
}
#[test]
fn generic_with_variable_arg_bool() {
    assert_run("func [T] id(x: T): T { x }; y = true; id(y)", "true");
}

#[test]
fn generic_with_trait_method_str() {
    assert_run(
        "trait Hash { hash: Func[Self: Int] }; \
         impl Str: Hash { func hash(x: Str): Int { 42i } }; \
         func [T: Hash] id(x: T): T { T::hash(x) }; \
         id(\"hello\")",
        "42",
    );
}

#[test]
fn generic_with_two_traits_separate_descriptors() {
    // Two traits with different method names should each get their own descriptor.
    assert_run(
        "trait Foo { foo: Func[Self: Self] }; \
         trait Bar { bar: Func[Self: Self] }; \
         impl Int: Foo { func foo(x: Int): Int { x + 1i } }; \
         impl Int: Bar { func bar(x: Int): Int { x + 2i } }; \
         func [T: Foo + Bar] add(x: T): T { T::foo(T::bar(x)) }; \
         add(10i)",
        "13",
    );
}

#[test]
fn generic_no_traits() {
    // Basic generic identity works with no trait requirements
    assert_run("func [T] id(x: T): T { x }; id(42i)", "42");
    assert_run("func [T] id(x: T): T { x }; id(\"hello\")", "hello");
    assert_run("func [T] id(x: T): T { x }; y = 42i; id(y)", "42");
}

#[test]
fn generic_nested_type_arr() {
    // Generic type param can appear inside nested types like Arr[T].
    assert_run(
        "func [T] identity(arr: Arr[T]): Arr[T] { arr }; identity([10i, 20i, 30i])",
        "10,20,30",
    );
}
#[test]
fn generic_nested_type_first_or_default() {
    // Generic with Arr[T] and default value — just returns the default.
    assert_run(
        "func [T] firstOrDefault(arr: Arr[T], fallback: T): T { fallback }; \
         firstOrDefault([10i, 20i], 99i)",
        "99",
    );
}

#[test]
fn generic_with_trait_variable() {
    // Trait variable access through T::bar syntax.
    assert_run(
        "trait Bar { bar: Self }; \
         impl Int: Bar { bar = 42i }; \
         func [T: Bar] get(x: T): T { T::bar }; \
         get(1i)",
        "42",
    );
}

#[test]
fn generic_full_apply_foo_with_bar() {
    // Full example from the docs: T::foo(x, T::bar) with two traits.
    assert_run(
        "trait Foo { foo: Func[Self, Self: Self] }; \
         trait Bar { bar: Self }; \
         impl Num: Foo { func foo(x: Num, y: Num): Num { x + y } }; \
         impl Num: Bar { bar = 0 }; \
         func [T: Foo + Bar] apply(x: T): T { T::foo(x, T::bar) }; \
         apply(1)",
        "1",
    );
}
