#!/usr/bin/env bun
/**
 * CLI compiler for Gema — compiles a .gema file to JavaScript.
 *
 * Usage:
 *   bun compile.ts input.gema [--minify]
 *   bun compile.ts input.gema -o output.js [--minify]
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
Usage: bun compile.ts [options] <file>

Compile a Gema source file (.gema) to JavaScript.

Arguments:
  file                    Path to the .gema source file

Options:
  -o, --output <file>     Output file path (default: same name as input with .js)
  -m, --minify            Minify the compiled code using Bun.Transpiler
  -h, --help              Show this help message
`);
    process.exit(values.help ? 0 : 1);
}

const inputPath = resolve(positionals[0]);

if (!existsSync(inputPath)) {
    console.error(`Error: file not found: ${inputPath}`);
    process.exit(1);
}

// Determine output path
let outputPath: string;
if (values.output) {
    outputPath = resolve(values.output);
} else {
    const dir = dirname(inputPath);
    const name = basename(inputPath, extname(inputPath));
    outputPath = resolve(dir, name + ".js");
}

// Read and compile
const source = readFileSync(inputPath, "utf-8");
const sourceLines = source.split("\n");

const result = compile(source, "export");

if (result.errors && result.errors.length > 0) {
    console.error("Compilation failed:");
    for (const err of result.errors) {
        const line = err.line + 1;
        const col = err.col + 1;
        console.error(`\n  × line ${line}, col ${col}: ${err.message}`);
        if (err.line >= 0 && err.line < sourceLines.length) {
            // Show the offending line with a caret
            if (err.line > 0) {
                console.error(`    ${line - 1} │ ${sourceLines[err.line - 1]}`);
            }
            console.error(`    ${line} │ ${sourceLines[err.line]}`);
            console.error(`    ${" ".repeat(String(line).length + 3 + err.col)}^`);
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

    console.log(`Reduced output size from ${compiledCode.length} to ${minifiedCode.length} characters`);
    compiledCode = minifiedCode;
}

// Write output
writeFileSync(outputPath, compiledCode, "utf-8");
console.log(`✓ Compiled to ${outputPath}`);
