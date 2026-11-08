/* Materials Share: quiz integrity signals (student pages).
 * Watches for copying question text, right-clicking a question, pasting into an answer, and leaving the
 * quiz page (another tab or app). Each one shows a warning to the student and is reported to onEvent,
 * which records it for the lecturer. These are signals, not proof: a second device can't be detected.
 *
 * Questions are marked with data-q="<index>" inside `root`.
 */
(function () {
  "use strict";
  const MIN_AWAY = 1500; // ignore blinks such as a notification banner
  const MAX = 200;

  function watch(o) {
    let count = 0, awaySince = 0, lastQ = null, timer = 0;
    const qOf = (n) => {
      const e = n && (n.nodeType === 1 ? n : n.parentElement);
      const f = e && e.closest && e.closest("[data-q]");
      return f && o.root.contains(f) ? Number(f.dataset.q) : null;
    };
    const inRoot = (n) => { const e = n && (n.nodeType === 1 ? n : n.parentElement); return !!(e && o.root.contains(e)); };
    const isField = (n) => { const e = n && (n.nodeType === 1 ? n : n.parentElement); return !!(e && e.closest && e.closest("input,textarea")); };
    const warn = (msg) => {
      if (!o.banner) return;
      o.banner.textContent = msg;
      o.banner.hidden = false;
      clearTimeout(timer);
      timer = setTimeout(() => { o.banner.hidden = true; }, 9000);
    };
    const record = (ev) => {
      if (count >= MAX) return;
      count++;
      try { o.onEvent({ ...ev, t: Date.now() }); } catch {}
    };
    const label = (q) => (q === null || q === undefined || Number.isNaN(q) ? "" : ` (question ${q + 1})`);
    const current = () => lastQ ?? (o.currentQ ? o.currentQ() : null);

    const onCopy = (e) => {
      if (!o.active()) return;
      const sel = document.getSelection();
      const node = (sel && sel.anchorNode) || e.target;
      let touches = false;
      try { touches = !!(sel && sel.rangeCount && !sel.isCollapsed && sel.getRangeAt(0).intersectsNode(o.root)); } catch {}
      if (!touches && !inRoot(node) && !inRoot(e.target)) return;
      if (isField(e.target)) return; // copying their own typed answer
      e.preventDefault();
      try { e.clipboardData.setData("text/plain", ""); } catch {}
      const q = (inRoot(node) ? qOf(node) : null) ?? qOf(e.target) ?? current();
      record({ k: "copy", q });
      warn(`Copying quiz questions is turned off${label(q)}. Your lecturer can see that you tried.`);
    };
    const onMenu = (e) => {
      if (!o.active() || !inRoot(e.target) || isField(e.target)) return;
      e.preventDefault();
      const q = qOf(e.target) ?? current();
      record({ k: "menu", q });
      warn(`Right-click is turned off on quiz questions${label(q)}. Your lecturer can see that you tried.`);
    };
    const onPaste = (e) => {
      if (!o.active() || !inRoot(e.target) || !isField(e.target)) return;
      const q = qOf(e.target) ?? current();
      record({ k: "paste", q });
      warn(`You pasted into an answer${label(q)}. Your lecturer can see this.`);
    };
    const leave = () => {
      if (!o.active() || awaySince) return;
      awaySince = Date.now();
      lastQ = current();
    };
    const back = () => {
      if (!awaySince) return;
      const ms = Date.now() - awaySince;
      awaySince = 0;
      if (ms < MIN_AWAY || !o.active()) return;
      record({ k: "away", q: lastQ, ms });
      warn(`You left the quiz for ${Math.round(ms / 1000)} seconds${label(lastQ)}. Your lecturer can see this.`);
    };
    const onFocusIn = (e) => { if (inRoot(e.target)) { const q = qOf(e.target); if (q !== null) lastQ = q; } };

    document.addEventListener("copy", onCopy, true);
    document.addEventListener("cut", onCopy, true);
    document.addEventListener("contextmenu", onMenu, true);
    document.addEventListener("paste", onPaste, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("pointerdown", onFocusIn, true);
    document.addEventListener("visibilitychange", () => (document.visibilityState === "hidden" ? leave() : back()));
    window.addEventListener("blur", leave);
    window.addEventListener("focus", back);
    return { reset() { count = 0; awaySince = 0; lastQ = null; } };
  }

  // human-readable summary for lecturers
  const KIND = { copy: "tried to copy", paste: "pasted into an answer", menu: "right-clicked", away: "left the quiz" };
  function summarise(log) {
    const by = {};
    let awayMs = 0;
    for (const e of log || []) {
      by[e.k] = (by[e.k] || 0) + 1;
      if (e.k === "away") awayMs += e.ms || 0;
    }
    const parts = [];
    if (by.copy) parts.push(`tried to copy ${by.copy}×`);
    if (by.paste) parts.push(`pasted ${by.paste}×`);
    if (by.menu) parts.push(`right-clicked ${by.menu}×`);
    if (by.away) parts.push(`left the quiz ${by.away}× (${Math.round(awayMs / 1000)} s)`);
    return { total: (log || []).length, text: parts.join(", "), by, awayMs };
  }
  window.Integrity = { watch, summarise, KIND };
})();
