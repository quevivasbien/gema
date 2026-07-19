/// Module system for Gema — discovers, parses, links, and resolves
/// dependencies between module files.
///
/// The module system runs **after parsing and before name resolution**,
/// injecting dependency exports into each module's scope tree so the
/// existing pipeline works unchanged.
use std::collections::VecDeque;
use std::fs;
use std::path::Path;
use rustc_hash::FxHashMap;
use rustc_hash::FxHashSet;

use crate::ast::*;
use crate::codegen::{codegen_inner, FnNameTable};
use crate::diagnostics::DiagnosticsBag;
use crate::infer::infer_types;
use crate::interner::{IdentId, Interner};
use crate::lower::lower;
use crate::parse::parse;
use crate::resolve::resolve_names_in_context;
use crate::scan::scan;
use crate::source::{SourceMap, SourceText, Span};
use crate::symbol::{ScopeTree, SymbolId, SymbolKind};
use crate::types::TypeArena;

// ---------------------------------------------------------------------------
// Module graph types
// ---------------------------------------------------------------------------

/// Index into a `ModuleGraph`'s `modules` vector.
pub type ModuleId = usize;

/// A single module in the dependency graph.
#[derive(Clone, Debug)]
pub struct Module {
    /// Index in the `SourceMap` for diagnostics and source lookups.
    pub file_idx: usize,
    /// Relative file path (e.g. "math.gema").
    pub path: String,
    /// Root `Block` node in the shared `AstArena`.
    pub root: NodeId,
    /// Indices of dependency modules (deduced from `Use` nodes),
    /// resolved after graph construction.
    pub dependency_ids: Vec<ModuleId>,
    /// Raw dependency paths from `Use` nodes, used during graph
    /// construction and then resolved to `dependency_ids`.
    pub dependency_paths: Vec<String>,
    /// Scope tree after linking and resolution, or `None` before linking.
    pub scope_tree: Option<ScopeTree>,
    /// Exported symbol names (all top-level definitions).
    pub exports: Vec<IdentId>,
}

/// The complete dependency graph for a program.
#[derive(Clone, Debug)]
pub struct ModuleGraph {
    pub modules: Vec<Module>,
    /// Index of the entry module.
    pub entry: ModuleId,
    /// Topological order of module indices (dependencies first).
    pub topo_order: Vec<ModuleId>,
}

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

/// Starting from `entry_path`, discover and parse all transitive module
/// dependencies from the filesystem. Returns the module graph (shared arena).
///
/// All modules share one `AstArena` and `Interner`. Each gets a unique
/// `file_idx` in the `SourceMap`.
#[allow(clippy::result_unit_err)]
pub fn build_module_graph(
    entry_path: &str,
    arena: &mut AstArena,
    interner: &mut Interner,
    source_map: &mut SourceMap,
    diagnostics: &mut DiagnosticsBag,
) -> Result<ModuleGraph, ()> {
    let source = match fs::read_to_string(entry_path) {
        Ok(s) => s,
        Err(e) => {
            diagnostics.error(
                0,
                Span::new(0, 0),
                format!("cannot read entry file '{}': {}", entry_path, e),
            );
            return Err(());
        }
    };

    let mut graph = ModuleGraph {
        modules: Vec::new(),
        entry: 0,
        topo_order: Vec::new(),
    };

    // Path -> ModuleId cache for dedup
    let mut path_to_idx: std::collections::HashMap<String, ModuleId> = std::collections::HashMap::new();

    // BFS to discover all modules
    let mut queue: VecDeque<(String, String)> = VecDeque::new();
    // queue entry format: (importing_file_path, target_path_from_use)

    // Process the entry file
    let entry_name = entry_path.to_string();
    match process_source_file(
        &entry_name, &source, arena, interner, source_map, diagnostics,
    ) {
        Some(module) => {
            let idx = graph.modules.len();
            let path_canon = canonicalize_path(&entry_name);
            path_to_idx.insert(path_canon.clone(), idx);
            // Queue this module's unresolved dependencies
            for dep_path in &module.dependency_paths {
                let resolved = resolve_path(&entry_name, dep_path);
                if !path_to_idx.contains_key(&canonicalize_path(&resolved)) {
                    queue.push_back((entry_name.clone(), dep_path.clone()));
                }
            }
            graph.modules.push(module);
        }
        None => return Err(()),
    }

    // BFS: process queued dependencies
    while let Some((importing_path, target_path)) = queue.pop_front() {
        let resolved_path = resolve_path(&importing_path, &target_path);
        let canonical = canonicalize_path(&resolved_path);

        if path_to_idx.contains_key(&canonical) {
            continue;
        }

        let dep_source = match fs::read_to_string(&resolved_path) {
            Ok(s) => s,
            Err(_) => {
                diagnostics.error(
                    graph.modules[graph.modules.len() - 1].file_idx,
                    Span::new(0, 0),
                    format!("module not found: '{}'", resolved_path),
                );
                return Err(());
            }
        };

        match process_source_file(
            &resolved_path, &dep_source, arena, interner, source_map, diagnostics,
        ) {
            Some(module) => {
                let idx = graph.modules.len();
                path_to_idx.insert(canonical, idx);
                for dep_path in &module.dependency_paths {
                    let resolved_dep = resolve_path(&resolved_path, dep_path);
                    if !path_to_idx.contains_key(&canonicalize_path(&resolved_dep)) {
                        queue.push_back((resolved_path.clone(), dep_path.clone()));
                    }
                }
                graph.modules.push(module);
            }
            None => return Err(()),
        }
    }

    // Resolve dependency_paths to dependency_ids for every module
    for i in 0..graph.modules.len() {
        let importing_path = &graph.modules[i].path;
        let mut any_unresolved = false;
        let resolved: Vec<ModuleId> = graph.modules[i]
            .dependency_paths
            .iter()
            .filter_map(|dep_path| {
                let resolved_dep = resolve_path(importing_path, dep_path);
                let canonical = canonicalize_path(&resolved_dep);
                match path_to_idx.get(&canonical).copied() {
                    Some(id) => Some(id),
                    None => {
                        if !any_unresolved {
                            any_unresolved = true;
                            diagnostics.error(
                                graph.modules[i].file_idx,
                                Span::new(0, 0),
                                format!("module not found: '{}' (imported by '{}')",
                                    dep_path, importing_path),
                            );
                        }
                        None
                    }
                }
            })
            .collect();
        graph.modules[i].dependency_ids = resolved;
    }
    if diagnostics.has_errors() {
        return Err(());
    }

    // Detect cycles via DFS coloring
    detect_cycles(&graph, diagnostics)?;

    // Topological sort
    graph.topo_order = topological_sort(&graph);

    Ok(graph)
}

/// Like `build_module_graph` but accepts in-memory source text (for tests).
/// `files` is `[(path, source)]` — the entry is the first entry.
#[allow(clippy::result_unit_err)]
pub fn build_module_graph_from_sources(
    files: &[(String, String)],
    arena: &mut AstArena,
    interner: &mut Interner,
    source_map: &mut SourceMap,
    diagnostics: &mut DiagnosticsBag,
) -> Result<ModuleGraph, ()> {
    if files.is_empty() {
        diagnostics.error(0, Span::new(0, 0), "no files provided");
        return Err(());
    }

    let mut graph = ModuleGraph {
        modules: Vec::new(),
        entry: 0,
        topo_order: Vec::new(),
    };

    // Path -> ModuleId cache
    let mut path_to_idx: std::collections::HashMap<String, ModuleId> = std::collections::HashMap::new();

    // Process all provided files (first is the entry)
    for (path, source) in files {
        let canonical = canonicalize_path(path);
        if path_to_idx.contains_key(&canonical) {
            continue;
        }

        match process_source_file(
            path, source, arena, interner, source_map, diagnostics,
        ) {
            Some(module) => {
                let idx = graph.modules.len();
                path_to_idx.insert(canonical, idx);
                graph.modules.push(module);
            }
            None => return Err(()),
        }
    }

    // Resolve dependency_paths to dependency_ids
    for i in 0..graph.modules.len() {
        let importing_path = &graph.modules[i].path;
        let mut any_unresolved = false;
        let resolved: Vec<ModuleId> = graph.modules[i]
            .dependency_paths
            .iter()
            .filter_map(|dep_path| {
                let resolved_dep = resolve_path(importing_path, dep_path);
                let canonical = canonicalize_path(&resolved_dep);
                match path_to_idx.get(&canonical).copied() {
                    Some(id) => Some(id),
                    None => {
                        if !any_unresolved {
                            any_unresolved = true;
                            diagnostics.error(
                                graph.modules[i].file_idx,
                                Span::new(0, 0),
                                format!("module not found: '{}' (imported by '{}')",
                                    dep_path, importing_path),
                            );
                        }
                        None
                    }
                }
            })
            .collect();
        graph.modules[i].dependency_ids = resolved;
    }
    if diagnostics.has_errors() {
        return Err(());
    }

    // Detect cycles
    detect_cycles(&graph, diagnostics)?;

    // Topological sort
    graph.topo_order = topological_sort(&graph);

    Ok(graph)
}
// ---------------------------------------------------------------------------
// Linking pass
// ---------------------------------------------------------------------------

/// For each module in topological order, build its scope tree with imports
/// injected from dependencies. Returns the module list with scope trees
/// populated.
#[allow(clippy::collapsible_if)]
pub fn link_modules(
    graph: &ModuleGraph,
    arena: &AstArena,
    interner: &mut Interner,
    diagnostics: &mut DiagnosticsBag,
) -> Vec<Module> {
    let mut modules = graph.modules.clone();

    for &module_idx in &graph.topo_order {
        let mut scope_tree = ScopeTree::new();
        let deps = modules[module_idx].dependency_ids.clone();

        // Inject imported symbols from dependencies
        for &dep_idx in &deps {
            let dep_scope_tree = match &modules[dep_idx].scope_tree {
                Some(st) => st,
                None => continue,
            };

            let dep_exports = modules[dep_idx].exports.clone();
            let dep_file_idx = modules[dep_idx].file_idx;

            for &export_name in &dep_exports {
                // Search ALL scopes of the dependency for the exported name,
                // since top-level definitions are in the block's child scope.
                let dep_sym_ids: Vec<SymbolId> = dep_scope_tree
                    .scopes
                    .iter()
                    .flat_map(|(_, scope)| {
                        scope
                            .symbols
                            .get(&export_name)
                            .into_iter()
                            .flat_map(|ids| ids.iter().copied())
                    })
                    .collect();
                if dep_sym_ids.is_empty() {
                    continue;
                }

                // Check for collision in current module's root scope
                let has_existing = scope_tree
                    .scopes[scope_tree.root_scope]
                    .symbols
                    .get(&export_name)
                    .is_some_and(|ids| !ids.is_empty());

                if has_existing {
                    let existing_ids = &scope_tree.scopes[scope_tree.root_scope]
                        .symbols[&export_name];
                    let first = &scope_tree.symbols[existing_ids[0]];
                    let first_is_func = matches!(&first.kind, SymbolKind::Function { .. });
                    let first_is_tm = matches!(&first.kind, SymbolKind::TraitMethod { .. });

                    let dep_sym = &dep_scope_tree.symbols[dep_sym_ids[0]];
                    let dep_is_func = matches!(&dep_sym.kind, SymbolKind::Function { .. });
                    let dep_is_tm = matches!(&dep_sym.kind, SymbolKind::TraitMethod { .. });

                    if (first_is_func && dep_is_func) || (first_is_tm && dep_is_tm) {
                        // Overloading allowed — symbols will be added below
                    } else {
                        diagnostics.error(
                            modules[module_idx].file_idx,
                            Span::new(0, 0),
                            format!(
                                "name '{}' is exported by both '{}' and '{}'",
                                interner.lookup(export_name),
                                modules[dep_idx].path,
                                find_other_export(&modules, module_idx, export_name, dep_idx),
                            ),
                        );
                        continue;
                    }
                }

                // Copy each exported symbol into the current module's root scope
                for &dep_sym_id in &dep_sym_ids {
                    let dep_sym = &dep_scope_tree.symbols[dep_sym_id];
                    let mut sym = dep_sym.clone();
                    sym.source_module = Some(dep_file_idx);

                    // For imported functions, extract the signature and type params
                    // from the FuncDef AST node so inference and monomorphization
                    // can use them without accessing the dep's scope tree.
                    if let SymbolKind::Function { cached_signature, cached_type_params, .. } = &mut sym.kind {
                        if let Expr::FuncDef(func_def) = &arena[dep_sym.def_node] {
                            let param_types: Vec<TypeNode> = func_def
                                .params
                                .iter()
                                .filter_map(|p| p.type_node.clone())
                                .collect();
                            *cached_signature = Some(Box::new(TypeNode::Func {
                                params: param_types,
                                ret: Box::new(
                                    func_def.return_type.clone().unwrap_or(TypeNode::Void),
                                ),
                            }));
                            *cached_type_params = Some(func_def.type_params.clone());
                        }
                    }

                    let sid = scope_tree.symbols.alloc(sym);
                    scope_tree.scopes[scope_tree.root_scope]
                        .symbols
                        .entry(export_name)
                        .or_default()
                        .push(sid);
                }
            }
        }

        // Handle selective imports: check Use nodes for symbol filtering
        let module_node = &arena[modules[module_idx].root];
        if let Expr::Block(block) = module_node {
            for &stmt in &block.stmts {
                if let Expr::Use(use_node) = &arena[stmt] {
                    if let Some(symbols) = &use_node.symbols {
                        // Selective import: only keep symbols in the list
                        let allowed: FxHashSet<IdentId> = symbols.iter().copied().collect();
                        let current_keys: Vec<IdentId> = scope_tree
                            .scopes[scope_tree.root_scope]
                            .symbols
                            .keys()
                            .copied()
                            .collect();
                        for name in &current_keys {
                            if !allowed.contains(name) {
                                scope_tree
                                    .scopes[scope_tree.root_scope]
                                    .symbols
                                    .remove(name);
                            }
                        }
                    }
                }
            }
        }

        // Run name resolution with the pre-populated scope tree
        let mut resolved_scope = resolve_names_in_context(
            arena,
            modules[module_idx].root,
            interner,
            diagnostics,
            modules[module_idx].file_idx,
            scope_tree,
        );

        // Move imported symbols from root scope into the block's child scope
        // for correct function overloading (lookup_functions stops at first scope).
        if let Some(&block_scope) = resolved_scope.scopes[resolved_scope.root_scope]
            .children
            .first()
        {
            // Get imported symbols from root scope
            let root_syms = resolved_scope.scopes[resolved_scope.root_scope]
                .symbols
                .clone();
            for (name, ids) in root_syms {
                let mut imported_ids: Vec<SymbolId> = Vec::new();
                for &sid in &ids {
                    if resolved_scope.symbols[sid].source_module.is_some() {
                        imported_ids.push(sid);
                    }
                }
                if !imported_ids.is_empty() {
                    // Add to block scope
                    resolved_scope.scopes[block_scope]
                        .symbols
                        .entry(name)
                        .or_default()
                        .extend(imported_ids);
                    // Remove from root scope
                    resolved_scope.scopes[resolved_scope.root_scope]
                        .symbols
                        .entry(name)
                        .or_default()
                        .retain(|&sid| resolved_scope.symbols[sid].source_module.is_none());
                }
            }
        }

        // Collect exports (symbols defined in this module, not imported).
        // Only include top-level definitions — symbols in scopes whose
        // parent is the root scope (or the root scope itself when imports
        // haven't been moved yet). This excludes function parameters.
        let mut export_set = FxHashSet::default();
        for (sid, scope) in &resolved_scope.scopes {
            let is_top_level = sid == resolved_scope.root_scope
                || scope.parent == Some(resolved_scope.root_scope);
            if !is_top_level {
                continue;
            }
            for (name, ids) in &scope.symbols {
                for &sid in ids {
                    if resolved_scope.symbols[sid].source_module.is_none() {
                        export_set.insert(*name);
                    }
                }
            }
        }

        modules[module_idx].scope_tree = Some(resolved_scope);
        modules[module_idx].exports = export_set.into_iter().collect();
    }

    modules
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Resolve a `use` target path relative to the importing file's directory.
fn resolve_path(importing_path: &str, target: &str) -> String {
    let parent = Path::new(importing_path).parent();
    match parent {
        Some(dir) => dir.join(target).to_string_lossy().to_string(),
        None => target.to_string(),
    }
}

/// Normalize a path for dedup comparisons.
fn canonicalize_path(path: &str) -> String {
    Path::new(path)
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join("/")
}

/// Topological sort using Kahn's algorithm.
fn topological_sort(graph: &ModuleGraph) -> Vec<ModuleId> {
    let n = graph.modules.len();
    let mut in_degree = vec![0; n];

    // in_degree[i] = number of prerequisites for module i
    for (i, module) in graph.modules.iter().enumerate() {
        in_degree[i] = module.dependency_ids.len();
    }

    // Build reverse adjacency: for each module, which modules depend on it?
    // dependents[dep] = vec of modules that list dep as a dependency
    let mut dependents: Vec<Vec<ModuleId>> = vec![Vec::new(); n];
    for (i, module) in graph.modules.iter().enumerate() {
        for &dep in &module.dependency_ids {
            dependents[dep].push(i);
        }
    }

    let mut queue: VecDeque<ModuleId> = in_degree
        .iter()
        .enumerate()
        .filter(|&(_, deg)| *deg == 0)
        .map(|(i, _)| i)
        .collect();

    let mut result = Vec::with_capacity(n);
    while let Some(node) = queue.pop_front() {
        result.push(node);
        for &dependent in &dependents[node] {
            in_degree[dependent] -= 1;
            if in_degree[dependent] == 0 {
                queue.push_back(dependent);
            }
        }
    }

    result
}

/// Scan, parse, and collect dependencies for a single source file.
/// Returns a `Module` with `dependency_paths` populated but with
/// `dependency_ids` empty (resolved later).
fn process_source_file(
    path: &str,
    source: &str,
    arena: &mut AstArena,
    interner: &mut Interner,
    source_map: &mut SourceMap,
    diagnostics: &mut DiagnosticsBag,
) -> Option<Module> {
    let file_idx = source_map.add(SourceText::new(path, source));
    let src = SourceText::new(path, source);
    let (tokens, sd) = scan(&src, file_idx);
    for d in sd.into_vec() {
        diagnostics.push(d);
    }
    if diagnostics.has_errors() {
        return None;
    }
    let root = parse(&tokens, arena, interner, diagnostics, file_idx);
    if diagnostics.has_errors() {
        return None;
    }

    let dependency_paths = collect_dependency_paths(arena, root);

    Some(Module {
        file_idx,
        path: path.to_string(),
        root,
        dependency_ids: Vec::new(),
        dependency_paths,
        scope_tree: None,
        exports: Vec::new(),
    })
}

/// Walk the top-level statements of a Block and collect all `Use` node paths.
fn collect_dependency_paths(arena: &AstArena, root: NodeId) -> Vec<String> {
    let mut paths = Vec::new();
    if let Expr::Block(block) = &arena[root] {
        for stmt in &block.stmts {
            match &arena[*stmt] {
                Expr::Use(u) => {
                    paths.push(u.path.clone());
                }
                Expr::UseJs(ujs) => {
                    // JS interop — emit a warning later, but still record the path
                    paths.push(ujs.path.clone());
                }
                _ => {}
            }
        }
    }
    paths
}

/// DFS cycle detection. Returns `Err(())` if a cycle is found.
#[allow(clippy::result_unit_err, clippy::collapsible_if)]
fn detect_cycles(graph: &ModuleGraph, diagnostics: &mut DiagnosticsBag) -> Result<(), ()> {
    let n = graph.modules.len();
    let mut color = vec![0u8; n]; // 0=white, 1=gray, 2=black

    fn dfs(
        node: ModuleId,
        graph: &ModuleGraph,
        color: &mut [u8],
        path: &mut Vec<ModuleId>,
    ) -> Option<Vec<ModuleId>> {
        color[node] = 1;
        path.push(node);
        for &dep in &graph.modules[node].dependency_ids {
            if color[dep] == 1 {
                let cycle_start = path.iter().position(|&x| x == dep).unwrap_or(0);
                let cycle: Vec<ModuleId> = path[cycle_start..].to_vec();
                return Some(cycle);
            }
            if color[dep] == 0 {
                if let Some(cycle) = dfs(dep, graph, color, path) {
                    return Some(cycle);
                }
            }
        }
        path.pop();
        color[node] = 2;
        None
    }

    let mut path = Vec::new();
    for i in 0..n {
        if color[i] == 0 {
            if let Some(cycle) = dfs(i, graph, &mut color, &mut path) {
                let cycle_names: Vec<String> = cycle
                    .iter()
                    .map(|&mid| graph.modules[mid].path.clone())
                    .collect();
                if let Some(&first) = cycle.first() {
                    diagnostics.error(
                        graph.modules[first].file_idx,
                        Span::new(0, 0),
                        format!("circular dependency: {}", cycle_names.join(" → ")),
                    );
                }
                return Err(());
            }
        }
    }
    Ok(())
}

/// Find another dependency of `module_idx` (other than `exclude`) that also
/// exports `name`. Used for collision error messages.
fn find_other_export(
    modules: &[Module],
    module_idx: usize,
    name: IdentId,
    exclude: usize,
) -> String {
    for &dep_idx in &modules[module_idx].dependency_ids {
        if dep_idx == exclude {
            continue;
        }
        if let Some(ref st) = modules[dep_idx].scope_tree {
            let root = &st.scopes[st.root_scope];
            if root.symbols.contains_key(&name) {
                return modules[dep_idx].path.clone();
            }
        }
    }
    "<unknown>".to_string()
}

/// Lower, codegen, and concatenate all modules into a single JS string
/// wrapped in the outer IIFE.  Runs type inference on each module
/// (in topological order), then lowers and codegens each module,
/// adding namespace objects for dependency modules and import
/// bindings for the entry module.
///
/// `modules` must have `scope_tree` populated (from [`link_modules`]).
pub fn codegen_modules(
    graph: &ModuleGraph,
    modules: &[Module],
    arena: &AstArena,
    interner: &mut Interner,
    type_arena: &mut TypeArena,
) -> String {
    // Run type inference for each module (topo order, deps first)
    let mut modules = modules.to_vec();
    for &module_idx in &graph.topo_order {
        let root = modules[module_idx].root;
        let file_idx = modules[module_idx].file_idx;
        let st = modules[module_idx].scope_tree.as_mut().unwrap();
        let mut diagnostics = DiagnosticsBag::new();
        infer_types(arena, st, type_arena, interner, root, &mut diagnostics, file_idx);
    }

    // Lower + codegen for each module
    let mut fn_names = FnNameTable::new();
    let mut module_js: Vec<(usize, String)> = Vec::new();
    for &module_idx in &graph.topo_order {
        let module = &modules[module_idx];
        let st = module.scope_tree.as_ref().unwrap();
        let is_entry = module_idx == graph.entry;
        let hir = lower(arena, module.root, st, interner);
        let js = codegen_inner(hir, arena, st, type_arena, interner, &mut fn_names, is_entry);
        module_js.push((module_idx, js));
    }

    // Assign namespace variable names to non-entry modules
    let mut ns_for_file: FxHashMap<usize, String> = FxHashMap::default();
    let mut ns_id = 0usize;
    for &module_idx in &graph.topo_order {
        if module_idx != graph.entry {
            let ns_name = format!("__gema_{}", ns_id);
            ns_id += 1;
            ns_for_file.insert(modules[module_idx].file_idx, ns_name);
        }
    }

    // Build the combined output with namespace objects and import bindings
    let mut out_lines: Vec<String> = Vec::new();
    for &(module_idx, ref js) in &module_js {
        let is_entry = module_idx == graph.entry;
        out_lines.push(js.clone());

        if is_entry {
            // Entry module: emit import bindings before the entry code
            let st = modules[module_idx].scope_tree.as_ref().unwrap();
            let mut bindings: Vec<String> = Vec::new();
            let mut seen: FxHashSet<IdentId> = FxHashSet::default();
            for (_, scope) in &st.scopes {
                for (name, ids) in &scope.symbols {
                    for &sid in ids {
                        if !seen.insert(*name) {
                            continue;
                        }
                        let sym = &st.symbols[sid];
                        if matches!(sym.kind, SymbolKind::Variable { .. }) {
                            continue;
                        }
                        if let Some(src_file) = sym.source_module
                            && let Some(ns_name) = ns_for_file.get(&src_file)
                        {
                            let local_name = interner.lookup(*name);
                            let exported_name = interner.lookup(*name);
                            bindings.push(format!(
                                "const {} = {}.{};", local_name, ns_name, exported_name
                            ));
                        }
                    }
                }
            }
            if !bindings.is_empty() {
                let idx = out_lines.len() - 1;
                let mut with_bindings = bindings.join("\n");
                with_bindings.push('\n');
                with_bindings.push_str(js);
                out_lines[idx] = with_bindings;
            }
        } else {
            // Dependency module: emit namespace const after the code
            if let Some(ns_name) = ns_for_file.get(&modules[module_idx].file_idx) {
                let st = modules[module_idx].scope_tree.as_ref().unwrap();
                let mut entries: Vec<String> = Vec::new();
                let mut seen: FxHashSet<IdentId> = FxHashSet::default();
                for &export_name in &modules[module_idx].exports {
                    if !seen.insert(export_name) {
                        continue;
                    }
                    let mut machine_name: Option<String> = None;
                    'search: for (_, scope) in &st.scopes {
                        if let Some(ids) = scope.symbols.get(&export_name) {
                            for &sid in ids.iter().rev() {
                                let sym = &st.symbols[sid];
                                if sym.source_module.is_none() {
                                    if let Some(mn) = fn_names.get_name(sym.def_node) {
                                        machine_name = Some(mn.to_string());
                                        break 'search;
                                    } else if let SymbolKind::Variable { .. } = &sym.kind {
                                        machine_name = Some(interner.lookup(export_name).to_string());
                                        break 'search;
                                    } else {
                                        machine_name = Some(interner.lookup(export_name).to_string());
                                        break 'search;
                                    }
                                }
                            }
                        }
                    }
                    if let Some(mn) = machine_name {
                        let export_str = interner.lookup(export_name);
                        entries.push(format!(" {}: {}", export_str, mn));
                    }
                }
                if !entries.is_empty() {
                    let ns_line = format!("const {} = {{{}}};", ns_name, entries.join(","));
                    let idx = out_lines.len() - 1;
                    out_lines[idx] = format!("{}\n{}", js, ns_line);
                }
            }
        }
    }

    let combined = out_lines.join("\n");
    format!("(function() {{\n{combined}\n}})()")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::AstArena;
    use crate::interner::Interner;
    use crate::source::SourceMap;

    #[test]
    fn test_single_file_no_modules() {
        let mut arena = AstArena::new();
        let mut interner = Interner::new();
        let mut source_map = SourceMap::new();
        let mut diagnostics = DiagnosticsBag::new();

        let files = vec![(
            "main.gema".to_string(),
            "func add(a: Num, b: Num): Num { a + b }".to_string(),
        )];
        let graph = build_module_graph_from_sources(
            &files,
            &mut arena,
            &mut interner,
            &mut source_map,
            &mut diagnostics,
        );
        assert!(graph.is_ok(), "single file should build: {:?}", diagnostics);
        let graph = graph.unwrap();
        assert_eq!(graph.modules.len(), 1);
        assert_eq!(graph.topo_order.len(), 1);
    }

    #[test]
    fn test_two_unconnected_modules() {
        let mut arena = AstArena::new();
        let mut interner = Interner::new();
        let mut source_map = SourceMap::new();
        let mut diagnostics = DiagnosticsBag::new();

        let files = vec![
            (
                "main.gema".to_string(),
                "func add(a: Num, b: Num): Num { a + b }".to_string(),
            ),
            (
                "math.gema".to_string(),
                "func mul(a: Num, b: Num): Num { a * b }".to_string(),
            ),
        ];
        let graph = build_module_graph_from_sources(
            &files,
            &mut arena,
            &mut interner,
            &mut source_map,
            &mut diagnostics,
        );
        assert!(
            graph.is_ok(),
            "two disconnected files should build: {:?}",
            diagnostics
        );
        let graph = graph.unwrap();
        assert_eq!(graph.modules.len(), 2);
        // Both have no dependencies
        for module in &graph.modules {
            assert!(module.dependency_ids.is_empty());
        }
    }

    #[test]
    fn test_missing_module_errors() {
        let mut arena = AstArena::new();
        let mut interner = Interner::new();
        let mut source_map = SourceMap::new();
        let mut diagnostics = DiagnosticsBag::new();

        let files = vec![(
            "main.gema".to_string(),
            "use \"nonexistent.gema\"".to_string(),
        )];
        let graph = build_module_graph_from_sources(
            &files,
            &mut arena,
            &mut interner,
            &mut source_map,
            &mut diagnostics,
        );
        assert!(
            graph.is_err(),
            "should error on missing module: {:?}",
            diagnostics
        );
    }

    #[test]
    fn test_circular_dependency_error() {
        let mut arena = AstArena::new();
        let mut interner = Interner::new();
        let mut source_map = SourceMap::new();
        let mut diagnostics = DiagnosticsBag::new();

        let files = vec![
            ("a.gema".to_string(), "use \"b.gema\"".to_string()),
            ("b.gema".to_string(), "use \"a.gema\"".to_string()),
        ];
        let graph = build_module_graph_from_sources(
            &files,
            &mut arena,
            &mut interner,
            &mut source_map,
            &mut diagnostics,
        );
        assert!(
            graph.is_err(),
            "should error on circular dep: {:?}",
            diagnostics
        );
    }

    #[test]
    fn test_link_single_module() {
        let mut arena = AstArena::new();
        let mut interner = Interner::new();
        let mut source_map = SourceMap::new();
        let mut diagnostics = DiagnosticsBag::new();

        let files = vec![(
            "main.gema".to_string(),
            "func answer(): Num { 42 }".to_string(),
        )];
        let graph = build_module_graph_from_sources(
            &files,
            &mut arena,
            &mut interner,
            &mut source_map,
            &mut diagnostics,
        )
        .unwrap();
        let modules = link_modules(&graph, &arena, &mut interner, &mut diagnostics);
        assert_eq!(modules.len(), 1);
        assert!(modules[0].scope_tree.is_some());
        assert!(
            modules[0]
                .exports
                .contains(&interner.intern("answer")),
            "exports should contain 'answer'"
        );
    }
}
