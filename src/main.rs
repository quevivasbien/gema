use std::{env, process};

use gema::{
    ast::AstArena, codegen::codegen, diagnostics::DiagnosticsBag, infer::infer_types,
    interner::Interner, lower::lower, parse::parse, resolve::resolve_names, scan::scan,
    source::SourceText, types::TypeArena,
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
        match arg.as_str() {
            "-h" | "--help" => {
                print_help();
                process::exit(0);
            }
            "--hir" => {
                show_hir = true;
            }
            _ if arg.starts_with('-') => {
                return Err("Unknown flag provided");
            }
            _ => {
                if program.is_none() {
                    program = Some(arg.clone());
                } else {
                    return Err("Too many arguments provided");
                }
            }
        }
    }
    match program {
        Some(program) => Ok(ParsedInput { show_hir, program }),
        None => Err("Missing filename argument"),
    }
}

fn print_help() {
    println!(
        "Usage: gema [FLAGS] [PROGRAM]\n\n\
         Arguments:\n  \
           [PROGRAM]    The program to compile\n\n\
         Flags:\n  \
           -h, --help   Print this help\n  \
           --hir        Show HIR"
    );
}

fn compile(input: ParsedInput) -> Result<String, String> {
    let src = SourceText::new("test.gema", input.program);
    let (tokens, sd) = scan(&src, 0);
    if sd.has_errors() {
        return Err(format!("Scan errors: {:#?}", sd));
    }
    let mut arena = AstArena::new();
    let mut interner = Interner::new();
    let mut diagnostics = DiagnosticsBag::new();
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

fn main() {
    let args: Vec<String> = env::args().collect();
    let input = parse_input(&args).unwrap_or_else(|err| {
        eprintln!("Problem parsing arguments: {}", err);
        print_help();
        process::exit(1);
    });
    match compile(input) {
        Ok(compiled) => println!("{}", compiled),
        Err(e) => eprintln!("{}", e),
    };
}
