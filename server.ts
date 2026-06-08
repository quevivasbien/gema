import { serve } from "bun";
import { join } from "path";
import { compile } from ".";

function compileAndRun(code: string): { js: string, result: string } {
    const { errors, js } = compile(code);
    if (errors) {
        return { js: "", result: errors.join("\n") };
    }
    const result = eval(js);
    return { js, result: String(result) };
}

serve({
    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/") {
            return new Response(Bun.file(join(__dirname, 'frontend', 'index.html')));
        }
        if (request.method === "GET") {
            const filename = url.pathname.slice(1);
            return new Response(Bun.file(join(__dirname, 'frontend', filename)));
        }
        if (request.method === "POST" && url.pathname === "/run") {
            const body = await request.text();
            const result = compileAndRun(body);
            return new Response(JSON.stringify(result), { headers: { "content-type": "text/json" } });
        }

        return new Response("Not found", { status: 404 });
    },
    port: 3000
});