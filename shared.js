// Shared crypto and data formats, used by every page.
//
// Codes (8 chars) are stretched with PBKDF2 into a folder id + an AES-256 key.
// One code box serves three kinds of code, told apart by where the id exists:
//   s/<id>/   materials share        (GitHub Pages)
//   a/<id>/   activity to submit to  (GitHub Pages)
//   f:<id>    released feedback      (submissions service)
//
// Student submissions are sealed to the lecturer's public key (ECDH P-256 + AES-GCM).
// The lecturer's private key is stored in the repo wrapped by a passphrase-derived key.
(function (global) {
  "use strict";
  const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
  const LEN = 8;
  const ITER = 400000;
  const VAULT_ITER = 600000;
  const EC = { name: "ECDH", namedCurve: "P-256" };
  const cr = global.crypto || globalThis.crypto;
  const subtle = cr.subtle;
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const rnd = (n) => cr.getRandomValues(new Uint8Array(n));

  const normalise = (s) => (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const pretty = (c) => c.slice(0, 4) + "-" + c.slice(4);
  const valid = (c) => c.length === LEN && [...c].every((ch) => ALPHABET.includes(ch));

  function newCode() {
    let out = "";
    while (out.length < LEN) {
      for (const b of rnd(16)) {
        if (b < 248 && out.length < LEN) out += ALPHABET[b % ALPHABET.length]; // unbiased
      }
    }
    return out;
  }

  // ---------- encoding
  function b64e(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function b64d(str) {
    const bin = atob(String(str).replace(/\s/g, ""));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const toJSON = (bytes) => JSON.parse(dec.decode(bytes));
  const fromJSON = (obj) => enc.encode(JSON.stringify(obj));
  const text = (bytes) => dec.decode(bytes);

  // ---------- symmetric
  function importAes(raw) {
    return subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  }

  async function derive(code, salt) {
    const base = await subtle.importKey("raw", enc.encode(code), "PBKDF2", false, ["deriveBits"]);
    const bits = new Uint8Array(await subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: ITER }, base, 384));
    const id = Array.from(bits.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
    const raw = bits.slice(16, 48);
    return { id, raw, key: await importAes(raw) };
  }

  async function seal(key, data) {
    const iv = rnd(12);
    const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, key, data));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv);
    out.set(ct, 12);
    return out;
  }

  async function unseal(key, buf) {
    const b = new Uint8Array(buf);
    return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: b.slice(0, 12) }, key, b.slice(12)));
  }

  // ---------- lecturer keys
  async function vaultKey(pass, salt, iter) {
    const base = await subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveBits"]);
    const bits = await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, base, 256);
    return importAes(new Uint8Array(bits));
  }

  async function createLecturerKeys(pass) {
    const salt = rnd(16);
    const vk = await vaultKey(pass, salt, VAULT_ITER);
    const kp = await subtle.generateKey(EC, true, ["deriveKey"]);
    const pubRaw = new Uint8Array(await subtle.exportKey("raw", kp.publicKey));
    const pk8 = new Uint8Array(await subtle.exportKey("pkcs8", kp.privateKey));
    const file = { v: 1, pub: b64e(pubRaw), salt: b64e(salt), iter: VAULT_ITER, priv: b64e(await seal(vk, pk8)) };
    const priv = await subtle.importKey("pkcs8", pk8, EC, false, ["deriveKey"]);
    return { file, vk, priv };
  }

  async function unlockLecturer(file, pass) {
    const vk = await vaultKey(pass, b64d(file.salt), file.iter);
    const pk8 = await unseal(vk, b64d(file.priv)); // throws on a wrong passphrase
    const priv = await subtle.importKey("pkcs8", pk8, EC, false, ["deriveKey"]);
    return { vk, priv };
  }

  const importPub = (b64) => subtle.importKey("raw", b64d(b64), EC, false, []);

  async function sealFor(pub, data) {
    const eph = await subtle.generateKey(EC, true, ["deriveKey"]);
    const key = await subtle.deriveKey({ name: "ECDH", public: pub }, eph.privateKey, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
    const ephRaw = new Uint8Array(await subtle.exportKey("raw", eph.publicKey));
    const body = await seal(key, data);
    const out = new Uint8Array(ephRaw.length + body.length);
    out.set(ephRaw);
    out.set(body, ephRaw.length);
    return out;
  }

  async function openWith(priv, buf) {
    const b = new Uint8Array(buf);
    const pub = await subtle.importKey("raw", b.slice(0, 65), EC, false, []);
    const key = await subtle.deriveKey({ name: "ECDH", public: pub }, priv, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    return unseal(key, b.slice(65));
  }

  // ---------- submission package: [u32 header length][header JSON][file bytes...]
  function pack(header, files) {
    header.files = files.map((f) => ({ name: f.name, type: f.type || "application/octet-stream", size: f.data.byteLength }));
    const h = fromJSON(header);
    const total = 4 + h.length + files.reduce((a, f) => a + f.data.byteLength, 0);
    const out = new Uint8Array(total);
    new DataView(out.buffer).setUint32(0, h.length);
    out.set(h, 4);
    let off = 4 + h.length;
    for (const f of files) { out.set(f.data, off); off += f.data.byteLength; }
    return out;
  }

  function unpack(bytes) {
    const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    const header = toJSON(bytes.subarray(4, 4 + len));
    let off = 4 + len;
    const files = header.files.map((f) => {
      const data = bytes.subarray(off, off + f.size);
      off += f.size;
      return { ...f, data };
    });
    return { header, files };
  }

  // ---------- materials share (lecturer side)
  // files: [{name, type, data: ArrayBuffer}] -> {code, id, expires, entries:[{path, bytes}]}
  async function buildShare({ salt, title, module, days, files }) {
    const code = newCode();
    const { id, key } = await derive(code, salt);
    const now = new Date();
    const expires = days > 0 ? new Date(now.getTime() + days * 864e5).toISOString() : null;
    const entries = [];
    const list = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      entries.push({ path: `s/${id}/${i}.bin`, bytes: await seal(key, new Uint8Array(f.data)) });
      list.push({ name: f.name, type: f.type || "application/octet-stream", size: f.data.byteLength, f: `${i}.bin` });
    }
    const manifest = { title, module, created: now.toISOString(), files: list };
    entries.push({ path: `s/${id}/m.bin`, bytes: await seal(key, fromJSON(manifest)) });
    entries.push({ path: `s/${id}/meta.json`, bytes: fromJSON({ v: 1, created: now.toISOString(), expires }) });
    return { code, id, expires, entries, manifest };
  }

  // ---------- modules
  // m/<id>/meta.json            public marker
  // m/<id>/index.bin            sealed with the module code's key: weeks + released items (+ their keys)
  // m/<id>/f/<file>.bin         each file sealed with its own item key
  // Draft items are never in the public index. Scheduled items are listed without a key; the
  // submissions service hands the key out after the release time.
  const randHex = (n) => Array.from(rnd(n), (b) => b.toString(16).padStart(2, "0")).join("");
  const randKey = () => rnd(32);

  async function itemKey(item, submitUrl) {
    if (item.key) return importAes(b64d(item.key));
    const svc = (submitUrl || "").replace(/\/+$/, "");
    if (!svc) throw Object.assign(new Error("locked"), { until: item.lock });
    const r = await fetch(`${svc}/key/${item.id}`, { cache: "no-store" });
    if (r.status === 423) throw Object.assign(new Error("locked"), { until: (await r.json()).until || item.lock });
    if (!r.ok) throw new Error("network " + r.status);
    return importAes(new Uint8Array(await r.arrayBuffer()));
  }

  function weekOf(start, n) {
    if (!start) return null;
    const d = new Date(start + "T00:00:00");
    d.setDate(d.getDate() + (n - 1) * 7);
    return d;
  }
  function currentWeek(start, count, now = new Date()) {
    if (!start) return null;
    const w = Math.floor((now - new Date(start + "T00:00:00")) / (7 * 864e5)) + 1;
    return Math.min(Math.max(w, 1), count || 1);
  }

  // ---------- one code box: materials, activity, module or feedback
  async function openAny(code, salt, base, submitUrl) {
    const d = await derive(code, salt);
    const get = (u) => fetch(u, { cache: "no-store" }).catch(() => null);
    const svc = (submitUrl || "").replace(/\/+$/, "");
    const [s, a, md, f] = await Promise.all([
      get(`${base}s/${d.id}/meta.json`),
      get(`${base}a/${d.id}/meta.json`),
      get(`${base}m/${d.id}/meta.json`),
      svc ? get(`${svc}/feedback/${d.id}`) : Promise.resolve(null),
    ]);
    if (!s && !a && !md) throw new Error("network");
    const bin = async (path) => {
      const r = await fetch(base + path, { cache: "no-store" });
      if (!r.ok) throw new Error("network " + r.status);
      return unseal(d.key, await r.arrayBuffer());
    };

    if (s && s.ok) {
      const meta = await s.json();
      if (meta.expires && new Date(meta.expires) < new Date()) return { kind: "share", status: "expired" };
      const manifest = toJSON(await bin(`s/${d.id}/m.bin`));
      return {
        kind: "share", status: "ok", id: d.id, meta, manifest,
        file: async (fl) => {
          const r = await fetch(`${base}s/${d.id}/${fl.f}`);
          if (!r.ok) throw new Error("network " + r.status);
          return unseal(d.key, await r.arrayBuffer());
        },
      };
    }
    if (a && a.ok) {
      const meta = await a.json();
      return {
        kind: "activity", id: d.id, meta, brief: toJSON(await bin(`a/${d.id}/m.bin`)),
        file: (fl) => bin(`a/${d.id}/${fl.f}`),
      };
    }
    if (md && md.ok) {
      const id = d.id;
      return {
        kind: "module", id, code, index: toJSON(await bin(`m/${id}/index.bin`)),
        file: async (item, fl, key) => {
          const r = await fetch(`${base}m/${id}/f/${fl.f}`);
          if (!r.ok) throw new Error("network " + r.status);
          return unseal(key || (await itemKey(item, svc)), await r.arrayBuffer());
        },
      };
    }
    if (f && f.ok) return { kind: "feedback", feedback: toJSON(await unseal(d.key, await f.arrayBuffer())) };
    return { kind: "none" };
  }

  function activityState(meta, now = Date.now()) {
    if (meta.closed) return "closed";
    if (meta.deadline && now > Date.parse(meta.deadline)) return meta.late ? "late" : "closed";
    return "open";
  }

  function sizeText(n) {
    const u = ["B", "KB", "MB", "GB"];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return i ? n.toFixed(1) + " " + u[i] : n + " B";
  }

  // ---------- page chrome
  function brand() {
    if (typeof document === "undefined") return;
    const site = global.SITE || {};
    const name = site.name || "Class Materials";
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; return el; };
    set("site", name);
    set("mark", name.split(/\s+/).filter((w) => /\w/.test(w)).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "CM");
    const sub = set("sub", site.subtitle || "");
    if (sub) sub.hidden = !site.subtitle;
  }

  // Show a code as letter tiles in two groups of four. textContent stays the bare code.
  function tiles(el, code) {
    el.textContent = "";
    el.classList.add("tiles");
    el.setAttribute("role", "img");
    el.setAttribute("aria-label", "Code " + [...code].join(" "));
    [...code].forEach((ch, i) => {
      if (i === 4) { const s = document.createElement("span"); s.className = "sep"; el.append(s); }
      const t = document.createElement("span");
      t.className = "t";
      t.textContent = ch;
      el.append(t);
    });
  }

  const fmtDate = (iso) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

  global.MS = {
    ALPHABET, LEN, ITER, normalise, pretty, valid, newCode, derive, seal, unseal, importAes,
    b64e, b64d, toJSON, fromJSON, text, createLecturerKeys, unlockLecturer, importPub, sealFor, openWith,
    pack, unpack, buildShare, openAny, activityState, sizeText, fmtDate, brand, tiles,
    randHex, randKey, itemKey, weekOf, currentWeek,
  };
})(typeof window !== "undefined" ? window : globalThis);
