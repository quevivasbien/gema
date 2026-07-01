import { TokenType, type Token } from "../tokens";
import type { JSWriter } from "../write-js";
import { Expression } from "./expression";
import type { Scope } from "./scope";
import { typeEquals } from "./type-utils";
import { EscapeType, TupleType, type Type } from "./types";

function addVariableToScope(
    enclosingScope: Scope,
    varAttrs: { name: string; type: Type; isMutable: boolean }
) {
    let isReassignment = false;

    // Module-level definitions always register in their own module's scope
    // (UseModule.cascadeTypes injects them into the importing scope later).
    const existingDefinition = enclosingScope.lookup(varAttrs.name);
    // Variable already defined in the same scope
    if (existingDefinition !== null && existingDefinition.inCurrentScope) {
        const existingAttrs = existingDefinition.attrs;
        if (varAttrs.isMutable) {
            return {
                error: `cannot redeclare variable '${varAttrs.name}' with 'mut' — it was already defined in the same scope`,
            };
        }

        isReassignment = true;

        if (existingAttrs.class !== "var") {
            return {
                error: `cannot reassign '${varAttrs.name}' — another definition with the same name precedes it in the same scope`,
            };
        }

        if (!existingAttrs.isMutable) {
            return { error: `cannot reassign non-mutable variable '${varAttrs.name}'` };
        }

        const assignType = varAttrs.type;
        if (!typeEquals(existingAttrs.type, assignType)) {
            return {
                error: `tried to reassign variable '${varAttrs.name}' with type ${assignType} but it was defined earlier with type ${existingAttrs.type}`,
            };
        }
    }
    // Variable already defined, in an outer scope
    else if (existingDefinition !== null) {
        // If the outer definition is not mutable, this is always considered a new declaration
        // If the outer definition is a mutable var, the type must match, and the inner definition cannot be a new mut declaration
        const existingAttrs = existingDefinition.attrs;
        if (existingAttrs.class === "var" && existingAttrs.isMutable) {
            if (!typeEquals(existingAttrs.type, varAttrs.type)) {
                return {
                    error: `tried to reassign variable '${varAttrs.name}' with type ${varAttrs.type} but it was defined as mutable in an enclosing scope with type ${existingAttrs.type} -- mutable variables cannot be set to a different type in a scope where the original definition is still active`,
                };
            }
            if (varAttrs.isMutable) {
                return {
                    error: `cannot redeclare variable '${varAttrs.name}' with 'mut' — it was already defined in an enclosing scope`,
                };
            }
            // Types match -- this is a reassignment
            isReassignment = true;
        }
    }
    if (!isReassignment) {
        enclosingScope.defineVariable({ class: "var", ...varAttrs, isConsumed: false });
    }
    return { isReassignment };
}

export class Assignment extends Expression {
    name: string;
    value: Expression;
    isDropped: boolean;
    isMutable: boolean = false;
    isReassignment: boolean = false; // TODO: Does this get used for anything??

    constructor(
        variableToken: Token,
        value: Expression,
        isDropped: boolean,
        isMutable: boolean = false
    ) {
        super(variableToken.line, variableToken.col);
        this.value = value;
        this.isDropped = isDropped;
        this.name = variableToken.text;
        this.isMutable = isMutable;
    }

    getAllChildren(): Expression[] {
        return [this.value];
    }

    cascadeTypes(parent: Expression | null, valueUsed: boolean): void {
        super.cascadeTypes(parent, valueUsed);
        this.value.cascadeTypes(this, true);
        this.type = this.isDropped ? "Null" : this.value.type;

        if (this.value.type === "Null" || this.value.type instanceof EscapeType) {
            throw this.error("cannot assign null or escape value to variable");
        }

        const enclosingScope = this.getScope();
        if (enclosingScope === null) {
            // Should be impossible
            throw new Error("Tried to define a variable in a position with no enclosing scope");
        }
        const { error, isReassignment } = addVariableToScope(enclosingScope, {
            name: this.name,
            type: this.value.type!,
            isMutable: this.isMutable,
        });
        if (error) {
            throw this.error(error);
        }
        if (isReassignment) {
            this.isReassignment = true;
        }
    }

    clone(bindings?: Map<string, Type>): Expression {
        const cloned = new Assignment(
            { line: this.line, col: this.col, text: this.name, type: TokenType.Identifier },
            this.value.clone(bindings),
            this.isDropped,
            this.isMutable
        );
        return cloned;
    }

    toJS(writer: JSWriter): void {
        const safeName = writer.safeName(this.name);
        if (this.isReassignment) {
            writer.write(`${safeName} = `);
            this.value.toJS(writer);
        } else {
            if (this.isDropped) {
                writer.write(`${this.isMutable ? "let" : "const"} ${safeName} = `);
                this.value.toJS(writer);
            } else {
                writer.declareVariable(this.name);
                writer.write(`${safeName} = `);
                this.value.toJS(writer);
            }
        }
    }
}

export class TupleUnpack extends Expression {
    bindings: { name: string; isMutable: boolean; isReassignment: boolean }[];
    source: Expression;
    isDropped: boolean;

    constructor(
        startToken: Token,
        bindings: { name: string; isMutable: boolean }[],
        source: Expression,
        isDropped: boolean
    ) {
        super(startToken.line, startToken.col);
        this.bindings = bindings.map((b) => ({ ...b, isReassignment: false }));
        this.source = source;
        this.isDropped = isDropped;
    }

    cascadeTypes(parent: Expression | null, valueUsed: boolean): void {
        super.cascadeTypes(parent, valueUsed);
        this.source.cascadeTypes(this, true);
        if (this.source.type === null) {
            throw this.error("unable to resolve type of source expression");
        }
        if (!(this.source.type instanceof TupleType)) {
            throw this.error(`cannot unpack non-tuple expression of type ${this.source.type}`);
        }
        if (this.source.type.types.length !== this.bindings.length) {
            throw this.error(
                `tuple has ${this.source.type.types.length} elements but unpacking into ${this.bindings.length} variables`
            );
        }
        this.type = this.isDropped ? "Null" : this.source.type;

        // Resolve each binding — either reassign an existing variable or declare a new one
        const enclosingScope = this.getScope();
        if (enclosingScope === null) {
            throw new Error("Tried to unpack a tuple in a position with no enclosing scope");
        }
        for (let i = 0; i < this.bindings.length; i++) {
            const binding = this.bindings[i];
            const elemType = this.source.type.types[i];

            const { error, isReassignment } = addVariableToScope(enclosingScope, {
                name: binding.name,
                type: elemType,
                isMutable: binding.isMutable,
            });
            if (error) {
                throw this.error(error);
            }
            if (isReassignment) {
                binding.isReassignment = true;
            }
        }
    }

    clone(bindings?: Map<string, Type>): Expression {
        return new TupleUnpack(
            { line: this.line, col: this.col, text: "(", type: TokenType.LParen },
            this.bindings.map((b) => ({ name: b.name, isMutable: b.isMutable })),
            this.source.clone(bindings),
            this.isDropped
        );
    }

    toJS(writer: JSWriter): void {
        // If dropped, emit [a, b] = source
        if (this.isDropped) {
            writer.write("[");
            for (let i = 0; i < this.bindings.length; i++) {
                const binding = this.bindings[i];
                if (!binding.isReassignment) {
                    writer.declareVariable(binding.name);
                }
                const safeName = writer.safeName(binding.name);
                writer.write(`${safeName}${i == this.bindings.length - 1 ? "] = " : ","}`);
            }
            this.source.toJS(writer);
        }
        // If not dropped, use a comma expression so TupleUnpack evaluates to the source tuple.
        // Emit: ($tup = source, a = $tup[0], b = $tup[1], $tup)
        else {
            const tmpName = writer.uniqueName("$tup$");
            writer.declareVariable(tmpName);
            writer.write(`(${tmpName} = `);
            this.source.toJS(writer);
            for (let i = 0; i < this.bindings.length; i++) {
                const binding = this.bindings[i];
                if (!binding.isReassignment) {
                    writer.declareVariable(binding.name);
                }
                const safeName = writer.safeName(binding.name);
                writer.write(`, ${safeName} = ${tmpName}[${i}]`);
            }
            writer.write(`, ${tmpName})`);
        }
    }
}
