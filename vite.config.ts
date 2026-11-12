import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { defineConfig, type Plugin } from "vite";

// The local test corpus (corpus/, gitignored, `npm run corpus`) is served by the dev
// server only, at /corpus/..., with a listing at /corpus-index.json. It never reaches the
// built demo: some of it may not be redistributed.
const corpusDir = new URL("./corpus/", import.meta.url).pathname;
function corpus(): Plugin {
  const list = (d: string): string[] =>
    readdirSync(d).flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? list(p) : /\.(musicxml|xml|mxl|mscz|mscx|mid|midi)$/i.test(n) ? [relative(corpusDir, p)] : [];
    });
  return {
    name: "scoredit-corpus",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = decodeURIComponent((req.url ?? "").split("?")[0]);
        try {
          if (url === "/corpus-index.json") {
            res.setHeader("content-type", "application/json");
            return res.end(JSON.stringify(list(corpusDir).sort()));
          }
          if (url.startsWith("/corpus/") && !url.includes("..")) return res.end(readFileSync(join(corpusDir, url.slice(8))));
        } catch {
          res.statusCode = 404;
          return res.end();
        }
        next();
      });
    },
  };
}

// The demo lives in demo/; build it to demo-dist/ for GitHub Pages. base "./" so it
// works from any repo-subpath.
export default defineConfig({
  root: "demo",
  base: "./",
  plugins: [corpus()],
  server: { host: "127.0.0.1" },
  build: { outDir: "../demo-dist", emptyOutDir: true },
  test: {
    root: ".",
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
