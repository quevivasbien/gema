import type { Token } from "../tokens";
import type { JSWriter } from "../write-js";
import { Assignment } from "./assignment";
import { writeTraitImplDictionaries } from "./caller-resolution";
import { Expression } from "./expression";
import { CustomType, FuncType, IterType, type TemplateTypes, type Type } from "./types";

export class Variable extends Expression {
    name: string;
    // TODO: Should we actually allow template types on variables? This is kind of an odd design
    // Probably, yes -- this is needed for the type system to work, but in the future let's
    // add better type inference to allow this to (usually) be not necessary
    templateTypes: TemplateTypes | null;

    toJSHelper: ((writer: JSWriter) => void) | null = null;

    constructor(token: Token, templateTypes: TemplateTypes | null) {
        super(token.line, token.col);
        this.name = token.text;
        this.templateTypes = templateTypes;
    }

    toString(): string {
        if (this.templateTypes && !this.templateTypes.empty()) {
            return `${this.name}${this.templateTypes}`;
        }
        return this.name;
    }

    resolveAssignment(e: Expression): Type | null {
        if (e instanceof Assignment && e.name === this.name) {
            return e.value.type;
        }
        return null;
    }

    cascadeTypes(parent: Expression | null, valueUsed: boolean): void {
        super.cascadeTypes(parent, valueUsed);
        // Scope-based lookup — resolves params, loop vars, local assignments,
        // function references, struct/enum/trait references from the enclosing scope hierarchy.
        const scope = this.getScope();
        if (scope) {
            const result = scope.lookup(this.name);
            if (result) {
                const attrs = result.attrs;
                if (attrs.class === "var") {
                    // Check if this variable was consumed
                    // Variables consumed cannot be used afterward.
                    // TODO: The "is consumed" checks are deprecated
                    if (attrs.isConsumed) {
                        throw this.error(
                            `cannot use variable '${this.name}' after it was consumed`
                        );
                    }
                    if (this.templateTypes !== null && !this.templateTypes.empty()) {
                        throw this.error(
                            `symbol ${this.name} matched with a variable but should not have been annotated with template types`
                        );
                    }
                    this.type = attrs.type;
                    this.toJS = (writer) => {
                        const name = writer.safeName(this.name);
                        writer.write(name);
                        // Clone iterator variables on every use so that sharing an iterator
                        // across multiple expressions (nested loops, call arguments, pipes, etc.)
                        // doesn't cause one consumer to share the same state as another
                        if (this.type instanceof IterType) {
                            writer.write(".clone()");
                        }
                    };
                    return;
                } else {
                    // We got a match, but it's not a variable (it's a function, struct, enum, or trait definition)
                    // We need to do a more complicated caller resolution to check if the params types coincide
                    // This basically mimics the way caller resolution works but either saves the function's full name or wraps the callable in an anon function.
                    // For example, a match to func foo(x: Num) with foo[Num] would be compiled to literally `foo$Num` (the function's fullName)
                    // and a match to the struct constructor for struct Foo { x: Num } with Foo[Num] would be compiled to ($arg0) => { x: $arg0 }
                    const argTypes = this.templateTypes?.types ?? [];
                    const result = scope.lookupCaller(this.name, argTypes, null, scope);
                    if (result === null) {
                        // No match with compatible arg types!
                        throw this.error(
                            `could not resolve variable ${this.toString()} -- found a definition with a matching name but template types were missing or incompatible`
                        );
                    }
                    if (result.class === "func") {
                        this.type = result.type;
                        this.toJSHelper = (writer) => {
                            const name = writer.safeName(result.fullName);
                            writer.write(name);
                        };
                    } else if (result.class === "generic") {
                        this.type = result.type;
                        this.toJSHelper = (writer) => {
                            const name = writer.safeName(result.fullName);
                            writer.write(`(...$args) => ${name}(...$args`);
                            writeTraitImplDictionaries(writer, result.genericMapping);
                            writer.write(")");
                        };
                    } else if (result.class === "enum") {
                        // TODO -- I'm not sure this is actually possible
                        throw this.error(
                            `enum instantiation as callable variable is not implemented!`
                        );
                    } else if (result.class === "struct") {
                        this.type = new FuncType(argTypes, new CustomType(result.name)); // TODO: This doesn't work with generic structs
                        this.toJSHelper = (writer) => {
                            writer.write(`(...$args) => ({`);
                            result.fields.forEach((f, i) => {
                                if (i > 0) {
                                    writer.write(", ");
                                }
                                writer.write(`${writer.safeName(f.name)}: $args[${i}]`);
                            });
                            writer.write("})");
                        };
                    } else {
                        throw this.error(
                            `got unexpected match ${result} in templated variable resolution`
                        );
                    }
                    return;
                }
            }
        }

        throw this.error(`unable to resolve type of variable ${this}`);
    }

    toJS(writer: JSWriter): void {
        if (this.toJSHelper === null) {
            throw this.error(
                `toJSHelper not resolved for variable ${this} -- this should have happened during type resolution`
            );
        }
        this.toJSHelper(writer);
    }
}
