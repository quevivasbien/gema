import type { Token } from "../tokens";
import type { JSWriter } from "../write-js";
import { findCaller } from "./caller-resolution";
import { Call } from "./calls";
import { Expression } from "./expression";
import { Variable } from "./nodes";
import { getType, type TemplateTypes, type Type } from "./types";

/**
 * An expression like Foo::bar(baz) or Foo::bim
 * This is either an enum instantiation or a "type-associated function"
 */
export class TypeAssociatedExpr extends Expression {
    associatedType: Type;
    innerExpr: Variable | Call;

    toJSHelper: ((writer: JSWriter) => void) | null = null;

    constructor(variableToken: Token, templateTypes: TemplateTypes, innerExpr: Expression) {
        super(variableToken.line, variableToken.col);
        const type = getType(variableToken.text, templateTypes);
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
            this.type =
                result.kind === "variable" ? result.returnType : result.callerType.returnType;

            // TODO: Might need to resolve lambda params here
        }
        // For now, the only other thing this can be is an enum instantiation (with no contents)
        else if (this.innerExpr instanceof Variable) {
            // TODO!
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
