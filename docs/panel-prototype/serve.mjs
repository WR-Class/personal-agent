// Zero-dependency static file server for previewing this prototype in DSH's
// built-in browser, which — like most Electron webviews — refuses file://
// navigation under its security policy even when the file genuinely exists on
// disk. This is throwaway tooling for viewing a mockup, not part of the
// personal-agent product; it deliberately lives beside the prototype it
// serves rather than in src/.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.argv[2] ?? 4173);

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript" };

const server = createServer(async (req, res) => {
  const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
  const relative = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const resolved = normalize(join(root, relative));
  if (!resolved.startsWith(root)) { res.writeHead(403); res.end("forbidden"); return; }
  try {
    const data = await readFile(resolved);
    res.writeHead(200, { "content-type": MIME[extname(resolved)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404); res.end("not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`serving ${root} at http://127.0.0.1:${port}/`);
});
