use std::{env, process};

use gema::{
    ast::AstArena,
    codegen::{codegen, codegen_inner, FnNameTable},
    diagnostics::DiagnosticsBag,
    infer::infer_types,
    interner::Interner,
    lower::lower,
    modules,
    parse::parse,
    resolve::resolve_names,
    scan::scan,
    source::{SourceMap, SourceText},
    types::TypeArena,
};

struct ParsedInput {
    show_hir: bool,
    program: String,
}

fn parse_input(args: &[String]) -> Result<ParsedInput, &'static str> {
    if args.len() < 2 {
        return Err("Missing required argument [PROGRAM]");
    }

    let mut show_hir = false;
    let mut program: Option<String> = None;

    for arg in args.iter().skip(1) {
        if arg == "--help" {
            print_help();
            process::exit(0);
        } else if arg == "--hir" {
            show_hir = true;
        } else {
            program = Some(arg.clone());
        }
    }

    match program {
        Some(p) => Ok(ParsedInput { show_hir, program: p }),
        None => Err("Missing required argument [PROGRAM]"),
    }
}

fn print_help() {
    println!(
        "Usage: gema [FLAGS] [PROGRAM]\n\n\
         Arguments:\n  \
           [PROGRAM]    The program to compile (source text or .gema file path)\n\n\
         Flags:\n  \
           -h, --help   Print this help\n  \
           --hir        Show HIR"
    );
}

/// Compile a single source code string (no module support).
fn compile(input: ParsedInput) -> Result<String, String> {
    let src = SourceText::new("test.gema", input.program);
    let (tokens, sd) = scan(&src, 0);
    if sd.has_errors() {
        return Err(format!("Scan errors: {:#?}", sd));
    }
    let mut arena = AstArena::new();
    let mut interner = Interner::new();
    let mut diagnostics = DiagnosticsBag::new();
    let mut source_map = SourceMap::new();
    source_map.add(src);
    for d in sd.into_vec() {
        diagnostics.push(d);
    }
    let root = parse(&tokens, &mut arena, &mut interner, &mut diagnostics, 0);
    let mut scope_tree = resolve_names(&arena, root, &mut interner, &mut diagnostics, 0);
    if diagnostics.has_errors() {
        return Err(format!("{:#?}", diagnostics));
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
    if diagnostics.has_errors() {
        return Err(format!("{:#?}", diagnostics));
    }
    let hir = lower(&arena, root, &scope_tree, &interner);
    if input.show_hir {
        println!("{:#?}", hir);
    }
    Ok(codegen(
        hir,
        &arena,
        &scope_tree,
        &type_arena,
        &mut interner,
    ))
}

/// Compile a file path with module system support.
/// If the file has no `use` statements, behavior is identical to single-file.
fn compile_multi(entry_path: &str, show_hir: bool) -> Result<String, String> {
    let mut arena = AstArena::new();
    let mut interner = Interner::new();
    let mut source_map = SourceMap::new();
    let mut diagnostics = DiagnosticsBag::new();

    // Step 1: Build module graph (discovers and parses all transitive deps)
    let graph = modules::build_module_graph(
        entry_path,
        &mut arena,
        &mut interner,
        &mut source_map,
        &mut diagnostics,
    )
    .map_err(|_| format!("{:#?}", diagnostics))?;
    if diagnostics.has_errors() {
        return Err(format!("{:#?}", diagnostics));
    }

    // Step 2: Link modules (inject dependency exports, resolve names)
    let mut modules = modules::link_modules(&graph, &arena, &mut interner, &mut diagnostics);
    if diagnostics.has_errors() {
        return Err(format!("{:#?}", diagnostics));
    }

    // Step 3: Type inference for each module (topo order, deps first)
    let mut type_arena = TypeArena::new();
    for &module_idx in &graph.topo_order {
        let module = &mut modules[module_idx];
        let st = module.scope_tree.as_mut().unwrap();
        let _types = infer_types(
            &arena,
            st,
            &mut type_arena,
            &interner,
            module.root,
            &mut diagnostics,
            module.file_idx,
        );
        if diagnostics.has_errors() {
            return Err(format!("{:#?}", diagnostics));
        }
    }

    // Step 4: Lower + codegen for each module, concatenating output
    let mut js_parts: Vec<String> = Vec::new();
    let mut fn_names = FnNameTable::new();
    for &module_idx in &graph.topo_order {
        let module = &modules[module_idx];
        let st = module.scope_tree.as_ref().unwrap();
        let is_entry = module_idx == graph.entry;

        let hir = lower(&arena, module.root, st, &interner);
        if show_hir {
            println!("// ── {} ──\n{:#?}", module.path, hir);
        }
        let js = codegen_inner(hir, &arena, st, &type_arena, &mut interner, &mut fn_names, is_entry);
        if is_entry {
            // Entry module output comes last with `return`
            js_parts.insert(0, js);
        } else {
            js_parts.push(js);
        }
    }

    // Build the output: the entry module (with return) at the end
    let combined = js_parts.join("\n");
    Ok(format!(
        "(function() {{\n{combined}\n}})()"
    ))
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let input = parse_input(&args).unwrap_or_else(|err| {
        eprintln!("Problem parsing arguments: {}", err);
        print_help();
        process::exit(1);
    });

    // If the argument looks like a .gema file path, route to compile_multi
    // This allows the test suite to continue passing inline sources.
    let result = if input.program.ends_with(".gema") && std::path::Path::new(&input.program).exists() {
        compile_multi(&input.program, input.show_hir)
    } else {
        compile(input)
    };

    match result {
        Ok(compiled) => println!("{}", compiled),
        Err(e) => eprintln!("{}", e),
    };
}
