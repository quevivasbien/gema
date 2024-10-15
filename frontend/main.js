const code = document.getElementById("code");

// Set default code text
code.innerText = (
    `func sayHello(name: Str): Str {
    "Hello from " + name + "!"
};

sayHello("Gema")`
);

fetch("/format", { method: "POST", body: code.innerText }).then(async (response) => {
    code.innerHTML = await response.text();
});

function insertChars(chars) {
    const selection = window.getSelection();
    if (selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        range.deleteContents(); // Optionally delete selected text
        const spaceNode = document.createTextNode(chars);
        range.insertNode(spaceNode); // Insert the spaces

        // Move the cursor after the inserted spaces
        range.setStartAfter(spaceNode);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
    }
}

// Capture key presses
code.addEventListener("keydown", (event) => {
    if (event.key === "Tab") {
        event.preventDefault();
        insertChars("    ");
    }
    if (event.key === "Enter") {
        event.preventDefault();
        if (event.ctrlKey) {
            // If control key is also pressed, run code
            run();
        } else {
            // Otherwise, insert new line
            insertChars("\n");
        }
    }
});

function getCursorPositionWithinCode() {
    const selection = window.getSelection();
    if (selection.rangeCount === 0) {
        return 0;
    }
    const range = selection.getRangeAt(0);
    const startNode = range.startContainer;
    let offset = 0;
    for (let i = 0; i < code.childNodes.length; i++) {
        let node = code.childNodes[i];
        while (node !== null && node.nodeType !== Node.TEXT_NODE) {
            node = node.firstChild;
        }
        if (node === null) {
            continue;
        }
        if (node === startNode) {
            return offset + range.startOffset;
        } else {
            offset += node.textContent.length;
        }
    }
    return offset;
}

function setCursorPositionWithinCode(charIndex) {
    let charCount = 0;
    let containingNode = null;
    let offsetWithinNode = 0;
    for (let i = 0; i < code.childNodes.length; i++) {
        let node = code.childNodes[i];
        while (node.nodeType !== Node.TEXT_NODE) {
            node = node.firstChild;
        }
        if (charCount + node.textContent.length >= charIndex) {
            containingNode = node;
            offsetWithinNode = charIndex - charCount;
            break;
        }
        charCount += node.textContent.length;
    }

    const range = document.createRange();
    range.setStart(containingNode, offsetWithinNode);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
}

code.addEventListener("input", async (event) => {
    let charIndex = getCursorPositionWithinCode();

    // Replace code with formatted version
    const text = code.innerText;
    const formatted = await fetch("/format", { method: "POST", body: text });
    code.innerHTML = await formatted.text();

    setCursorPositionWithinCode(charIndex);
});

async function run() {
    const code = document.getElementById("code").innerText;
    const response = await fetch("/run", { method: "POST", body: code });
    document.getElementById("output").innerText = await response.text();
}

// Compile on form submit
document.getElementById("button-run").addEventListener("click", (event) => {
    event.preventDefault();
    run();
});