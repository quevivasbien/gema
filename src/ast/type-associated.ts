import type { Token } from "../tokens";
import type { JSWriter } from "../write-js";
import { findCaller } from "./caller-resolution";
import { Call } from "./calls";
import { Expression } from "./expression";
import { getType, type TemplateTypes, type Type } from "./types";
import { Variable } from "./variable";

/**
 * An expression like Foo::bar(baz) or Foo::bim
 * This is either an enum instantiation or a "type-associated function"
 */
export class TypeAssociatedExpr extends Expression {
    associatedType: Type;
    innerExpr: Variable | Call;

    toJSHelper: ((writer: JSWriter) => void) | null = null;

    constructor(typeToken: Token, templateTypes: TemplateTypes, innerExpr: Expression) {
        super(typeToken.line, typeToken.col);
        const type = getType(typeToken.text, templateTypes);
        if (type === null) {
            throw this.error("Invalid type name before '::'");
        }
        if (!(innerExpr instanceof Variable) && !(innerExpr instanceof Call)) {
            throw this.error(
                "Type-associated expression must be either a variable or a function call"
            );
        }
        this.associatedType = type;
        this.innerExpr = innerExpr;
    }

    getAllChildren(): Expression[] {
        return [this.innerExpr];
    }

    cascadeTypes(parent: Expression | null, valueUsed: boolean): void {
        super.cascadeTypes(parent, valueUsed);

        // Handle case where innerExpr is a Call
        // Here we basically mimic the way cascadeTypes works for a Call
        if (this.innerExpr instanceof Call) {
            // TODO: Might need to pre-fill lambda params here
            for (let i = 0; i < this.innerExpr.args.length; i++) {
                const arg = this.innerExpr.args[i];
                arg.cascadeTypes(this, true);
                if (arg.type === null) {
                    throw this.error(`unable to resolve type of argument ${i + 1} in call`);
                }
            }

            const { error, result } = findCaller(
                this,
                this.innerExpr.name,
                this.innerExpr.args,
                this.associatedType
            );
            if (error !== null) {
                throw this.error(error);
            }

            this.toJSHelper = result.toJS;
            this.type = result.returnType;

            // TODO: Might need to resolve lambda params here
        }
        // For now, the only other thing this can be is an enum instantiation (with no contents)
        else if (this.innerExpr instanceof Variable) {
            const enumMatch = this.getScope()?.lookupEnum(this.associatedType, this.innerExpr.name);
            if (!enumMatch) {
                throw this.error(`unable to resolve type of enum instantiation`);
            }
            this.type = this.associatedType;
            const literalValue = enumMatch.isTaggedUnion
                ? `{ $tag: ${enumMatch.variantIndex}, $val: null }`
                : enumMatch.variantIndex.toString();
            this.toJSHelper = (writer) => writer.write(literalValue);
        }
    }

    toJS(writer: JSWriter) {
        if (!this.toJSHelper) {
            throw new Error(
                `missing compilation helper for call to ${this.associatedType.toString()}::${this.innerExpr.name} -- this should have been resolved during type checking`
            );
        }
        this.toJSHelper(writer);
    }
}
