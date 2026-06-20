#!/usr/bin/env bun
/**
 * CLI compiler for Gema — compiles a .gema file to JavaScript.
 *
 * Usage:
 *   bun compile.ts [options] <file>...
 *
 * Examples:
 *   bun compile.ts input.gema                              # Single file
 *   bun compile.ts -e main.gema lib.gema utils.gema        # Multi-file with explicit entry
 *   bun compile.ts -o output.js input.gema                 # Custom output path
 *   bun compile.ts -e main.gema -m lib.gema utils.gema     # Minified multi-file
 *   bun compile.ts --help
 */

import { parseArgs } from "util";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, extname, basename, dirname } from "path";
import { compile } from "./src/compiler.ts";

const { values, positionals } = parseArgs({
    options: {
        output: {
            type: "string",
            short: "o",
        },
        minify: {
            type: "boolean",
            short: "m",
        },
        entry: {
            type: "string",
            short: "e",
        },
        help: {
            type: "boolean",
            short: "h",
        },
    },
    allowPositionals: true,
    strict: true,
});

if (values.help || positionals.length === 0) {
    console.log(`
Usage: bun compile.ts [options] <file>...

Compile one or more Gema source files (.gema) to JavaScript.

Arguments:
  file                    Path(s) to .gema source file(s)

Options:
  -e, --entry <file>      Entry point filename (default: main.gema)
  -o, --output <file>     Output file path (default: same name as entry with .js)
  -m, --minify            Minify the compiled code using Bun.Transpiler
  -h, --help              Show this help message

Examples:
  bun compile.ts main.gema
  bun compile.ts -e main.gema math.gema utils.gema
  bun compile.ts -m -e app.gema -o bundle.js lib/*.gema
`);
    process.exit(values.help ? 0 : 1);
}

// Determine entry file
// If --entry is explicitly provided, use it.
// Otherwise, if there's only one positional arg, use it as the entry.
// Otherwise, default to "main.gema".
let entry: string;
if (values.entry) {
    entry = values.entry;
} else if (positionals.length === 1) {
    entry = basename(resolve(positionals[0]));
} else {
    entry = "main.gema";
}

// Build the files map — read all positional args from disk
const files: Record<string, string> = {};
for (const pos of positionals) {
    const filePath = resolve(pos);
    if (!existsSync(filePath)) {
        console.error(`Error: file not found: ${filePath}`);
        process.exit(1);
    }
    const content = readFileSync(filePath, "utf-8");
    const filename = basename(filePath);
    files[filename] = content;
}

if (!files[entry]) {
    console.error(
        `Error: entry file '${entry}' not found among provided files: [${Object.keys(files).join(", ")}]`
    );
    process.exit(1);
}

// Show source lines for error display (collect from all files)
const sourceLines: Record<string, string[]> = {};
for (const [name, content] of Object.entries(files)) {
    sourceLines[name] = content.split("\n");
}

const result = compile(files, "export", entry);

if (result.errors && result.errors.length > 0) {
    console.error("Compilation failed:");
    for (const err of result.errors) {
        const line = err.line + 1;
        const col = err.col + 1;
        console.error(`\n  × line ${line}, col ${col}: ${err.message}`);
        // Try to show source context from each registered file
        for (const [name, lines] of Object.entries(sourceLines)) {
            if (err.line >= 0 && err.line < lines.length) {
                if (err.line > 0) {
                    console.error(`    ${name}:${line - 1} │ ${lines[err.line - 1]}`);
                }
                console.error(`    ${name}:${line} │ ${lines[err.line]}`);
                console.error(
                    `    ${" ".repeat(String(line).length + name.length + 5 + err.col)}^`
                );
            }
        }
    }
    process.exit(1);
}

let compiledCode = result.js;

if (values.minify) {
    const transpiler = new Bun.Transpiler({
        loader: "js",
        trimUnusedImports: true,
        minifyWhitespace: true,
        inline: true,
    });

    const minifiedCode = transpiler.transformSync(compiledCode);

    console.log(
        `Reduced output size from ${compiledCode.length} to ${minifiedCode.length} characters`
    );
    compiledCode = minifiedCode;
}

// Determine output path
let outputPath: string;
if (values.output) {
    outputPath = resolve(values.output);
} else {
    const dir = dirname(resolve(positionals[0]));
    const name = basename(entry, extname(entry));
    outputPath = resolve(dir, name + ".js");
}

// Write output
writeFileSync(outputPath, compiledCode, "utf-8");
console.log(`✓ Compiled to ${outputPath}`);
