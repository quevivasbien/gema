import { TokenType, type Token } from "../tokens";
import type { JSWriter } from "../write-js";
import { ASTError, Expression } from "./expression";
import { Scope } from "./scope";

import { typeEquals } from "./type-utils";
import { EnumType, EscapeType, MaybeType, substituteTypeParams, type Type } from "./types";

// ── Enum definition ───────────────────────────────────────

export class EnumDef extends Expression {
    name: string;
    variants: { name: string; type: Type | null }[];
    typeParams: string[] = [];
    monomorphizedVersions: EnumDef[] = [];

    constructor(
        rootToken: Token,
        name: string,
        variants: { name: string; type: Type | null }[],
        typeParams: string[] = []
    ) {
        super(rootToken.line, rootToken.col);
        this.name = name;
        this.variants = variants;
        this.typeParams = typeParams;
        this.type = "Null";
    }

    get isGeneric(): boolean {
        return this.typeParams.length > 0;
    }

    cascadeTypes(parent: Expression | null, valueUsed: boolean): void {
        super.cascadeTypes(parent, valueUsed);
        // Register this enum's name in the enclosing scope so Variable references can find it
        const blockScope = this.getScope();
        if (blockScope) {
            blockScope.defineVariable({
                class: "enum",
                name: this.name,
                variants: this.variants.map((v) => ({ name: v.name, type: v.type })),
                isGeneric: this.isGeneric || undefined,
                typeParams: this.typeParams.length > 0 ? this.typeParams : undefined,
                def: this.isGeneric ? this : undefined,
            });
        }
    }

    /**
     * Monomorphize this generic enum with concrete type arguments.
     * Returns the concrete variant types and an EnumType with concrete types.
     */
    monomorphize(
        typeArgs: Type[]
    ): { variants: { name: string; type: Type | null }[]; enumType: EnumType } | null {
        if (!this.isGeneric) return null;
        if (typeArgs.length !== this.typeParams.length) return null;

        const bindings = new Map<string, Type>();
        for (let i = 0; i < this.typeParams.length; i++) {
            bindings.set(this.typeParams[i], typeArgs[i]);
        }

        const concreteVariants = this.variants.map((v) => ({
            name: v.name,
            type: v.type ? substituteTypeParams(v.type, bindings) : null,
        }));

        return {
            variants: concreteVariants,
            enumType: new EnumType(this.name, concreteVariants),
        };
    }

    clone(_bindings?: Map<string, Type>): Expression {
        return this; // Enum definitions are immutable, safe to share
    }

    toJS(_writer: JSWriter): void {
        // Enum definitions are for type-checking only; not emitted to JS
    }
}

// ── None literal (none:Type) ──────────────────────────────

export class NoneLit extends Expression {
    annotatedType: Type;

    constructor(token: Token, annotatedType: Type) {
        super(token.line, token.col);
        this.annotatedType = annotatedType;
        this.type = new MaybeType(annotatedType);
    }

    cascadeTypes(parent: Expression | null, valueUsed: boolean): void {
        super.cascadeTypes(parent, valueUsed);
    }

    clone(bindings?: Map<string, Type>): Expression {
        return new NoneLit(
            { line: this.line, col: this.col, text: "none", type: TokenType.None },
            substituteTypeParams(this.annotatedType, bindings ?? new Map())
        );
    }

    toJS(writer: JSWriter): void {
        writer.write("null");
    }
}

// ── Match arm types ───────────────────────────────────────

export interface SomeArm {
    kind: "some";
    binding: string;
    bindingType: Type;
    body: Expression;
}

export interface NoneArm {
    kind: "none";
    body: Expression;
}

export interface VariantArm {
    kind: "variant";
    variantName: string;
    binding: string | null;
    bindingType: Type | null;
    body: Expression;
}

export interface ElseArm {
    kind: "else";
    body: Expression;
}

export type MatchArm = SomeArm | NoneArm | VariantArm | ElseArm;

// ── Match expression ──────────────────────────────────────

export class Match extends Expression {
    /** Per-arm scope, set temporarily during each arm's cascadeTypes and cleared after. */
    private currentArmScope: Scope | null = null;

    getScope(): Scope | null {
        // During arm body cascade, return the per-arm scope so Variable references
        // inside the arm body can find the binding variable. Outside of an arm,
        // walk up to the enclosing scope.
        return this.currentArmScope ?? super.getScope();
    }

    scrutinee: Expression;
    arms: MatchArm[];

    constructor(token: Token, scrutinee: Expression, arms: MatchArm[]) {
        super(token.line, token.col);
        this.scrutinee = scrutinee;
        this.arms = arms;
    }

    getAllChildren(): Expression[] {
        const children: Expression[] = [this.scrutinee];
        for (const arm of this.arms) {
            children.push(arm.body);
        }
        return children;
    }

    /**
     * Cascade an arm body within a per-arm scope that defines its binding variable.
     * Each arm gets its own scope so bindings don't leak across arms, but the scope
     * is reachable via getScope() during the body's cascadeTypes.
     */
    private cascadeArm(
        arm: MatchArm,
        bindingName?: string,
        bindingType?: Type,
        valueUsed?: boolean
    ): void {
        const enclosingScope = this.parent?.getScope();
        this.currentArmScope = new Scope([], enclosingScope ?? undefined);
        if (bindingName && bindingType) {
            this.currentArmScope.defineVariable({
                class: "var",
                name: bindingName,
                type: bindingType,
                isMutable: false,
                isConsumed: false,
            });
        }
        // Also chain the arm body's own scope (if it has one, e.g. a Block) to the
        // per-arm scope so nested lookups reach the binding.
        const bodyScope = arm.body.getScope();
        if (bodyScope) {
            bodyScope.parent = this.currentArmScope;
        }
        arm.body.cascadeTypes(this, valueUsed ?? this.isValueUsed);
        this.currentArmScope = null;
    }

    cascadeTypes(parent: Expression | null, valueUsed: boolean): void {
        super.cascadeTypes(parent, valueUsed);

        // Cascade scrutinee
        this.scrutinee.cascadeTypes(this, true);
        const scrutType = this.scrutinee.type;

        if (scrutType instanceof MaybeType) {
            this.cascadeMaybeMatch(valueUsed, scrutType);
        } else if (scrutType instanceof EnumType) {
            this.cascadeEnumMatch(valueUsed, scrutType);
        } else {
            throw this.error(
                `match expression requires a Maybe or enum type, but found ${scrutType}`
            );
        }
    }

    private cascadeMaybeMatch(valueUsed: boolean, maybeType: MaybeType): void {
        const innerType = maybeType.innerType;
        let commonType: Type | null = null;

        for (const arm of this.arms) {
            if (arm.kind === "variant" && arm.variantName === "some") {
                arm.bindingType = innerType;
                this.cascadeArm(arm, arm.binding ?? undefined, arm.bindingType, valueUsed);
                commonType = this.updateCommonType(commonType, arm.body.type ?? "Null");
            } else if (arm.kind === "some") {
                arm.bindingType = innerType;
                this.cascadeArm(arm, arm.binding, arm.bindingType, valueUsed);
                commonType = this.updateCommonType(commonType, arm.body.type ?? "Null");
            } else if (arm.kind === "none") {
                this.cascadeArm(arm, undefined, undefined, valueUsed);
                commonType = this.updateCommonType(commonType, arm.body.type ?? "Null");
            } else if (arm.kind === "else") {
                this.cascadeArm(arm, undefined, undefined, valueUsed);
                commonType = this.updateCommonType(commonType, arm.body.type ?? "Null");
            }
        }

        const hasSome = this.arms.some(
            (a) => a.kind === "some" || (a.kind === "variant" && a.variantName === "some")
        );
        const hasNone = this.arms.some((a) => a.kind === "none" || a.kind === "else");
        const resolvedType = commonType instanceof EscapeType ? "Null" : (commonType ?? "Null");
        this.type = hasSome && hasNone ? resolvedType : "Null";
    }

    private updateCommonType(commonType: Type | null, armType: Type): Type {
        // Escape-typed arms (break/continue/return) are transparent — skip them.
        // The real type from non-Escape arms wins.
        if (armType instanceof EscapeType) return commonType ?? armType;
        if (commonType instanceof EscapeType) return armType;
        if (commonType === null) return armType;
        if (!typeEquals(commonType, armType)) {
            throw new ASTError(
                this.line,
                this.col,
                `match arms must have the same type, but found ${commonType} and ${armType}`
            );
        }
        return commonType;
    }

    private cascadeEnumMatch(valueUsed: boolean, enumType: EnumType): void {
        let commonType: Type | null = null;
        const matchedVariants = new Set<string>();

        for (const arm of this.arms) {
            if (arm.kind === "variant") {
                // Look up the variant in the enum
                const vIdx = enumType.variantIndex(arm.variantName);
                if (vIdx === -1) {
                    throw this.error(
                        `enum ${enumType.name} has no variant named "${arm.variantName}"`
                    );
                }
                if (matchedVariants.has(arm.variantName)) {
                    throw this.error(`duplicate match arm for variant "${arm.variantName}"`);
                }
                matchedVariants.add(arm.variantName);

                const vType = enumType.variantType(arm.variantName);
                arm.bindingType = vType;
                this.cascadeArm(
                    arm,
                    arm.binding ?? undefined,
                    arm.bindingType ?? undefined,
                    valueUsed
                );
                commonType = this.updateCommonType(commonType, arm.body.type ?? "Null");
            } else if (arm.kind === "else") {
                this.cascadeArm(arm, undefined, undefined, valueUsed);
                commonType = this.updateCommonType(commonType, arm.body.type ?? "Null");
            }
        }

        // If all variants are covered or there's an else, the match has the common type.
        // Otherwise it's Null.
        // If all arms are Escape (e.g. all return/break), fall back to Null.
        const allCovered = matchedVariants.size === enumType.variants.length;
        const hasElse = this.arms.some((a) => a.kind === "else");
        const resolvedType = commonType instanceof EscapeType ? "Null" : (commonType ?? "Null");
        this.type = allCovered || hasElse ? resolvedType : "Null";
    }

    clone(bindings?: Map<string, Type>): Expression {
        return new Match(
            { line: this.line, col: this.col, text: "match", type: TokenType.Match },
            this.scrutinee.clone(bindings),
            this.arms.map((arm) => {
                if (arm.kind === "some") {
                    return {
                        kind: "some" as const,
                        binding: arm.binding,
                        bindingType: null as unknown as Type,
                        body: arm.body.clone(bindings),
                    };
                } else if (arm.kind === "none") {
                    return {
                        kind: "none" as const,
                        body: arm.body.clone(bindings),
                    };
                } else if (arm.kind === "variant") {
                    return {
                        kind: "variant" as const,
                        variantName: arm.variantName,
                        binding: arm.binding,
                        bindingType: null as unknown as Type,
                        body: arm.body.clone(bindings),
                    };
                } else {
                    // else arm
                    return {
                        kind: "else" as const,
                        body: arm.body.clone(bindings),
                    };
                }
            })
        );
    }

    toJS(writer: JSWriter): void {
        const scrutType = this.scrutinee.type;
        const isMaybe = scrutType instanceof MaybeType;
        const isEnum = scrutType instanceof EnumType;

        if (isMaybe) {
            this.toJSMaybe(writer);
        } else if (isEnum) {
            this.toJSEnum(writer);
        }
    }

    private toJSMaybe(writer: JSWriter): void {
        const hasSome = this.arms.some(
            (a) => a.kind === "some" || (a.kind === "variant" && a.variantName === "some")
        );
        const hasNone = this.arms.some((a) => a.kind === "none" || a.kind === "else");
        const scrutVar = writer.uniqueName("$match$");
        const needsIIFE = this.isValueUsed && hasSome && hasNone;

        if (needsIIFE) {
            writer.write("(() => {");
            writer.iifeDepth++;
            writer.indentIn();
            writer.newLine();
        }

        writer.write(`const ${writer.safeName(scrutVar)} = `);
        this.scrutinee.toJS(writer);
        writer.write(";");
        writer.newLine();

        // Find the "some" arm (either SomeArm or VariantArm with variantName "some")
        const someArm: SomeArm | VariantArm | undefined =
            this.arms.find((a) => a.kind === "some") ??
            (this.arms.find(
                (a): a is VariantArm => a.kind === "variant" && a.variantName === "some"
            ) as VariantArm | undefined);
        const noneArm = this.arms.find((a) => a.kind === "none" || a.kind === "else") as
            | NoneArm
            | ElseArm
            | undefined;

        if (someArm) {
            writer.write(`if (${writer.safeName(scrutVar)} !== null) {`);
            writer.indentIn();
            writer.newLine();

            const bindingName =
                someArm.kind === "some" ? someArm.binding : (someArm as VariantArm).binding!;
            writer.write(`const ${writer.safeName(bindingName)} = ${writer.safeName(scrutVar)};`);
            writer.newLine();

            // Don't add `return` prefix if the arm body handles its own control flow (Escape type)
            if (this.isValueUsed && !(someArm.body.type instanceof EscapeType))
                writer.write("return ");
            someArm.body.toJS(writer);
            writer.write(";");
            writer.indentOut();
            writer.newLine();
            writer.write("}");
        }

        if (noneArm) {
            if (someArm) writer.write(" else ");
            else {
                writer.write(`if (${writer.safeName(scrutVar)} === null) `);
            }
            writer.write("{");
            writer.indentIn();
            writer.newLine();
            // Don't add `return` prefix if the arm body handles its own control flow (Escape type)
            if (this.isValueUsed && !(noneArm.body.type instanceof EscapeType))
                writer.write("return ");
            noneArm.body.toJS(writer);
            writer.write(";");
            writer.indentOut();
            writer.newLine();
            writer.write("}");
        }

        if (needsIIFE) {
            writer.indentOut();
            writer.newLine();
            writer.iifeDepth--;
            writer.write("})()");
        }
    }

    private toJSEnum(writer: JSWriter): void {
        const scrutType = this.scrutinee.type as EnumType;
        const isTagged = scrutType.isTagged;
        const scrutVar = writer.uniqueName("$match$");
        const hasElse = this.arms.some((a) => a.kind === "else");

        const needsIIFE = this.isValueUsed;

        if (needsIIFE) {
            writer.write("(() => {");
            writer.iifeDepth++;
            writer.indentIn();
            writer.newLine();
        }

        writer.write(`const ${writer.safeName(scrutVar)} = `);
        this.scrutinee.toJS(writer);
        writer.write(";");
        writer.newLine();

        if (isTagged) {
            writer.write(`switch (${writer.safeName(scrutVar)}.$tag) {`);
        } else {
            writer.write(`switch (${writer.safeName(scrutVar)}) {`);
        }
        writer.indentIn();
        writer.newLine();

        for (const arm of this.arms) {
            if (arm.kind !== "variant") continue;
            const vIdx = scrutType.variantIndex(arm.variantName);
            const tagValue = vIdx;

            writer.write(`case ${tagValue}:`);
            writer.indentIn();
            writer.newLine();

            if (arm.binding) {
                writer.write(
                    `const ${writer.safeName(arm.binding)} = ${
                        isTagged ? `${writer.safeName(scrutVar)}.$val` : writer.safeName(scrutVar)
                    };`
                );
                writer.newLine();
            }

            // Don't add `return` prefix if the arm body handles its own control flow (Escape type)
            if (this.isValueUsed && !(arm.body.type instanceof EscapeType)) writer.write("return ");
            arm.body.toJS(writer);
            writer.write(";");
            writer.newLine();

            writer.indentOut();
            writer.write("break;");
            writer.newLine();
        }

        if (hasElse) {
            writer.write("default:");
            writer.indentIn();
            writer.newLine();
            const elseArm = this.arms.find((a) => a.kind === "else")!;
            // Don't add `return` prefix if the arm body handles its own control flow (Escape type)
            if (this.isValueUsed && !(elseArm.body.type instanceof EscapeType))
                writer.write("return ");
            elseArm.body.toJS(writer);
            writer.write(";");
            writer.newLine();
            writer.indentOut();
        }

        writer.indentOut();
        writer.write("}");
        writer.newLine();

        if (needsIIFE) {
            writer.indentOut();
            writer.newLine();
            writer.iifeDepth--;
            writer.write("})()");
        }
    }
}
