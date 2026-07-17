/// Module graph and linking for multi-file compilation.
///
/// Each `use` directive loads a dependency module, resolves its symbols,
/// and imports them into the current scope.  Modules are compiled
/// independently and their JS output is concatenated.
use crate::ast::{AstArena, Expr, NodeId};
use crate::codegen;
use crate::diagnostics::{DiagnosticsBag, Severity};
use crate::hir::HirExpr;
use crate::infer::infer_types;
use crate::interner::Interner;
use crate::lower;
use crate::parse;
use crate::scan;
use crate::source::{SourceMap, SourceText, Span};
use crate::symbol::{ScopeTree, SymbolKind};
use crate::types::{TypeArena, TypeId};
use rustc_hash::FxHashMap;

/// A single compiled module.
pub struct Module {
    pub path: String,
    pub source: SourceText,
    pub arena: AstArena,
    pub interner: Interner,
    pub diagnostics: DiagnosticsBag,
    pub ast: NodeId,
    pub scope_tree: Option<ScopeTree>,
    pub type_arena: TypeArena,
    pub types: FxHashMap<NodeId, TypeId>,
    pub hir: Option<HirExpr>,
    pub resolved_imports: Vec<(String, Vec<String>)>,
    pub js_imports: Vec<(String, Vec<String>)>,
}

/// Compile a set of source files to JavaScript.
///
/// `files` is a list of `(path, source_text)` pairs.
/// `entry` is the path of the entry point.
pub fn compile(files: &[(String, String)], entry: &str) -> Result<String, DiagnosticsBag> {
    let modules = load_modules(files, entry)?;
    // Use a single shared TypeArena so TypeIds are valid across modules.
    let mut shared_type_arena = TypeArena::new();
    let modules = resolve_modules(modules);
    // Infer all modules — dependencies first, then importers.
    let modules = infer_modules(modules, &mut shared_type_arena);
    // Link: inject exported symbols (with cached types from shared arena).
    let modules = link_modules(modules);
    // Re-infer importers now that symbols from dependencies are visible.
    let modules = infer_modules(modules, &mut shared_type_arena);
    let modules = lower_modules(modules);
    let js = codegen_modules(modules);
    Ok(js)
}

fn load_modules(
    files: &[(String, String)],
    entry: &str,
) -> Result<Vec<Module>, DiagnosticsBag> {
    let mut modules: Vec<Module> = Vec::new();
    let mut source_map = SourceMap::new();

    // Load entry first, then recursively load dependencies.
    load_module(entry, files, &mut modules, &mut source_map)?;

    if modules.is_empty() {
        let mut bag = DiagnosticsBag::new();
        bag.error(0, Span::empty_at(0), format!("entry file '{}' not found", entry));
        return Err(bag);
    }

    Ok(modules)
}

fn load_module(
    path: &str,
    files: &[(String, String)],
    modules: &mut Vec<Module>,
    source_map: &mut SourceMap,
) -> Result<usize, DiagnosticsBag> {
    // Check if already loaded.
    if let Some(idx) = modules.iter().position(|m| m.path == path) {
        return Ok(idx);
    }

    // Find the source text.
    let source = files.iter().find(|(p, _)| p == path).map(|(_, s)| s);
    let source = match source {
        Some(s) => s,
        None => {
            let mut bag = DiagnosticsBag::new();
            bag.error(0, Span::empty_at(0), format!("module '{}' not found", path));
            return Err(bag);
        }
    };

    let idx = modules.len();
    let source_text = SourceText::new(path, source.as_str());
    let file_idx = source_map.add(source_text.clone());

    // Scan.
    let (tokens, diags) = scan::scan(&source_text, file_idx);

    // Parse.
    let mut arena = AstArena::new();
    let mut interner = Interner::new();
    for d in diags.into_vec() {
        if d.severity == Severity::Error {
            let mut bag = DiagnosticsBag::new();
            bag.push(d);
            return Err(bag);
        }
    }
    let mut diags = DiagnosticsBag::new();
    let ast = parse::parse(&tokens, &mut arena, &mut interner, &mut diags, file_idx);

    // Collect imports.
    let mut resolved_imports: Vec<(String, Vec<String>)> = Vec::new();
    let mut js_imports: Vec<(String, Vec<String>)> = Vec::new();
    collect_imports(&arena, &interner, ast, &mut resolved_imports, &mut js_imports);

    // Recursively load dependency modules.
    let mut dep_indices: Vec<usize> = Vec::new();
    for (dep_path, _) in &resolved_imports {
        match load_module(dep_path, files, modules, source_map) {
            Ok(dep_idx) => dep_indices.push(dep_idx),
            Err(e) => return Err(e),
        }
    }

    let module = Module {
        path: path.to_string(),
        source: source_text,
        arena,
        interner,
        diagnostics: diags,
        ast,
        scope_tree: None,
        type_arena: TypeArena::new(),
        types: FxHashMap::default(),
        hir: None,
        resolved_imports,
        js_imports,
    };

    modules.push(module);
    Ok(idx)
}

fn collect_imports(
    arena: &AstArena,
    interner: &Interner,
    node: NodeId,
    resolved_imports: &mut Vec<(String, Vec<String>)>,
    js_imports: &mut Vec<(String, Vec<String>)>,
) {
    match &arena[node] {
        Expr::Block(b) => {
            for &stmt in &b.stmts {
                collect_imports(arena, interner, stmt, resolved_imports, js_imports);
            }
        }
        Expr::Use(u) => {
            let symbols = u.symbols.as_ref().map(|v| {
                v.iter().map(|id| interner.lookup(*id).to_string()).collect()
            });
            resolved_imports.push((u.path.clone(), symbols.unwrap_or_default()));
        }
        Expr::UseJs(u) => {
            let names: Vec<String> = u.imports.iter().map(|_| String::new()).collect();
            js_imports.push((u.path.clone(), names));
        }
        _ => {}
    }
}

fn resolve_modules(mut modules: Vec<Module>) -> Vec<Module> {
    for m in &mut modules {
        if m.diagnostics.has_errors() {
            continue;
        }
        let (arena, ast, interner, diagnostics) = {
            (&m.arena, m.ast, &mut m.interner, &mut m.diagnostics)
        };
        let scope_tree = crate::resolve::resolve_names(
            arena, ast, interner, diagnostics, 0,
        );
        m.scope_tree = Some(scope_tree);
    }

    modules
}

fn link_modules(mut modules: Vec<Module>) -> Vec<Module> {
    for i in 0..modules.len() {
        link_module_imports(i, &mut modules);
    }
    modules
}

/// Inject exported symbols from dependencies into module `idx`'s scope tree.
fn link_module_imports(idx: usize, modules: &mut [Module]) {
    // Collect dependency paths and their requested symbol lists.
    // An empty symbol list means "import everything".
    let import_map: FxHashMap<String, Vec<String>> = modules[idx]
        .resolved_imports
        .iter()
        .map(|(path, syms)| (path.clone(), syms.clone()))
        .collect();

    let dep_indices: Vec<usize> = {
        let mut deps = Vec::new();
        for path in import_map.keys() {
            if let Some(i) = modules.iter().position(|m| m.path == *path)
                && i != idx
            {
                deps.push(i);
            }
        }
        deps
    };

    // Collect exports from each dependency.
    // For each exported function, extract the TypeNode function signature
    // from the dependency's AST and store it in cached_signature.
    #[allow(clippy::type_complexity)]
    let all_exports: Vec<Vec<(crate::interner::IdentId, SymbolKind, NodeId)>> = {
        let mut result = Vec::new();
        for &dep_idx in &dep_indices {
            let dep = &modules[dep_idx];
            let scope = match &dep.scope_tree {
                Some(s) => s,
                None => continue,
            };
            // Determine which symbols to import for this dependency.
            let requested = import_map.get(&dep.path);
            let import_all = requested
                .map(|syms| syms.is_empty())
                .unwrap_or(true);

            let exports: Vec<(crate::interner::IdentId, SymbolKind, NodeId)> = scope
                .symbols
                .iter()
                .filter_map(|(_, sym)| {
                    if let SymbolKind::Function {
                        is_generic,
                        param_count,
                        type_param_count,
                        ..
                    } = &sym.kind
                    {
                        // If a specific symbol list was given, skip unlisted functions.
                        if !import_all {
                            let name_str = dep.interner.lookup(sym.name);
                            let listed = requested.map(|syms| syms.iter().any(|s| s == name_str));
                            if listed != Some(true) {
                                return None;
                            }
                        }
                        // Extract the function's TypeNode signature from AST.
                        let sig = extract_func_signature(sym.def_node, &dep.arena);
                        Some((
                            sym.name,
                            SymbolKind::Function {
                                full_name: None,
                                is_generic: *is_generic,
                                param_count: *param_count,
                                type_param_count: *type_param_count,
                                cached_signature: sig,
                            },
                            sym.def_node,
                        ))
                    } else {
                        None
                    }
                })
                .collect();
            result.push(exports);
        }
        result
    };

    // Now mutate only the importer — no outstanding borrows on modules.
    let importer_scope = match &mut modules[idx].scope_tree {
        Some(s) => s,
        None => return,
    };
    for exports in &all_exports {
        for (name, kind, def_node) in exports {
            importer_scope.define(
                importer_scope.root_scope,
                *name,
                kind.clone(),
                *def_node,
            );
        }
    }
}

fn infer_modules(mut modules: Vec<Module>, shared_type_arena: &mut TypeArena) -> Vec<Module> {
    for m in &mut modules {
        if m.diagnostics.has_errors() {
            continue;
        }
        let scope_tree = m.scope_tree.as_mut().unwrap();
        let types = infer_types(
            &m.arena,
            scope_tree,
            shared_type_arena,
            &m.interner,
            m.ast,
            &mut m.diagnostics,
            0,
        );
        m.types = types;
    }
    modules
}

fn lower_modules(modules: Vec<Module>) -> Vec<Module> {
    modules
        .into_iter()
        .map(|mut m| {
            if m.diagnostics.has_errors() {
                return m;
            }
            let scope_tree = m.scope_tree.as_ref().unwrap();
            let hir = lower::lower(&m.arena, m.ast, scope_tree, &m.interner);
            m.hir = Some(hir);
            m
        })
        .collect()
}

/// Extract the TypeNode function signature from a function definition.
/// Returns `Func { params: [param_types], ret: return_type }` as a TypeNode.
fn extract_func_signature(def_node: NodeId, arena: &AstArena) -> Option<Box<crate::ast::TypeNode>> {
    match &arena[def_node] {
        crate::ast::Expr::FuncDef(f) => {
            let params: Vec<crate::ast::TypeNode> = f
                .params
                .iter()
                .map(|p| p.type_node.clone().unwrap_or(crate::ast::TypeNode::Void))
                .collect();
            let ret = f
                .return_type
                .clone()
                .unwrap_or(crate::ast::TypeNode::Void);
            Some(Box::new(crate::ast::TypeNode::Func { params, ret: Box::new(ret) }))
        }
        _ => None,
    }
}

fn codegen_modules(modules: Vec<Module>) -> String {
    let mut modules = modules;
    let mut stmts: Vec<String> = Vec::new();
    let entry_idx = modules.len() - 1; // entry is pushed last (deps first)

    for (idx, m) in modules.iter_mut().enumerate() {
        if let Some(ref hir) = m.hir {
            let scope_tree = m.scope_tree.as_ref().unwrap();
            // Only the entry module's last expression becomes the return value.
            let return_last = idx == entry_idx;
            let js = codegen::codegen_inner(
                hir.clone(),
                &m.arena,
                scope_tree,
                &m.type_arena,
                &mut m.interner,
                return_last,
            );
            stmts.push(js);
        }
    }

    // Wrap the entire compilation in a single IIFE.
    let mut out = String::new();
    out.push_str("(() => {\n");
    for stmt in &stmts {
        out.push_str(stmt);
        out.push('\n');
    }
    out.push_str("})();\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_ok(files: &[(String, String)], entry: &str) -> String {
        let result = compile(files, entry);
        match result {
            Ok(js) => js,
            Err(diags) => {
                let sm = SourceMap::new();
                panic!("compilation failed:\n{}", diags.format(&sm));
            }
        }
    }

    fn run_via_bun(js: &str) -> String {
        // Extract the inner IIFE expression and wrap in console.log.
        // The output has the form: (() => { ... })();
        let inner = js.trim();
        let wrapped = if inner.starts_with("(()") && inner.ends_with("})();") {
            format!("console.log(String({}));", &inner[..inner.len() - 1]) // drop trailing `;`
        } else {
            format!("console.log(String({}));", inner)
        };
        let output = std::process::Command::new("bun")
            .arg("-e")
            .arg(&wrapped)
            .output()
            .expect("bun not available");
        if !output.status.success() {
            panic!("bun error:\n{}\nJS:\n{}", String::from_utf8_lossy(&output.stderr), js);
        }
        String::from_utf8(output.stdout).unwrap().trim().to_string()
    }

    #[test]
    fn single_module() {
        let files = vec![("main.gema".into(), "42i".into())];
        let js = run_ok(&files, "main.gema");
        assert!(js.contains("42n"), "expected 42n in output: {js}");
    }

    #[test]
    fn cross_module_function_import() {
        let files = vec![
            ("math.gema".into(), "func add(x: Int, y: Int): Int { x + y }".into()),
            ("main.gema".into(), "use (add) from \"math.gema\"; add(1i, 2i)".into()),
        ];
        let js = run_ok(&files, "main.gema");
        let result = run_via_bun(&js);
        assert_eq!(result, "3", "expected 3 from bun, got '{result}'\nJS:\n{js}");
    }
}
