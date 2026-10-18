// GitHub API helpers for the lecturer pages. The token is only ever sent to api.github.com.
(function (global) {
  "use strict";

  function create(conn) {
    async function gh(path, opts = {}) {
      const headers = {
        Authorization: "Bearer " + conn.token,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      };
      if (opts.body) headers["Content-Type"] = "application/json";
      const r = await fetch("https://api.github.com/repos/" + conn.repo + path, { cache: "no-store", ...opts, headers });
      if (!r.ok) {
        let msg = "GitHub " + r.status;
        try { msg += ": " + (await r.json()).message; } catch {}
        const err = new Error(msg);
        err.status = r.status;
        throw err;
      }
      return r.status === 204 ? null : r.json();
    }

    // Read a file from the branch (not from Pages, which lags). Returns bytes or null.
    async function getFile(path) {
      try {
        const j = await gh(`/contents/${path}?ref=${encodeURIComponent(conn.branch)}`);
        if (j.content) return MS.b64d(j.content);
        const blob = await gh(`/git/blobs/${j.sha}`);
        return MS.b64d(blob.content);
      } catch (e) {
        if (e.status === 404) return null;
        throw e;
      }
    }

    async function getJSON(path) {
      const b = await getFile(path);
      return b ? MS.toJSON(b) : null;
    }

    // All changes in one commit, so Pages rebuilds once.
    async function commit(entries, message) {
      const ref = await gh("/git/ref/heads/" + encodeURIComponent(conn.branch));
      const parent = ref.object.sha;
      const head = await gh("/git/commits/" + parent);
      const tree = [];
      for (const e of entries) {
        if (e.remove) { tree.push({ path: e.path, mode: "100644", type: "blob", sha: null }); continue; }
        const blob = await gh("/git/blobs", { method: "POST", body: JSON.stringify({ content: MS.b64e(e.bytes), encoding: "base64" }) });
        tree.push({ path: e.path, mode: "100644", type: "blob", sha: blob.sha });
      }
      const t = await gh("/git/trees", { method: "POST", body: JSON.stringify({ base_tree: head.tree.sha, tree }) });
      const c = await gh("/git/commits", { method: "POST", body: JSON.stringify({ message, tree: t.sha, parents: [parent] }) });
      await gh("/git/refs/heads/" + encodeURIComponent(conn.branch), { method: "PATCH", body: JSON.stringify({ sha: c.sha }) });
    }

    async function check() {
      const repo = await gh("");
      if (!repo.permissions || !repo.permissions.push) throw new Error("token can't write to this repository");
      await gh("/git/ref/heads/" + encodeURIComponent(conn.branch));
      return repo.full_name;
    }

    return { gh, getFile, getJSON, commit, check };
  }

  global.GH = { create };
})(window);
