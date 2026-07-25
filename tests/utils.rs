use gema::{
    ast::AstArena, codegen::codegen, diagnostics::DiagnosticsBag, infer::infer_types,
    interner::Interner, lower::lower, parse::parse, resolve::resolve_names, scan::scan,
    source::SourceText, types::TypeArena,
};

pub fn compile(source: &str) -> String {
    let src = SourceText::new("test.gema", source);
    let (tokens, sd) = scan(&src, 0);
    assert!(!sd.has_errors(), "scan errors");
    let mut arena = AstArena::new();
    let mut interner = Interner::new();
    let mut diagnostics = DiagnosticsBag::new();
    for d in sd.into_vec() {
        diagnostics.push(d);
    }
    let root = parse(&tokens, &mut arena, &mut interner, &mut diagnostics, 0);
    assert!(!diagnostics.has_errors(), "parse errors");
    let mut scope_tree = resolve_names(&arena, root, &mut interner, &mut diagnostics, 0);
    assert!(!diagnostics.has_errors(), "resolve errors");
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
