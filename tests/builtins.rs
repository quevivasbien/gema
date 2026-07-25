mod utils;

use utils::assert_run;

// ── Builtin calls ──

#[test]
fn builtin_to_str() {
    assert_run("toStr(42i)", "42");
}
#[test]
fn builtin_isnone_some() {
    assert_run("isnone(some(1i))", "false");
}
#[test]
fn builtin_to_int() {
    assert_run("toInt(\"42\")", "42");
}
#[test]
fn builtin_unwrap_simple() {
    assert_run("unwrap(0, some(1))", "1");
    assert_run("unwrap(0, none)", "0");
}
// TODO: Need much more comprehensive tests of builtins.

// ── Builtin shadowing ──

#[test]
fn builtin_shadowed_by_named_func() {
    // User-defined function shadows the builtin `toStr`.
    assert_run("func toStr(x: Num) { \"hi\" }; toStr(0)", "hi");
}
#[test]
fn builtin_shadowed_by_variable() {
    // User variable shadows the builtin `length`.
    assert_run("length = \\x -> 0; length([1,2,3])", "0");
}
