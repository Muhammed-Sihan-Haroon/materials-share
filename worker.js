/**
 * Materials Share — submissions service (Cloudflare Worker, free plan)
 *
 * Receives student submissions and serves released feedback. Everything it stores is
 * already encrypted in the browser: submissions with the lecturer's public key, feedback
 * with each student's receipt code. This service never sees readable student work.
 *
 * Setup (see README):
 *   Binding:   KV namespace, variable name  KV
 *   Variables: REPO      e.g. H-Sihan/Materials-Share
 *              SITE_URL  e.g. https://h-sihan.github.io/Materials-Share
 *              MAX_MB    optional, default 20 (Cloudflare KV limit is 25)
 *
 * Lecturer endpoints (/admin/*) require the lecturer's GitHub token; it is accepted only if
 * its owner can push to REPO.
 */
const HEX = /^[0-9a-f]{32}$/;
const META = /^[A-Za-z0-9+/=]{1,900}$/;
const authCache = new Map();

export default {
  async fetch(request, env) {
    let origin = "*";
    try { origin = new URL(env.SITE_URL).origin; } catch {}
    const cors = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Meta",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };
    const reply = (body, status = 200, type = "application/json") =>
      new Response(body, { status, headers: { ...cors, "Content-Type": type, "Cache-Control": "no-store" } });
    const json = (obj, status = 200) => reply(JSON.stringify(obj), status);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      if (!env.KV || !env.SITE_URL || !env.REPO) {
        return json({ error: "Service not configured: it needs a KV binding called KV, plus SITE_URL and REPO variables." }, 500);
      }
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const q = url.searchParams;
      const m = request.method;

      if (path === "/" && m === "GET") return reply("Materials Share submissions service is running.", 200, "text/plain");
      if (path === "/submit" && m === "POST") return await submit(request, env, q, json);

      const fb = path.match(/^\/feedback\/([0-9a-f]{32})$/);
      if (fb && m === "GET") {
        const v = await env.KV.get("f:" + fb[1], { type: "stream" });
        return v ? reply(v, 200, "application/octet-stream") : json({ error: "not found" }, 404);
      }

      if (path.startsWith("/admin/")) {
        await requireLecturer(request, env);
        return await admin(path, m, q, request, env, reply, json);
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: e.message || "error" }, e.status || 500);
    }
  },
};

function fail(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function hex(q, name) {
  const v = q.get(name) || "";
  if (!HEX.test(v)) throw fail(400, "bad " + name);
  return v;
}

function bodyLength(request) {
  return Number(request.headers.get("Content-Length") || 0);
}

async function submit(request, env, q, json) {
  const a = hex(q, "a");
  const r = hex(q, "r");
  const maxMb = Number(env.MAX_MB) || 20;
  const len = bodyLength(request);
  if (!len) throw fail(411, "Missing upload size.");
  if (len > maxMb * 1048576 + 65536) throw fail(413, `Upload too large (max ${maxMb} MB).`);
  const meta = request.headers.get("X-Meta") || "";
  if (!META.test(meta)) throw fail(400, "bad meta");

  const site = env.SITE_URL.replace(/\/+$/, "");
  const res = await fetch(`${site}/a/${a}/meta.json`, { cf: { cacheTtl: 30 } });
  if (res.status === 404) throw fail(404, "Activity not found. If it was only just created, try again in a minute.");
  if (!res.ok) throw fail(502, "Couldn't check the activity. Try again.");
  const act = await res.json();
  const late = !!(act.deadline && Date.now() > Date.parse(act.deadline));
  if (act.closed || (late && !act.late)) throw fail(403, "Submissions for this activity are closed.");

  const t = Date.now();
  await env.KV.put(`s:${a}:${r}`, request.body, { metadata: { t, n: len, late, m: meta } });
  return json({ ok: true, t, late }, 201);
}

async function requireLecturer(request, env) {
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) throw fail(401, "Missing GitHub token.");
  const cached = authCache.get(token);
  if (cached && cached > Date.now()) return;
  const r = await fetch(`https://api.github.com/repos/${env.REPO}`, {
    headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "User-Agent": "materials-share-worker" },
  });
  if (!r.ok) throw fail(401, "GitHub token rejected.");
  const repo = await r.json();
  if (!repo.permissions || !repo.permissions.push) throw fail(403, `This token's owner can't write to ${env.REPO}.`);
  authCache.set(token, Date.now() + 5 * 60 * 1000);
}

async function listAll(env, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await env.KV.list({ prefix, cursor });
    out.push(...page.keys);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

async function admin(path, m, q, request, env, reply, json) {
  const small = async () => {
    if (bodyLength(request) > 1048576) throw fail(413, "too large");
    return request.arrayBuffer();
  };

  if (path === "/admin/ping") return json({ ok: true });

  if (path === "/admin/list" && m === "GET") {
    const a = hex(q, "a");
    const strip = (k) => ({ r: k.name.slice(35), ...(k.metadata || {}) }); // "s:" + 32 + ":" = 35
    const subs = (await listAll(env, `s:${a}:`)).map(strip);
    const drafts = (await listAll(env, `d:${a}:`)).map(strip);
    return json({ subs, drafts });
  }

  if (path === "/admin/sub") {
    const a = hex(q, "a"), r = hex(q, "r");
    if (m === "GET") {
      const v = await env.KV.get(`s:${a}:${r}`, { type: "stream" });
      return v ? reply(v, 200, "application/octet-stream") : json({ error: "not found" }, 404);
    }
    if (m === "DELETE") {
      await Promise.all([env.KV.delete(`s:${a}:${r}`), env.KV.delete(`d:${a}:${r}`), env.KV.delete(`f:${r}`)]);
      return json({ ok: true });
    }
  }

  if (path === "/admin/draft") {
    const a = hex(q, "a"), r = hex(q, "r");
    if (m === "GET") {
      const v = await env.KV.get(`d:${a}:${r}`, { type: "stream" });
      return v ? reply(v, 200, "application/octet-stream") : json({ error: "not found" }, 404);
    }
    if (m === "PUT") {
      await env.KV.put(`d:${a}:${r}`, await small(), { metadata: { t: Date.now(), rel: q.get("rel") === "1" } });
      return json({ ok: true });
    }
  }

  if (path === "/admin/feedback") {
    const r = hex(q, "r");
    if (m === "PUT") {
      await env.KV.put(`f:${r}`, await small());
      return json({ ok: true });
    }
    if (m === "DELETE") {
      await env.KV.delete(`f:${r}`);
      return json({ ok: true });
    }
  }

  return json({ error: "not found" }, 404);
}
