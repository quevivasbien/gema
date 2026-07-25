mod utils;
use utils::assert_run;

// ── Indexed access ──

#[test]
fn run_indexed_access_array_lit() {
    assert_run("[1i, 2i, 3i](0i)", "1");
}
#[test]
fn run_indexed_access_variable() {
    assert_run("a = [1i, 2i, 3i]; a(0i)", "1");
}
#[test]
fn run_indexed_access_array_lit_num() {
    assert_run("[1,2,3](1)", "2");
}
#[test]
fn run_indexed_access_variable_num() {
    assert_run("a = [1,2,3]; a(1)", "2");
}
#[test]
fn run_indexed_access_maybe_type() {
    // Indexed access returns Maybe(T). Binding to a Maybe variable is valid.
    assert_run("x: Maybe[Int] = [1i,2i,3i](0i); x", "1");
}
#[test]
fn run_indexed_access_last_element() {
    assert_run("[0i, 5i, 10i](2)", "10");
}
#[test]
fn run_indexed_access_mut_array() {
    // MutArr typed variable indexing
    assert_run("mut a = [1i,2i,3i]; a(1i)", "2");
}
#[test]
fn run_indexed_access_str() {
    assert_run("\"hello\"(0i)", "h");
}
#[test]
fn run_indexed_access_variable_str() {
    assert_run("s = \"hello\"; s(1)", "e");
}
#[test]
fn run_indexed_access_out_of_bounds() {
    assert_run("a = [1, 2, 3]; a(3)", "null");
}
#[test]
fn run_indexed_access_unwrap_in_bounds() {
    assert_run("a = [1, 2, 3]; unwrap(0, a(0))", "1");
}
#[test]
fn run_indexed_access_unwrap_out_of_bounds() {
    assert_run("a = [1, 2, 3]; unwrap(0, a(3))", "0");
}
