// app/build.ts — build the chat SPA with content-hashed asset filenames + a version
// stamp, then generate public/app/index.html pointing at the hashed files.
//
// Why: PWAs go stale because a fixed asset URL (main.js) sits in an HTTP/browser cache.
// Content-hashing means every deploy yields a NEW url (main-<hash>.js) that no cache has,
// while index.html is served no-store so it always points at the current hash. That alone
// makes "just rebuild" ship an update to any fresh load. For already-open tabs / installed
// PWAs, the client polls /app/api/version (this build id) and offers a reload. Structure
// copied from FTA-Buddy's version-poll + reload-toast, minus its cache-first service worker
// (we deliberately don't precache the shell, so there's nothing to go stale).
import { join, basename } from "path";
import { rmSync, mkdirSync, readFileSync, writeFileSync } from "fs";

const APP = import.meta.dir; // app/
const OUT = join(APP, "..", "public", "app");
const ASSETS = join(OUT, "assets");

// clean old hashed files so stale bundles don't pile up
rmSync(ASSETS, { recursive: true, force: true });
mkdirSync(ASSETS, { recursive: true });

const res = await Bun.build({
  entrypoints: [join(APP, "main.tsx")],
  outdir: ASSETS,
  minify: true,
  target: "browser",
  naming: "[name]-[hash].[ext]",
});
if (!res.success) {
  for (const l of res.logs) console.error(l);
  process.exit(1);
}
const jsOut = res.outputs.find((o) => o.path.endsWith(".js"));
if (!jsOut) {
  console.error("build produced no .js output");
  process.exit(1);
}
const mainFile = basename(jsOut.path); // main-<hash>.js
const buildId = mainFile.replace(/^main-/, "").replace(/\.js$/, ""); // the content hash

// hash + emit the stylesheet the same way (it isn't part of the JS graph)
const css = readFileSync(join(APP, "styles.css"));
const cssHash = Bun.hash(css).toString(16).slice(0, 10);
const cssFile = `styles-${cssHash}.css`;
writeFileSync(join(ASSETS, cssFile), css);

// the version the running client polls; read fresh by /app/api/version, so a rebuild alone
// ships an update (no service restart needed)
writeFileSync(join(OUT, "version.txt"), buildId + "\n");

// generate the served index.html from the template, pointing at the hashed files
let html = readFileSync(join(APP, "index.html"), "utf8");
html = html.replaceAll("%MAIN%", `/app/assets/${mainFile}`).replaceAll("%STYLES%", `/app/assets/${cssFile}`);
writeFileSync(join(OUT, "index.html"), html);

console.log(`chat app built: ${mainFile} + ${cssFile}  (build=${buildId})`);
