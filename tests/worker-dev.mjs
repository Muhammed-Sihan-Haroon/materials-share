// Runs the real worker.js under Node with an in-memory KV, for testing.
import http from "node:http";
import { pathToFileURL } from "node:url";

const workerPath = process.argv[2];
const { default: worker } = await import(pathToFileURL(workerPath).href);

const store = new Map();
const stats = { puts: 0 };
async function bytes(v) {
  if (v && typeof v.getReader === "function") {
    const chunks = [];
    for await (const c of v) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks);
  }
  if (typeof v === "string") return Buffer.from(v);
  if (v instanceof ArrayBuffer) return Buffer.from(new Uint8Array(v));
  return Buffer.from(v);
}
const KV = {
  async get(k, opt) {
    const e = store.get(k);
    if (!e) return null;
    const type = (opt && opt.type) || "text";
    if (type === "stream") return new Blob([e.value]).stream();
    if (type === "arrayBuffer") return e.value.buffer.slice(e.value.byteOffset, e.value.byteOffset + e.value.length);
    return e.value.toString();
  },
  async put(k, v, opt = {}) {
    const b = await bytes(v);
    if (b.length > 25 * 1024 * 1024) throw new Error("KV value too large");
    if (opt.metadata && JSON.stringify(opt.metadata).length > 1024) throw new Error("KV metadata too large");
    stats.puts++;
    store.set(k, { value: b, metadata: opt.metadata || null });
  },
  async getWithMetadata(k, opt) {
    const e = store.get(k);
    if (!e) return { value: null, metadata: null };
    return { value: await KV.get(k, opt), metadata: e.metadata };
  },
  async delete(k) { store.delete(k); },
  async list({ prefix = "" } = {}) {
    const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name, metadata: store.get(name).metadata }));
    return { keys, list_complete: true };
  },
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.startsWith("https://api.github.com/repos/")) {
    const h = new Headers(init.headers);
    const good = h.get("Authorization") === "Bearer github_pat_TEST" && url.endsWith("/repos/me/materials");
    return new Response(JSON.stringify(good ? { full_name: "me/materials", permissions: { push: true } } : { message: "Bad credentials" }), { status: good ? 200 : 401 });
  }
  return realFetch(input, init);
};

const aiState = { last: null, mode: "ok", calls: 0 };
const AI = {
  async run(model, input) {
    aiState.calls++;
    aiState.last = { model, input };
    if (aiState.mode === "quota") throw new Error("3036: You have used up your daily free allocation of 10,000 neurons");
    const body = {
      criteria: [
        { status: "Met", reason: "Both joins are written correctly." },
        { status: "Partly met", reason: "Q3 result explained only briefly." },
        { status: "not yet", reason: "Q3 query is untidy." },
      ],
      mark: 7.3,
      comment: "You explained INNER and LEFT JOIN clearly, and your first two queries are correct.\n\nYour last query works but is hard to read. Put each clause on its own line and keep keywords in capitals.\n\nNext time, add a sentence on why the LEFT JOIN returns NULLs.",
    };
    return { response: "Here is my assessment:\n```json\n" + JSON.stringify(body) + "\n```" };
  },
};
const env = { KV, AI, REPO: "me/materials", SITE_URL: "http://localhost:8765", MAX_MB: "20" };
const SKIP = new Set(["host", "connection", "transfer-encoding", "keep-alive"]);

http.createServer(async (req, res) => {
  if (req.url === "/__ai") { res.end(JSON.stringify(aiState)); return; }
  if (req.url.startsWith("/__aimode=")) { aiState.mode = req.url.split("=")[1]; res.end("ok"); return; }
  if (req.url === "/__store") {
    res.end(JSON.stringify([...store.entries()].map(([k, v]) => ({ k, size: v.value.length, meta: v.metadata, sample: v.value.subarray(0, 4000).toString("latin1") }))));
    return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (!SKIP.has(k)) headers.set(k, Array.isArray(v) ? v.join(",") : v);
  const init = { method: req.method, headers };
  if (!["GET", "HEAD"].includes(req.method) && body.length) { init.body = body; init.duplex = "half"; }
  // optional slow responses, to reproduce timing seen on slower CI machines
  const slow = Number(process.env.SLOW_MS || 0);
  if (slow && req.url.startsWith("/admin/")) await new Promise((r) => setTimeout(r, slow));
  const r = await worker.fetch(new Request("http://localhost:8787" + req.url, init), env);
  const out = Buffer.from(await r.arrayBuffer());
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(out);
}).listen(8787, () => console.log("worker on 8787"));
