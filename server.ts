import { serve } from "bun";
import { join } from "path";
import { compile } from ".";

function compileAndRun(code: string): string {
    const { errors, js } = compile(code);
    if (errors) {
        return errors.join("\n");
    }
    const result = eval(js);
    return String(result);
}

serve({
    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/") {
            return new Response(Bun.file(join(__dirname, 'frontend', 'index.html')));
        }
        if (request.method === "GET" && url.pathname.startsWith("/main.js")) {
            return new Response(Bun.file(join(__dirname, 'frontend', 'main.js')));
        }
        if (request.method === "POST" && url.pathname === "/run") {
            const body = await request.text();
            const result = compileAndRun(body);
            return new Response(result, { headers: { "content-type": "text/plain" } });
        }

        return new Response("Not found", { status: 404 });
    },
    port: 3000
});