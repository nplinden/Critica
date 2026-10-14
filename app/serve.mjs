// Minimal static server: the app (app/) at the site root and the engine
// (pkg/) at /pkg/, where the pages' relative ../pkg/ imports resolve.
// Usage: node app/serve.mjs [port]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.argv[2] ?? 1948);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".css": "text/css",
};

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  // Old links: the app used to live under /examples/.
  if (path === "/examples" || path.startsWith("/examples/")) return res.writeHead(301, { location: path.slice("/examples".length) || "/" }).end();
  const root = join(repo, path.startsWith("/pkg/") ? "" : "app");
  const file = normalize(join(root, path.endsWith("/") ? `${path}index.html` : path));
  if (!file.startsWith(root)) return res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`Critica: http://localhost:${port}/`));
