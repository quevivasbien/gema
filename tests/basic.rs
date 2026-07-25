mod utils;

use utils::assert_run;

#[test]
fn int_lit() {
    assert_run("42i", "42");
}
#[test]
fn num_lit() {
    assert_run("3.14", "3.14");
}
#[test]
fn str_lit() {
    assert_run("\"hello\"", "hello");
}
#[test]
fn bool_true() {
    assert_run("true", "true");
}
#[test]
fn bool_false() {
    assert_run("false", "false");
}
#[test]
fn none() {
    assert_run("none", "null");
}
#[test]
fn binary_add() {
    assert_run("1i + 2i", "3");
}
#[test]
fn binary_mul() {
    assert_run("3 * 4", "12");
}
#[test]
fn comparison_eq() {
    assert_run("1i == 2i", "false");
}
#[test]
fn comparison_lt() {
    assert_run("1i < 2i", "true");
}
#[test]
fn variable() {
    assert_run("x = 42i; x", "42");
}
#[test]
fn block() {
    assert_run("{ 1i; 2i; 3i }", "3");
}
#[test]
fn if_else() {
    assert_run("if true { 1i } else { 2i }", "1");
}
#[test]
fn if_else_false() {
    assert_run("if false { 1i } else { 2i }", "2");
}
#[test]
fn for_loop_sum_num() {
    assert_run("mut s = 0; for x = 1..3 { s = s + x }; s", "6");
}
#[test]
fn for_loop_sum_int() {
    assert_run("mut s = 0i; for x = 1i..3i { s = s + x }; s", "6");
}
