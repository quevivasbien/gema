import { test, expect } from "bun:test";
import { scan } from "../src/scan";
import { parse } from "../src/parse";
import { resetRegistries } from "../src/ast/registries";

test("debug if true else if false", () => {
    resetRegistries();
    const tokens = scan("x = if true { 1 } else if false { 2 }");
    const { ast, errors } = parse(tokens);
    console.log("Errors:", JSON.stringify(errors.map(e => e.message)));
    expect(errors.length).toBeGreaterThan(0);
});
