// Lecturer sign-in and shared helpers for the lecturer pages (dashboard, modules, marking, quick share).
//
// Sign-in model:
//  - Your marking passphrase unlocks keys/lecturer.json (public, passphrase-protected).
//  - The GitHub token is stored on this device only encrypted with that passphrase-derived key.
//  - "Stay signed in" keeps the unlocked keys for 8 hours in IndexedDB as non-extractable CryptoKeys,
//    so pages can use them but no script can read the key bytes out. Sign out clears them.
(function (global) {
  "use strict";
  const HOURS = 8;
  const DB = "ms-lecturer", ST = "kv";
  const SVC = ((global.SITE && SITE.submitUrl) || "").replace(/\/+$/, "");
  const siteUrl = new URL("./", location.href);
  const siteHost = (siteUrl.host + siteUrl.pathname).replace(/\/$/, "");

  // ---------- storage
  function idb() {
    return new Promise((ok, no) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(ST);
      r.onsuccess = () => ok(r.result);
      r.onerror = () => no(r.error);
    });
  }
  async function idbDo(mode, fn) {
    try {
      const db = await idb();
      return await new Promise((ok, no) => {
        const tx = db.transaction(ST, mode);
        const req = fn(tx.objectStore(ST));
        tx.oncomplete = () => ok(req && req.result);
        tx.onerror = () => no(tx.error);
      });
    } catch { return null; }
  }
  const sessGet = () => idbDo("readonly", (s) => s.get("session"));
  const sessSet = (v) => idbDo("readwrite", (s) => s.put(v, "session"));
  const sessDel = () => idbDo("readwrite", (s) => s.delete("session"));
  const ls = {
    get(k, s) { try { return JSON.parse((s || localStorage).getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k, s) { try { (s || localStorage).removeItem(k); } catch {} },
  };

  // ---------- small UI helpers
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e[k] = v;
      else if (v === true) e.setAttribute(k, "");
      else if (v !== false && v != null) e.setAttribute(k, v);
    }
    for (const c of kids) if (c != null) e.append(c);
    return e;
  };
  const say = (node, msg, cls) => { node.className = cls || "muted"; node.textContent = msg; };
  async function busy(btn, label, fn) {
    const before = btn.textContent;
    btn.disabled = true;
    if (label) btn.textContent = label;
    try { return await fn(); } finally { btn.disabled = false; if (!label || btn.textContent === label) btn.textContent = before; }
  }

  // ---------- top bar
  const PAGES = [["dashboard", "dashboard.html", "Dashboard"], ["modules", "modules.html", "Modules"],
    ["marking", "review.html", "Activities & marking"], ["share", "admin.html", "Quick share"]];
  function topbar(page) {
    const host = $("ltop");
    if (!host) return;
    host.className = "topbar";
    const nav = el("nav", { class: "nav", "aria-label": "Lecturer pages" });
    for (const [key, href, label] of PAGES) nav.append(el("a", { href, text: label, "aria-current": key === page ? "page" : null }));
    const out = el("button", { class: "btn ghost small", id: "signOut", hidden: true, text: "Sign out", onclick: signOut });
    host.textContent = "";
    host.append(el("div", { class: "wrap wide topbar-in" },
      el("a", { class: "brand", href: "dashboard.html" }, el("span", { class: "mark", id: "mark", "aria-hidden": "true" }),
        el("span", {}, el("b", { id: "site", text: "Class Materials" }), el("small", { id: "sub", hidden: true }))),
      nav,
      el("span", { class: "bar-end actions" }, el("a", { href: "./", text: "Student page" }), out)));
    MS.brand();
  }

  async function signOut() {
    await sessDel();
    location.reload();
  }

  // ---------- submissions service
  function makeSvc(conn) {
    return async function svc(method, path, body) {
      if (!SVC) throw new Error("The submissions service isn't set up yet: add submitUrl to config.js (see README).");
      let r;
      try {
        r = await fetch(SVC + path, { method, body, cache: "no-store", headers: { Authorization: "Bearer " + conn.token } });
      } catch {
        throw new Error("Couldn't reach the submissions service at " + SVC);
      }
      if (!r.ok) {
        let m = "Submissions service " + r.status;
        try { m += ": " + (await r.json()).error; } catch {}
        const e = new Error(m);
        e.status = r.status;
        throw e;
      }
      return r;
    };
  }

  // ---------- the lecturer's private index (activities + modules), encrypted with the passphrase key
  function indexTools(gh, vault) {
    async function loadIndex() {
      for (let attempt = 0; ; attempt++) {
        const b = await gh.getFile("keys/index.bin");
        if (!b) return { v: 2, activities: [], modules: [] };
        try {
          const ix = MS.toJSON(await MS.unseal(vault.vk, b));
          ix.activities = ix.activities || [];
          ix.modules = ix.modules || [];
          return ix;
        } catch {
          if (attempt === 0) { await new Promise((r) => setTimeout(r, 2500)); continue; } // GitHub can briefly serve an older copy
          const fresh = confirm(
            "Your saved lecturer data (keys/index.bin) can't be opened with this marking key.\n\n" +
            "This happens when the marking passphrase was set up more than once. Start a new, empty list? " +
            "Activities and modules in the old list won't be shown here any more.");
          if (fresh) return { v: 2, activities: [], modules: [] };
          throw new Error("Your lecturer data couldn't be opened with this marking key.");
        }
      }
    }
    const indexEntry = async (ix) => ({ path: "keys/index.bin", bytes: await MS.seal(vault.vk, MS.fromJSON(ix)) });
    return { loadIndex, indexEntry };
  }

  function finish(conn, vault, lecturerFile) {
    const gh = GH.create(conn);
    const so = $("signOut");
    if (so) so.hidden = false;
    return { conn, gh, vault, lecturerFile, svc: makeSvc(conn), SVC, siteUrl, siteHost, ...indexTools(gh, vault) };
  }

  async function saveAuth(conn, vk) {
    ls.set("ms-auth", { repo: conn.repo, branch: conn.branch, tok: MS.b64e(await MS.seal(vk, new TextEncoder().encode(conn.token))) });
    ls.del("ms-conn");
    ls.del("ms-conn", sessionStorage);
  }

  // ---------- sign in
  async function ready(page) {
    topbar(page);
    const auth = ls.get("ms-auth");
    const s = await sessGet();
    if (s && s.exp > Date.now() && auth && s.vk && s.priv) {
      try {
        const token = MS.text(await MS.unseal(s.vk, MS.b64d(auth.tok)));
        return finish({ repo: auth.repo, branch: auth.branch, token }, { vk: s.vk, priv: s.priv }, null);
      } catch { await sessDel(); }
    }
    let lecturerFile = null;
    try {
      const r = await fetch(siteUrl.href + "keys/lecturer.json", { cache: "no-store" });
      if (r.ok) lecturerFile = await r.json();
    } catch {}
    return new Promise((resolve) => signInCard(lecturerFile, auth, resolve));
  }

  function signInCard(lecturerFile, auth, resolve) {
    const legacy = ls.get("ms-conn") || ls.get("ms-conn", sessionStorage) || null;
    const setup = !lecturerFile;
    const needToken = setup || !auth;
    const app = $("app");
    if (app) app.hidden = true;

    const msg = el("p", { class: "muted", id: "siMsg" });
    const repo = el("input", { id: "siRepo", placeholder: "your-username/materials-share", value: (auth && auth.repo) || (legacy && legacy.repo) || "" });
    const branch = el("input", { id: "siBranch", value: (auth && auth.branch) || (legacy && legacy.branch) || "main" });
    const token = el("input", { id: "siToken", type: "password", autocomplete: "off", placeholder: "github_pat_…", value: (legacy && legacy.token) || "" });
    const pw = el("input", { id: "siPass", type: "password", autocomplete: setup ? "new-password" : "current-password" });
    const pw2 = el("input", { id: "siPass2", type: "password", autocomplete: "new-password" });
    const stay = el("input", { type: "checkbox", id: "siStay", checked: true });
    const tokenBox = el("div", { id: "siTokenBox", hidden: !needToken },
      el("div", { class: "grid" },
        el("div", {}, el("label", { for: "siRepo", text: "Repository (owner/name)" }), repo),
        el("div", {}, el("label", { for: "siBranch", text: "Branch" }), branch)),
      el("label", { for: "siToken", text: "GitHub access token" }), token,
      el("p", { class: "hint", text: "A fine-grained token for this one repository with Contents: Read and write. It's stored on this device only in encrypted form, locked by your passphrase." }));
    const changeToken = el("a", { href: "#", text: "Use a different GitHub token", onclick: (e) => { e.preventDefault(); tokenBox.hidden = false; changeToken.hidden = true; } });
    changeToken.hidden = needToken;
    const go = el("button", { class: "btn full", id: "siGo", text: setup ? "Set up lecturer access" : "Sign in" });

    const form = el("form", { class: "card narrow", id: "signin", style: "max-width:560px" },
      el("h1", { text: setup ? "Set up lecturer access" : "Lecturer sign-in" }),
      el("p", { class: "lead", text: setup
        ? "Choose a marking passphrase. It protects student work and your GitHub token. If it's lost, nobody can recover submissions, so keep it somewhere safe. Four or five random words work well."
        : "Enter your marking passphrase." }),
      tokenBox,
      el("label", { for: "siPass", text: setup ? "Marking passphrase (at least 12 characters)" : "Marking passphrase" }), pw,
      setup ? el("label", { for: "siPass2", text: "Repeat passphrase" }) : null, setup ? pw2 : null,
      el("label", { class: "check" }, stay, " Stay signed in on this device for 8 hours"),
      go, msg, el("p", { class: "hint" }, changeToken));
    (document.querySelector("main") || document.body).prepend(form);
    (needToken && !repo.value ? repo : pw).focus();

    form.onsubmit = (ev) => {
      ev.preventDefault();
      busy(go, setup ? "Setting up…" : "Signing in…", async () => {
        try {
          let conn = null;
          if (!tokenBox.hidden) {
            conn = { repo: repo.value.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\/$/, ""), branch: branch.value.trim() || "main", token: token.value.trim() };
            if (!conn.repo || !conn.token) return say(msg, "Enter the repository and token.", "err");
            try { await GH.create(conn).check(); }
            catch (e) { return say(msg, "GitHub didn't accept that token: " + (e.message || e.name), "err"); }
          }
          let vault;
          if (setup) {
            if (pw.value.length < 12) return say(msg, "Use at least 12 characters.", "err");
            if (pw.value !== pw2.value) return say(msg, "The two passphrases don't match.", "err");
            const gh = GH.create(conn);
            if (await gh.getJSON("keys/lecturer.json")) return say(msg, "This site already has a marking key. Reload the page and sign in with your passphrase.", "err");
            const k = await MS.createLecturerKeys(pw.value);
            await gh.commit([
              { path: "keys/lecturer.json", bytes: MS.fromJSON(k.file) },
              { path: "keys/index.bin", bytes: await MS.seal(k.vk, MS.fromJSON({ v: 2, activities: [], modules: [] })) },
            ], "Set up lecturer access");
            lecturerFile = k.file;
            vault = { vk: k.vk, priv: k.priv };
          } else {
            try { vault = await MS.unlockLecturer(lecturerFile, pw.value); }
            catch { return say(msg, "That passphrase didn't work.", "err"); }
          }
          if (!conn) {
            try { conn = { repo: auth.repo, branch: auth.branch, token: MS.text(await MS.unseal(vault.vk, MS.b64d(auth.tok))) }; }
            catch { tokenBox.hidden = false; return say(msg, "Enter your GitHub token again.", "err"); }
          }
          await saveAuth(conn, vault.vk);
          if (stay.checked) await sessSet({ vk: vault.vk, priv: vault.priv, exp: Date.now() + HOURS * 3600e3 });
          pw.value = pw2.value = token.value = "";
          form.remove();
          if (app) app.hidden = false;
          resolve(finish(conn, vault, lecturerFile));
        } catch (e) {
          say(msg, e.message || e.name || "Something went wrong.", "err");
        }
      });
    };
  }

  // ---------- modules: what students can see is rebuilt from your private copy on every change
  const keyCache = new Map();
  async function moduleKey(code) {
    if (!keyCache.has(code)) keyCache.set(code, (await MS.derive(code, SITE.salt)).key);
    return keyCache.get(code);
  }
  const released = (i) => i.status === "published" || (i.status === "scheduled" && Date.parse(i.at) <= Date.now());
  function publicIndex(m) {
    return {
      v: 1, short: m.short, title: m.title, start: m.start || "", weeks: m.weeks, updated: new Date().toISOString(),
      items: m.items.filter((i) => i.status !== "draft").map((i) => ({
        id: i.id, week: i.week, kind: i.kind, title: i.title, note: i.note || "", files: i.files || [], order: i.order, published: i.published,
        ...(released(i) ? { key: i.key } : { lock: Date.parse(i.at) }),
        ...(i.activity ? { activity: i.activity.code } : {}),
      })),
    };
  }
  async function moduleEntries(m) {
    const mk = await moduleKey(m.code);
    return [
      { path: `m/${m.id}/meta.json`, bytes: MS.fromJSON({ v: 1, created: m.created }) },
      { path: `m/${m.id}/index.bin`, bytes: await MS.seal(mk, MS.fromJSON(publicIndex(m))) },
    ];
  }

  // ---------- presenter screen (shared)
  function present({ title, code, sub, fresh }) {
    let o = $("present");
    if (!o) {
      o = el("div", { class: "overlay", id: "present", hidden: true },
        el("p", { class: "ptitle", id: "pTitle" }), el("p", { class: "step", text: "Go to" }), el("div", { class: "url", id: "pHost" }),
        el("p", { class: "step", text: "and enter" }), el("div", { class: "big", id: "pCode" }),
        el("p", { class: "muted", id: "pSub", style: "margin-top:3vh;font-size:1.1rem" }), el("p", { class: "muted", id: "pNote" }),
        el("p", { class: "actions", style: "justify-content:center;margin-top:4vh" },
          el("button", { class: "btn ghost", id: "pCopy", text: "Copy link" }), el("button", { class: "btn", id: "pClose", text: "Back" })));
      document.body.append(o);
      $("pClose").onclick = () => { o.hidden = true; };
    }
    $("pTitle").textContent = title;
    $("pHost").textContent = siteHost;
    MS.tiles($("pCode"), code);
    $("pSub").textContent = sub || "";
    $("pNote").textContent = fresh ? "Live in about a minute while GitHub publishes it." : "";
    $("pCopy").textContent = "Copy link";
    $("pCopy").onclick = async () => {
      try { await navigator.clipboard.writeText(siteUrl.href + "#" + code); $("pCopy").textContent = "Copied ✓"; }
      catch { $("pCopy").textContent = siteUrl.href + "#" + code; }
    };
    o.hidden = false;
  }

  global.Lecturer = { ready, signOut, present, el, say, busy, siteUrl, siteHost, moduleKey, moduleEntries, released };
})(window);
