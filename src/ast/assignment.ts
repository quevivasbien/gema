import { TokenType, type Token } from "../tokens";
import type { JSWriter } from "../write-js";
import { Expression } from "./expression";
import type { Scope } from "./scope";
import { deepEquals } from "./type-utils";
import { TupleType, type Type } from "./types";

function addVariableToScope(
    enclosingScope: Scope,
    varAttrs: { name: string; type: Type; isMutable: boolean }
) {
    let isReassignment = false;
    const existingDefinition = enclosingScope.lookup(varAttrs.name);
    if (existingDefinition !== null) {
        // Variable is already defined -- This is only valid if:
        // (1) The original assignment is in a higher scope
        // (2) The original assignment was a mut assignment, and this one is not
        //     AND this assignment has the same type as the original
        const existingAttrs = existingDefinition.attrs;
        if (varAttrs.isMutable) {
            return {
                error: `cannot redeclare variable '${varAttrs.name}' with 'mut' — it was already defined`,
            };
        }

        isReassignment = true;

        if (existingAttrs.class === "func") {
            return {
                error: `cannot assign variable ${varAttrs.name} since a function with the same name is already defined`,
            };
        }

        if (!existingAttrs.isMutable) {
            return { error: `cannot reassign non-mutable variable '${varAttrs.name}'` };
        }

        const assignType = varAttrs.type;
        if (!deepEquals(existingAttrs.type, assignType)) {
            return {
                error: `tried to reassign variable '${varAttrs.name}' with type ${assignType} but it was previously defined with type ${existingAttrs.type}`,
            };
        }
    }
    if (!isReassignment) {
        enclosingScope.defineVariable({ class: "var", ...varAttrs });
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

        if (this.value.type === "Null") {
            throw this.error("cannot assign null value to variable");
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
