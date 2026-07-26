mod utils;

use utils::{ErrorType, assert_run, compile_expect_error};

#[test]
fn basic_function() {
    assert_run("func foo(x: Num) { x } foo(1)", "1");
    assert_run("func foo(x: Num): Num { x } foo(1)", "1");
}
#[test]
fn incompatible_type_signature() {
    compile_expect_error("func foo(x: Num) { x } foo(\"bar\")", ErrorType::Infer);
}
#[test]
fn incompatible_return_type() {
    compile_expect_error("func foo(x: Num): Str { x } foo(1)", ErrorType::Infer);
}
#[test]
fn function_call_type_annotation() {
    assert_run("func foo(x: Num) { x } foo[Num](1)", "1");
}
#[test]
fn wrong_function_call_type_annotation() {
    compile_expect_error("func foo(x: Num) { x } foo[Str](1)", ErrorType::Infer);
}
#[test]
fn capture_named_function_in_var() {
    assert_run("func foo(x: Num) { x } f = foo[Num]; f(1)", "1");
    assert_run(
        "func foo(x: Num, y: Num) { x + y } f = foo[Num, Num]; f(1, 2)",
        "3",
    );
}
#[test]
fn capture_named_function_in_var_disambiguate_overload() {
    assert_run(
        "func foo(x: Num, y: Num) { x + y } func foo(x: Num) { x } f = foo[Num, Num]; f(1, 2)",
        "3",
    );
}
#[test]
fn capture_named_function_in_var_no_matching_overload() {
    compile_expect_error(
        "func foo(x: Num) { x } f = foo[Int]; f(1i)",
        ErrorType::Infer,
    );
}
