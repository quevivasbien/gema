use std::{env, process};

use gema::{
    ast::AstArena,
    codegen::codegen,
    diagnostics::DiagnosticsBag,
    infer::infer_types,
    interner::Interner,
    lower::lower,
    modules::{build_module_graph, codegen_modules, link_modules},
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
        Some(p) => Ok(ParsedInput {
            show_hir,
            program: p,
        }),
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
fn compile(input: ParsedInput) -> Result<String, DiagnosticsBag> {
    let src = SourceText::new("test.gema", input.program);
    let (tokens, mut diagnostics) = scan(&src, 0);
    let mut arena = AstArena::new();
    let mut interner = Interner::new();
    let mut source_map = SourceMap::new();
    source_map.add(src);
    let root = parse(&tokens, &mut arena, &mut interner, &mut diagnostics, 0);
    let mut scope_tree = resolve_names(&arena, root, &mut interner, &mut diagnostics, 0);
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
    let hir = lower(&arena, root, &scope_tree, &mut interner);
    if input.show_hir {
        println!("{:#?}", hir);
    }
    if diagnostics.has_errors() {
        return Err(diagnostics);
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
fn compile_multi(entry_path: &str, show_hir: bool) -> Result<String, DiagnosticsBag> {
    let mut arena = AstArena::new();
    let mut interner = Interner::new();
    let mut source_map = SourceMap::new();
    let mut diagnostics = DiagnosticsBag::new();

    let graph = build_module_graph(
        entry_path,
        &mut arena,
        &mut interner,
        &mut source_map,
        &mut diagnostics,
    )
    .map_err(|_| diagnostics.clone())?;
    eprintln!("graph modules: {}", graph.modules.len());
    for (i, m) in graph.modules.iter().enumerate() {
        eprintln!("  [{}]: path={:?}, deps={:?}", i, m.path, m.dependency_ids);
    }
    eprintln!("topo_order: {:?}", graph.topo_order);
    let mut modules = link_modules(&graph, &arena, &mut interner, &mut diagnostics);
    let mut type_arena = TypeArena::new();
    let output = codegen_modules(
        &graph,
        &mut modules,
        &arena,
        &mut interner,
        &mut type_arena,
        &mut diagnostics,
    );

    if show_hir {
        for module in &modules {
            let st = module.scope_tree.as_ref().unwrap();
            let hir = lower(&arena, module.root, st, &mut interner);
            println!("// ── {} ──\n{:#?}", module.path, hir);
        }
    }

    if diagnostics.has_errors() {
        return Err(diagnostics);
    }

    Ok(output)
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
    let result =
        if input.program.ends_with(".gema") && std::path::Path::new(&input.program).exists() {
            compile_multi(&input.program, input.show_hir)
        } else {
            compile(input)
        };

    match result {
        Ok(compiled) => println!("{}", compiled),
        Err(e) => eprintln!("{:#?}", e),
    };
}

// #[cfg(test)]
// mod test {
//     use super::compile_multi;

//     #[test]
//     fn test_file() {
//         let result = compile_multi("test.gema", false);
//         match result {
//             Ok(compiled) => println!("{}", compiled),
//             Err(e) => eprintln!("{}", e),
//         };
//     }
// }
