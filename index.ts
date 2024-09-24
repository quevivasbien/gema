import { parse } from "./src/parse";
import { scan } from "./src/scan";
import { writeJS } from "./src/write-js";

export { parse, scan, writeJS };

const text = `
1 >= 2
`;

const tokens = scan(text);
console.log(tokens);
const { ast, errors } = parse(tokens);
const source = writeJS(ast);
console.log(source);

console.log(eval(source));