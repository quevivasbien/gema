use gema::{
    ast::AstArena,
    codegen::codegen,
    diagnostics::DiagnosticsBag,
    infer::infer_types,
    interner::Interner,
    lower::lower,
    modules::{build_module_graph_from_sources, codegen_modules, link_modules},
    parse::parse,
    resolve::resolve_names,
    scan::scan,
    source::{SourceMap, SourceText},
    types::TypeArena,
};

pub fn compile(source: &str) -> String {
    let src = SourceText::new("test.gema", source);
    let (tokens, mut diagnostics) = scan(&src, 0);
    assert!(!diagnostics.has_errors(), "scan errors {:?}", diagnostics);
    let mut arena = AstArena::new();
    let mut interner = Interner::new();
    let root = parse(&tokens, &mut arena, &mut interner, &mut diagnostics, 0);
    assert!(!diagnostics.has_errors(), "parse errors {:?}", diagnostics);
    let mut scope_tree = resolve_names(&arena, root, &mut interner, &mut diagnostics, 0);
    assert!(
        !diagnostics.has_errors(),
        "resolve errors {:?}",
        diagnostics
    );
    let mut type_arena = TypeArena::new();
    let _types = infer_types(
        &arena,
        &mut scope_tree,
        &mut type_arena,
        &interner,
        root,
        &mut diagnostics,
        0,
    );
    assert!(
        !diagnostics.has_errors(),
        "inference errors: {:?}",
        diagnostics
    );
    let hir = lower(&arena, root, &scope_tree, &mut interner);
    codegen(hir, &arena, &scope_tree, &type_arena, &mut interner)
}

#[derive(PartialEq)]
pub enum ErrorType {
    Scan,
    Parse,
    Resolve,
    Infer,
}

pub fn compile_expect_error(source: &str, error_type: ErrorType) {
    let src = SourceText::new("test.gema", source);
    let (tokens, mut diagnostics) = scan(&src, 0);
    if error_type == ErrorType::Scan {
        assert!(diagnostics.has_errors(), "expected scan error");
    }
    let mut arena = AstArena::new();
    let mut interner = Interner::new();
    let root = parse(&tokens, &mut arena, &mut interner, &mut diagnostics, 0);
    if error_type == ErrorType::Parse {
        assert!(diagnostics.has_errors(), "expected parse error");
    }
    let mut scope_tree = resolve_names(&arena, root, &mut interner, &mut diagnostics, 0);
    if error_type == ErrorType::Resolve {
        assert!(diagnostics.has_errors(), "expected resolve error");
    }
    let mut type_arena = TypeArena::new();
    let _types = infer_types(
        &arena,
        &mut scope_tree,
        &mut type_arena,
        &interner,
        root,
        &mut diagnostics,
        0,
    );
    if error_type == ErrorType::Infer {
        assert!(diagnostics.has_errors(), "expected inference error",);
    }
}

fn bun_available() -> bool {
    std::process::Command::new("bun")
        .arg("--version")
        .output()
        .is_ok()
}

pub fn assert_run(source: &str, expected: &str) {
    if !bun_available() {
        eprintln!("skipping runtime test — bun not available");
        return;
    }
    let js = compile(source);
    let program = format!("{}\nconsole.log(String(result));", js);
    let output = std::process::Command::new("bun")
        .arg("-e")
        .arg(&program)
        .output()
        .expect("bun execution failed");
    let stdout = String::from_utf8(output.stdout).unwrap().trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "JS:\n{js}\nstderr:\n{stderr}");
    assert_eq!(stdout, expected, "source: {source}\nJS:\n{js}");
}

pub fn compile_multi(files: &[(String, String)]) -> String {
    let mut arena = AstArena::new();
    let mut interner = Interner::new();
    let mut source_map = SourceMap::new();
    let mut diagnostics = DiagnosticsBag::new();

    let graph = match build_module_graph_from_sources(
        files,
        &mut arena,
        &mut interner,
        &mut source_map,
        &mut diagnostics,
    ) {
        Ok(g) => g,
        _ => panic!("graph build errors"),
    };
    assert!(
        !diagnostics.has_errors(),
        "Pre-link errors: {diagnostics:#?}"
    );

    let mut modules = link_modules(&graph, &arena, &mut interner, &mut diagnostics);
    assert!(!diagnostics.has_errors(), "Link errors: {diagnostics:#?}");

    let mut type_arena = TypeArena::new();
    codegen_modules(
        &graph,
        &mut modules,
        &arena,
        &mut interner,
        &mut type_arena,
        &mut diagnostics,
    )
}

pub fn assert_run_multi(files: &[(String, String)], expected: &str) {
    if !bun_available() {
        eprintln!("skipping runtime test — bun not available");
        return;
    }
    let output = compile_multi(files);
    let js = format!("{};\nconsole.log(String(result));", output.trim());
    let output = std::process::Command::new("bun")
        .arg("-e")
        .arg(&js)
        .output()
        .expect("bun execution failed");
    let stdout = String::from_utf8(output.stdout).unwrap().trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "JS:\n{js}\nstderr:\n{stderr}");
    assert_eq!(stdout, expected, "JS:\n{js}");
}

pub fn assert_compile_error(files: &[(String, String)]) {
    let mut arena = AstArena::new();
    let mut interner = Interner::new();
    let mut source_map = SourceMap::new();
    let mut diagnostics = DiagnosticsBag::new();
    let result = build_module_graph_from_sources(
        files,
        &mut arena,
        &mut interner,
        &mut source_map,
        &mut diagnostics,
    );
    assert!(result.is_err(), "Expected a compilation error but got Ok");
}
