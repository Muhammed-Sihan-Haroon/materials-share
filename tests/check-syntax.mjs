// Fast static checks, run before the browser tests:
//  - every JavaScript file and every inline <script> parses
//  - pages only load scripts from this site (no CDNs), and every page sets a script policy
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const ok = (msg) => console.log("ok   " + msg);
const bad = (msg) => { problems.push(msg); console.log("FAIL " + msg); };

const jsFiles = [...readdirSync(root).filter((f) => f.endsWith(".js")), "tests/worker-dev.mjs"];
for (const f of jsFiles) {
  try { execFileSync(process.execPath, ["--check", join(root, f)], { stdio: "pipe" }); ok(`${f} parses`); }
  catch (e) { bad(`${f}: ${String(e.stderr || e.message).split("\n").slice(0, 4).join(" ")}`); }
}

const pages = readdirSync(root).filter((f) => f.endsWith(".html"));
for (const f of pages) {
  const html = readFileSync(join(root, f), "utf8");
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  inline.forEach((code, i) => {
    try { new vm.Script(code, { filename: `${f} <script #${i + 1}>` }); ok(`${f} inline script ${i + 1} parses`); }
    catch (e) { bad(`${f} inline script ${i + 1}: ${e.message}`); }
  });
  const external = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]).filter((s) => /^(https?:)?\/\//.test(s));
  external.length ? bad(`${f} loads scripts from other sites: ${external.join(", ")}`) : ok(`${f} loads scripts only from this site`);
  /Content-Security-Policy/.test(html) ? ok(`${f} sets a script policy`) : bad(`${f} has no Content-Security-Policy`);
}

for (const f of [...pages, ...jsFiles]) {
  const text = readFileSync(join(root, f), "utf8");
  if (/cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com/.test(text)) bad(`${f} still references a CDN`);
}

if (!/salt:\s*"[0-9a-f]{16,}"/.test(readFileSync(join(root, "config.js"), "utf8"))) bad("config.js has no salt");

console.log(problems.length ? `\n${problems.length} problem(s)` : "\nAll static checks passed");
process.exit(problems.length ? 1 : 0);
