import { parse } from "./src/parse";
import { scan } from "./src/scan";

const document = `
1.22  + 1.23  + 8 + 3.13
"hello"
`;

const tokens = scan(document);

console.log(tokens);

const { ast, errors } = parse(tokens);
if (errors.length > 0) {
    console.log(errors);
}
console.log(ast);