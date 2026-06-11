import { serve } from "bun";
import { join } from "path";

serve({
    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/") {
            return new Response(Bun.file(join(__dirname, "frontend", "index.html")), {
                headers: { "content-type": "text/html" },
            });
        }
        if (request.method === "GET" && url.pathname === "/bundle.js") {
            return new Response(Bun.file(join(__dirname, "frontend", "dist", "bundle.js")), {
                headers: { "content-type": "application/javascript" },
            });
        }
        if (request.method === "GET") {
            const filename = url.pathname.slice(1);
            const file = Bun.file(join(__dirname, "frontend", filename));
            if (await file.exists()) {
                return new Response(file);
            }
            return new Response("Not found", { status: 404 });
        }

        return new Response("Not found", { status: 404 });
    },
    port: 3000,
});
