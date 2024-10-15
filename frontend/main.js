document.getElementById("code").value = (
`func sayHello(name: Str): Str {
    "Hello from " + name + "!"
};

sayHello("Gema")`
)

document.getElementById("runForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const code = document.getElementById("code").value;
    const response = await fetch("/run", { method: "POST", body: code });
    document.getElementById("output").innerText = await response.text();
});