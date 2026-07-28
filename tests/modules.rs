mod utils;

use utils::{assert_compile_error, assert_run_multi};

#[test]
fn basic_module_import() {
    assert_run_multi(
        &[
            ("main.gema".into(), "use \"math.gema\"\nadd(3, 4)".into()),
            (
                "math.gema".into(),
                "func add(a: Num, b: Num): Num { a + b }".into(),
            ),
        ],
        "7",
    );
}

#[test]
fn selective_import() {
    assert_run_multi(
        &[
            (
                "main.gema".into(),
                "use (add) from \"math.gema\"\nadd(1, 2)".into(),
            ),
            (
                "math.gema".into(),
                "func add(a: Num, b: Num): Num { a + b }\nfunc mul(a: Num, b: Num): Num { a * b }"
                    .into(),
            ),
        ],
        "3",
    );
}
#[test]
fn chained_modules() {
    assert_run_multi(&[
        (
            "main.gema".into(),
            "use \"math.gema\"\nadd_double(3, 4)".into(),
        ),
        (
            "math.gema".into(),
            "use \"utils.gema\"\nfunc add_double(a: Num, b: Num): Num { double(a) + double(b) }"
                .into(),
        ),
        (
            "utils.gema".into(),
            "func double(x: Num): Num { x * 2 }".into(),
        ),
    ], "14");
}

#[test]
fn circular_dependency() {
    assert_compile_error(&[
        ("main.gema".into(), "use \"a.gema\"".into()),
        ("a.gema".into(), "use \"b.gema\"".into()),
        ("b.gema".into(), "use \"a.gema\"".into()),
    ]);
}

#[test]
fn missing_module() {
    assert_compile_error(&[("main.gema".into(), "use \"nonexistent.gema\"".into())]);
}

#[test]
fn single_file_no_use() {
    assert_run_multi(&[("main.gema".into(), "42".into())], "42");
}

#[test]
fn variable_import() {
    assert_run_multi(
        &[
            ("main.gema".into(), "use \"config.gema\"\nconfig".into()),
            ("config.gema".into(), "mut config: Num = 42".into()),
        ],
        "42",
    );
}

#[test]
fn cross_module_function_call() {
    assert_run_multi(
        &[
            ("main.gema".into(), "use \"math.gema\"\nfoo(3)".into()),
            ("math.gema".into(), "func foo(x: Num): Num { x + 1 }".into()),
        ],
        "4",
    );
}

#[test]
fn imported_overloaded_functions() {
    assert_run_multi(
        &[
            ("main.gema".into(), "use \"lib.gema\"\nid(42)".into()),
            (
                "lib.gema".into(),
                "func id(x: Num): Num { x }\nfunc id(x: Str): Str { x }".into(),
            ),
        ],
        "42",
    );
}

#[test]
fn typed_import_selects_correct_overload() {
    assert_run_multi(
        &[
            (
                "main.gema".into(),
                "use (foo[Num]) from \"lib.gema\"\nfoo(3.0)".into(),
            ),
            (
                "lib.gema".into(),
                "func foo(x: Num): Num { x + 1 }\nfunc foo(x: Str): Str { x }".into(),
            ),
        ],
        "4",
    );
}

#[test]
fn forked_dependency_graph() {
    assert_run_multi(
        &[
            (
                "main.gema".into(),
                "use (foo[Num]) from \"module1.gema\"\n\
                 use (bar[Num]) from \"module2.gema\"\n\
                 [foo(1), bar(1)]"
                    .into(),
            ),
            (
                "module1.gema".into(),
                "use (bar[Num]) from \"module2.gema\"\n\
                 func foo(x: Num) { bar(x + 1) }"
                    .into(),
            ),
            ("module2.gema".into(), "func bar(x: Num) { x }".into()),
        ],
        "2,1",
    )
}
