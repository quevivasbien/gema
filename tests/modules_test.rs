/// Integration tests for the module system.
use gema::{
    ast::AstArena,
    diagnostics::DiagnosticsBag,
    interner::Interner,
    modules::{self},
    source::SourceMap,
    types::TypeArena,
};

fn compile_and_eval(files: &[(String, String)]) -> Result<String, String> {
    let mut arena = AstArena::new();
    let mut interner = Interner::new();
    let mut source_map = SourceMap::new();
    let mut diagnostics = DiagnosticsBag::new();

    let graph = modules::build_module_graph_from_sources(
        files, &mut arena, &mut interner, &mut source_map, &mut diagnostics,
    )
    .map_err(|_| format!("Graph build error: {:#?}", diagnostics))?;
    if diagnostics.has_errors() {
        return Err(format!("Pre-link diagnostics: {:#?}", diagnostics));
    }

    let modules = modules::link_modules(&graph, &arena, &mut interner, &mut diagnostics);
    if diagnostics.has_errors() {
        return Err(format!("Link error: {:#?}", diagnostics));
    }

    let mut type_arena = TypeArena::new();
    let output = modules::codegen_modules(&graph, &modules, &arena, &mut interner, &mut type_arena);

    let wrapped = format!("console.log(String({}));", output.trim());
    let result = std::process::Command::new("bun")
        .arg("-e").arg(&wrapped).output()
        .map_err(|e| format!("Failed to run bun: {}", e))?;

    if !result.status.success() {
        return Err(format!("bun error: {}", String::from_utf8_lossy(&result.stderr)));
    }

    Ok(String::from_utf8_lossy(&result.stdout).trim().to_string())
}

fn assert_compile_error(files: &[(String, String)]) {
    let mut arena = AstArena::new();
    let mut interner = Interner::new();
    let mut source_map = SourceMap::new();
    let mut diagnostics = DiagnosticsBag::new();
    let result = modules::build_module_graph_from_sources(
        files, &mut arena, &mut interner, &mut source_map, &mut diagnostics,
    );
    assert!(result.is_err(), "Expected a compilation error but got Ok");
}

#[test]
fn test_basic_module_import() {
    let result = compile_and_eval(&[
        ("main.gema".into(), "use \"math.gema\"\nadd(3, 4)".into()),
        ("math.gema".into(), "func add(a: Num, b: Num): Num { a + b }".into()),
    ]);
    assert_eq!(result.as_deref(), Ok("7"));
}

#[test]
fn test_selective_import() {
    let result = compile_and_eval(&[
        ("main.gema".into(), "use (add) from \"math.gema\"\nadd(1, 2)".into()),
        ("math.gema".into(), "func add(a: Num, b: Num): Num { a + b }\nfunc mul(a: Num, b: Num): Num { a * b }".into()),
    ]);
    assert_eq!(result.as_deref(), Ok("3"));
}
#[test]
fn test_chained_modules() {
    let result = compile_and_eval(&[
        ("main.gema".into(), "use \"math.gema\"\nadd_double(3, 4)".into()),
        ("math.gema".into(), "use \"utils.gema\"\nfunc add_double(a: Num, b: Num): Num { double(a) + double(b) }".into()),
        ("utils.gema".into(), "func double(x: Num): Num { x * 2 }".into()),
    ]);
    assert_eq!(result.as_deref(), Ok("14"));
}

#[test]
fn test_circular_dependency() {
    assert_compile_error(&[
        ("main.gema".into(), "use \"a.gema\"".into()),
        ("a.gema".into(), "use \"b.gema\"".into()),
        ("b.gema".into(), "use \"a.gema\"".into()),
    ]);
}

#[test]
fn test_missing_module() {
    assert_compile_error(&[
        ("main.gema".into(), "use \"nonexistent.gema\"".into()),
    ]);
}

#[test]
fn test_single_file_no_use() {
    let result = compile_and_eval(&[
        ("main.gema".into(), "42".into()),
    ]);
    assert_eq!(result.as_deref(), Ok("42"));
}

#[test]
fn test_variable_import() {
    let result = compile_and_eval(&[
        ("main.gema".into(), "use \"config.gema\"\nconfig".into()),
        ("config.gema".into(), "mut config: Num = 42".into()),
    ]);
    assert_eq!(result.as_deref(), Ok("42"));
}

#[test]
fn test_cross_module_function_call() {
    let result = compile_and_eval(&[
        ("main.gema".into(), "use \"math.gema\"\nfoo(3.0)".into()),
        ("math.gema".into(), "func foo(x: Num): Num { x + 1 }".into()),
    ]);
    assert_eq!(result.as_deref(), Ok("4"));
}

#[test]
fn test_imported_overloaded_functions() {
    let result = compile_and_eval(&[
        ("main.gema".into(), "use \"lib.gema\"\nid(42)".into()),
        ("lib.gema".into(), "func id(x: Num): Num { x }\nfunc id(x: Str): Str { x }".into()),
    ]);
    assert_eq!(result.as_deref(), Ok("42"));
}
