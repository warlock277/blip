import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, extname } from "node:path";
import { existsSync, statSync, createReadStream } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));

/** Minimal content-type map for the files the dashboard serves. */
const MIME: Record<string, string> = {
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Dev-only middleware that serves `/data/*` requests from the repo-root `/data`
 * directory (written by the orchestrator / seed script). This mirrors
 * production, where the deploy step copies `/data` into the build output so the
 * same `/data/...` fetch paths resolve. When the repo-root `/data` is absent we
 * fall through to Vite's static handling of `public/data/*` (bundled demo data).
 */
function serveRepoData(): Plugin {
  const dataRoot = resolve(here, "../../data");
  return {
    name: "blip-serve-repo-data",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        if (!url.startsWith("/data/")) return next();

        // Strip query string and decode the path safely.
        const clean = decodeURIComponent(url.split("?")[0] ?? "");
        const rel = clean.replace(/^\/data\//, "");

        // Guard against path traversal.
        const filePath = join(dataRoot, rel);
        if (!filePath.startsWith(dataRoot)) {
          res.statusCode = 403;
          res.end("Forbidden");
          return;
        }

        if (!existsSync(filePath) || !statSync(filePath).isFile()) {
          // Defer to Vite's `public/` static serving (bundled demo data).
          return next();
        }

        const type = MIME[extname(filePath)] ?? "application/octet-stream";
        res.setHeader("Content-Type", type);
        res.setHeader("Cache-Control", "no-cache");
        createReadStream(filePath).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), serveRepoData()],
  resolve: {
    alias: {
      "@": resolve(here, "src"),
      "@blip/shared": resolve(here, "../shared/src/index.ts"),
    },
  },
  server: {
    port: 5173,
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          // Charts pull in a large dependency tree — isolate so it only loads
          // on the site-detail route (which is lazy-loaded).
          recharts: ["recharts"],
          react: ["react", "react-dom", "react-router-dom"],
        },
      },
    },
  },
});
