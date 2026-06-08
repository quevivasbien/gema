const code = document.getElementById('code');

// Set default code text
const presets = {
  hello: `func sayHello(name: Str): Str {
    "Hello from " + name + "!"
};

sayHello("Gema")`,
  recursiveFactorial: `func factorial(n: Int): Int {
    if (n <= 1) {
        1
    } else {
        n * factorial(n - 1)
    }
};

@map(factorial, range(0, 5))`,
  iterativeFactorial: `func factorial(n: Int): Int {
    if (n < 1) {
        1
    } else {
        reduce(
            func(acc: Int, x: Int) { acc * x },
            range(1, n),
            1
        )
    }
};

@map(factorial, range(0, 5))`,
};

code.value = presets[document.getElementById('select-preset').value];
document.getElementById('select-preset').addEventListener('change', (event) => {
  code.value = presets[event.target.value];
});

function insertChars(chars) {
  const selectionStart = code.selectionStart;
  const selectionEnd = code.selectionEnd;
  code.value = code.value.substring(0, selectionStart) + chars + code.value.substring(selectionEnd);
  code.selectionStart = selectionStart + chars.length;
  code.selectionEnd = selectionStart + chars.length;
}

// Capture key presses
code.addEventListener('keydown', (event) => {
  if (event.key === 'Tab') {
    event.preventDefault();
    insertChars('    ');
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    if (event.ctrlKey) {
      // If control key is also pressed, run code
      run();
    } else {
      // Otherwise, insert new line, preserving current indent level
      const currentLine = code.value.slice(0, code.selectionStart).split('\n').pop();
      const indent = currentLine.match(/^\s*/)[0];
      insertChars('\n' + indent);
    }
  }
  if (event.key === 'Backspace') {
    // Special behavior in case of tab before current cursor position
    if (code.selectionStart === code.selectionEnd && code.value.slice(code.selectionStart - 4, code.selectionStart) === '    ') {
      const newSstart = code.selectionStart - 4;
      event.preventDefault();
      code.value = code.value.slice(0, newSstart) + code.value.slice(code.selectionStart);
      code.selectionStart = code.selectionEnd = newSstart;
    }
  }
});

async function run() {
  const code = document.getElementById('code').value;
  const response = await fetch('/run', { method: 'POST', body: code });
  const { js, result } = await response.json();
  document.getElementById('js-compiled').innerText = js;
  document.getElementById('output').innerText = result;
}

// Compile on form submit
document.getElementById('button-run').addEventListener('click', (event) => {
  event.preventDefault();
  run();
});
