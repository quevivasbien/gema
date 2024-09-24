import { parse } from "./src/parse";
import { scan } from "./src/scan";
import { writeJS } from "./src/write-js";

export { parse, scan, writeJS };

const text = `
x = 2

zeroIfOdd = if (x % 2 == 0) {
    x
} else {
    0
}

# zeroIfOdd = 2


x = 3

zeroIfOdd = if (x % 2 == 0) {
    x
} else {
    0
}

# zeroIfOdd = 0
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
