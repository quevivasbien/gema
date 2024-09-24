import { parse } from "./src/parse";
import { scan } from "./src/scan";
import { writeJS } from "./src/write-js";

export { parse, scan, writeJS };

const text = `
x = y = { 3 };
y = 4
`;

const tokens = scan(text);
console.log(tokens);
const { ast, errors } = parse(tokens);
console.log(ast);
if (errors.length > 0) {
    console.log("Encountered error(s) in parsing:");
    errors.forEach((e) => console.log(e));
} else {
    const source = writeJS(ast);
    console.log(source);
    console.log(eval(source));
}
