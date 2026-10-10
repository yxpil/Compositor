// Static server for the E2E suite: serves the app from src/ and exposes the
// fixture tree as one JSON document at /__e2e/fs so tests can inject it into
// the mock Tauri filesystem before the app boots.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url))); // ports/tauri
const port = Number(process.env.PORT || 4173);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

async function walk(directory, base = "") {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(directory, { withFileTypes: true });
  const tree = {};
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      tree[entry.name] = await walk(full);
    } else {
      const bytes = await readFile(full);
      // Manifests travel as JSON text (the mock parses them directly); assets as base64.
      tree[entry.name] = entry.name === "manifest.json" ? bytes.toString("utf8") : bytes.toString("base64");
    }
  }
  return tree;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://localhost:${port}`);
  try {
    if (url.pathname === "/__e2e/fs") {
      const tree = await walk(join(root, "e2e", "fixtures", "projects"));
      // Wrapped under "mock" so the virtual root path /mock resolves (specs use /mock).
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ projects: { mock: tree } }));
      return;
    }
    if (url.pathname === "/") {
      // Inject the Tauri IPC mock before the app's module script runs. The spec's
      // addInitScript (which sets window.__E2E_FS) always runs before page scripts.
      const html = (await readFile(join(root, "src", "index.html"), "utf8"))
        .replace("<body>", '<body>\n  <script src="/e2e/mock-tauri.js"></script>');
      response.writeHead(200, { "content-type": MIME[".html"] });
      response.end(html);
      return;
    }
    const relative = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
    const base = relative.startsWith("src") || relative.startsWith("e2e") ? root : join(root, "src");
    const file = join(base, relative);
    if (!file.startsWith(base)) throw new Error("forbidden");
    const info = await stat(file);
    if (!info.isFile()) throw new Error("not a file");
    const bytes = await readFile(file);
    response.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    response.end(bytes);
  } catch {
    response.writeHead(404);
    response.end("not found");
  }
});

server.listen(port, () => {
  console.log(`E2E server on http://localhost:${port}`);
});
