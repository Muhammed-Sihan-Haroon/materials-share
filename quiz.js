/* Materials Share — quizzes (lecturer side).
 * Reads a quiz written in Word, PDF or plain text, turns it into questions, and marks answers.
 * The same marking rules run in worker.js (keep markQuiz there in step with this file).
 *
 * Format (forgiving):
 *   1. Which part converts mains AC into DC?        <- a question: "1." "1)" "Q1." "Q:" "Question 1:"
 *   a) CPU                                          <- options: "a)" "A." "(a)" "-" "•"
 *   b) Power supply *                               <- correct: ends with * or (correct) or ✓, or bold in Word,
 *   Answer: b                                          or an "Answer:" line (letter, letters, or the option text)
 *   2. RAM is [[volatile|temporary]] memory.        <- fill in the blank, | separates accepted answers
 *   3. RAM is ____ memory.  Answer: volatile        <- or ___ with an Answer line (; between several blanks)
 *   4. What does CPU stand for? Answer: Central Processing Unit   <- short answer
 *   (2 marks) anywhere in a question sets its points (default 1). Numbers allow "3.14 ± 0.01".
 */
(function () {
  "use strict";

  const Q_START = /^(?:Q(?:uestion)?\s*\d{0,3}\s*[:.)\-–]\s*|Q(?:uestion)?\s+\d{1,3}\s+|\d{1,3}\s*[.)]\s+)(.*)$/i;
  const OPT = /^(?:\(?([a-hA-H])[).]\s+|[-•○●◦▪□☐*✓✔]\s+)(.+)$/;
  const ANSWER = /^(?:answers?|ans|correct answers?)\s*[:=\-–]\s*(.+)$/i;
  const EQ = /^=\s*(.+)$/;
  const MARKS = /[([]\s*(\d+(?:\.\d+)?)\s*(?:marks?|points?|pts?)\s*[)\]]/i;
  const CORRECT_TAIL = /\s*(?:\*|\(correct\)|\[correct\]|✓|✔)\s*$/i;
  const INLINE = /\[\[([^[\]]+)\]\]/g;
  const BLANK = /_{3,}/g;
  const SLOT = "_____";
  const BOLD = "\u0001"; // marker added by readQuizFile for bold Word paragraphs

  const splitAlts = (s) => s.split("|").map((x) => x.trim()).filter(Boolean);

  function parseQuiz(text) {
    const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
    const raw = [];
    const ignored = [];
    let q = null;
    for (const line0 of lines) {
      const bold = line0.includes(BOLD);
      const line = line0.replace(new RegExp(BOLD, "g"), "").replace(/\s+$/, "");
      const t = line.trim();
      if (!t) continue;
      let m;
      if ((m = ANSWER.exec(t)) && q) { q.answer = m[1].trim(); continue; }
      if ((m = EQ.exec(t)) && q) { q.answer = q.answer ? q.answer + " | " + m[1].trim() : m[1].trim(); continue; }
      if (q && (m = OPT.exec(t))) {
        let body = m[2].trim();
        let correct = bold || t.startsWith("*") || t.startsWith("✓") || t.startsWith("✔") || CORRECT_TAIL.test(body);
        body = body.replace(CORRECT_TAIL, "").trim();
        const inl = ANSWER.exec(body);
        if (inl) { q.answer = inl[1].trim(); continue; }
        q.options.push({ text: body, letter: m[1] ? m[1].toLowerCase() : null, correct });
        continue;
      }
      if ((m = Q_START.exec(t)) && m[1].trim()) {
        q = { text: [m[1].trim()], options: [], answer: null, src: t };
        raw.push(q);
        continue;
      }
      if (q && !q.options.length) {
        // inline "Answer:" at the end of a question line
        const tail = /^(.*?)\s+(?:answer|ans)\s*:\s*(.+)$/i.exec(line);
        if (tail) { q.text.push(tail[1]); q.answer = tail[2].trim(); continue; }
        q.text.push(line);
        continue;
      }
      ignored.push(t);
    }

    const questions = [];
    const problems = [];
    raw.forEach((r, i) => {
      const n = i + 1;
      let text = r.text.join("\n").trim();
      const inlineAns = /^([\s\S]*?)\s+(?:answer|ans)\s*:\s*(.+)$/i.exec(text);
      if (inlineAns && !r.answer && !r.options.length) { text = inlineAns[1].trim(); r.answer = inlineAns[2].trim(); }
      let p = 1;
      const mk = MARKS.exec(text);
      if (mk) { p = Number(mk[1]) || 1; text = text.replace(MARKS, "").replace(/\s{2,}/g, " ").trim(); }
      const fail = (msg) => problems.push({ n, msg, src: r.src });

      // fill in the blank: [[answer|alt]] in the text
      const inl = [...text.matchAll(INLINE)];
      if (inl.length) {
        questions.push({ t: "blank", text: text.replace(INLINE, SLOT), blanks: inl.length, a: inl.map((x) => splitAlts(x[1])), p });
        return;
      }
      if (r.options.length >= 2) {
        let correct = r.options.map((o, k) => (o.correct ? k : -1)).filter((k) => k >= 0);
        if (r.answer) {
          const fromAns = matchOptions(r.answer, r.options);
          if (fromAns) correct = fromAns;
          else return fail(`the answer "${r.answer}" doesn't match any option`);
        }
        if (!correct.length) return fail("no correct option marked (end it with *, make it bold, or add an Answer: line)");
        questions.push({ t: correct.length > 1 ? "multi" : "mcq", text, options: r.options.map((o) => o.text), a: correct, p });
        return;
      }
      if (r.options.length === 1) return fail("only one option found");
      const slots = (text.match(BLANK) || []).length;
      if (!r.answer) return fail("no answer given (add an Answer: line, or put the answer in [[double brackets]])");
      const groups = r.answer.split(";").map((g) => splitAlts(g)).filter((g) => g.length);
      if (slots) {
        if (groups.length !== slots && !(groups.length === 1 && slots === 1)) return fail(`${slots} blanks but ${groups.length} answers (separate answers for each blank with ;)`);
        questions.push({ t: "blank", text: text.replace(BLANK, SLOT), blanks: slots, a: groups, p });
      } else {
        // short answer: one box after the question
        questions.push({ t: "blank", text: text + "\n" + SLOT, blanks: 1, a: [groups.flat()], p });
      }
    });
    return { questions, problems, ignored };
  }

  function matchOptions(ans, options) {
    const a = ans.trim();
    const letters = a.toLowerCase().split(/\s*(?:,|and|&|\s)\s*/).filter(Boolean);
    const letterOf = (k) => options[k].letter || String.fromCharCode(97 + k);
    if (letters.every((l) => /^\(?[a-h]\)?$/.test(l))) {
      const idx = letters.map((l) => options.findIndex((_, k) => letterOf(k) === l.replace(/[()]/g, "")));
      return idx.every((k) => k >= 0) ? [...new Set(idx)] : null;
    }
    const k = options.findIndex((o) => norm(o.text) === norm(a));
    return k >= 0 ? [k] : null;
  }

  // ---------- marking (keep in step with worker.js)
  function norm(s) {
    return String(s == null ? "" : s).normalize("NFKC").toLowerCase().replace(/[‘’`]/g, "'").replace(/[“”]/g, '"')
      .replace(/\s+/g, " ").trim().replace(/[.!?,;:]+$/, "").trim();
  }
  function num(s) {
    const t = s.replace(/,/g, "").replace(/\s+/g, "");
    return /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t) ? Number(t) : null;
  }
  function lev(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 3;
    const d = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      let prev = d[0];
      d[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = d[j];
        d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = tmp;
      }
    }
    return d[b.length];
  }
  function blank(resp, accepted) {
    const r = norm(resp);
    if (!r) return { ok: false, near: false };
    let near = false;
    for (const a0 of accepted) {
      let a = norm(a0);
      let tol = 0;
      const pm = /^(.+?)\s*(?:±|\+\/-|\+-)\s*([\d.]+)$/.exec(a);
      if (pm) { a = pm[1].trim(); tol = Number(pm[2]) || 0; }
      const na = num(a), nr = num(r);
      if (na !== null) { if (nr !== null && Math.abs(na - nr) <= tol + 1e-9) return { ok: true, near: false }; continue; }
      if (r === a) return { ok: true, near: false };
      const allow = a.length >= 8 ? 2 : a.length >= 4 ? 1 : 0;
      if (allow && lev(r, a) <= allow) near = true;
    }
    return { ok: false, near };
  }
  // key: [{t, a, p}], answers: one entry per question (option index, [indexes], or [strings])
  function markQuiz(key, answers) {
    let score = 0, outOf = 0;
    const results = key.map((q, i) => {
      const p = Number(q.p) || 1;
      outOf += p;
      const ans = answers[i];
      let s = 0, near = false;
      if (q.t === "mcq") s = Number.isInteger(ans) && q.a.length === 1 && q.a[0] === ans ? p : 0;
      else if (q.t === "multi") {
        const got = Array.isArray(ans) ? [...new Set(ans.filter(Number.isInteger))].sort() : [];
        const want = [...q.a].sort();
        s = got.length === want.length && got.every((x, k) => x === want[k]) ? p : 0;
      } else {
        const list = Array.isArray(ans) ? ans : [];
        let right = 0;
        q.a.forEach((acc, k) => { const b = blank(list[k], acc); if (b.ok) right++; else if (b.near) near = true; });
        s = Math.round((p * right / q.a.length) * 100) / 100;
      }
      score += s;
      return { s, p, ok: s === p, near: s < p && near };
    });
    return { score: Math.round(score * 100) / 100, outOf, results };
  }

  // what students may see before answering (no answers)
  const publicQuestions = (qs) => qs.map((q) => ({ t: q.t, text: q.text, options: q.options, blanks: q.blanks, p: q.p }));
  const answerKey = (qs) => qs.map((q) => ({ t: q.t, a: q.a, p: q.p }));

  // readable text of a student's answer / the right answer
  function answerText(q, ans) {
    if (q.t === "mcq") return Number.isInteger(ans) && q.options[ans] !== undefined ? q.options[ans] : "";
    if (q.t === "multi") return Array.isArray(ans) ? ans.filter((k) => q.options[k] !== undefined).map((k) => q.options[k]).join("; ") : "";
    return Array.isArray(ans) ? ans.map((x) => String(x || "").trim() || "(blank)").join("; ") : "";
  }
  function correctText(q) {
    if (q.t === "mcq" || q.t === "multi") return q.a.map((k) => q.options[k]).join("; ");
    return q.a.map((g) => g[0]).join("; ");
  }

  // Word: keep paragraphs and lists as lines, mark fully bold paragraphs; PDF: keep line breaks.
  async function readQuizFile(file, load) {
    const name = file.name.toLowerCase();
    const buf = new Uint8Array(await file.arrayBuffer());
    if (name.endsWith(".docx")) {
      await load.mammoth();
      const html = (await mammoth.convertToHtml({ arrayBuffer: buf.slice().buffer })).value;
      const doc = new DOMParser().parseFromString("<div>" + html + "</div>", "text/html");
      const out = [];
      const walk = (node, depth) => {
        for (const el of node.children) {
          const tag = el.tagName.toLowerCase();
          if (tag === "ol" || tag === "ul") {
            let k = 0;
            for (const li of el.children) {
              if (li.tagName.toLowerCase() !== "li") continue;
              const own = [...li.childNodes].filter((c) => !(c.nodeType === 1 && /^(ol|ul)$/i.test(c.tagName)));
              const txt = own.map((c) => c.textContent).join("").trim();
              const isBold = own.length > 0 && own.every((c) => (c.nodeType === 3 && !c.textContent.trim()) || (c.nodeType === 1 && /^(strong|b)$/i.test(c.tagName)));
              const prefix = tag === "ul" ? "- " : depth === 0 ? `${k + 1}. ` : `${String.fromCharCode(97 + k)}) `;
              if (txt) out.push(prefix + txt + (isBold ? BOLD : ""));
              k++;
              walk(li, depth + 1);
            }
          } else if (/^(p|h\d|pre)$/.test(tag)) {
            for (const br of el.querySelectorAll("br")) br.replaceWith("\n");
            const txt = el.textContent;
            const isBold = el.childNodes.length > 0 && [...el.childNodes].every((c) => (c.nodeType === 3 && !c.textContent.trim()) || (c.nodeType === 1 && /^(strong|b)$/i.test(c.tagName)));
            for (const part of txt.split("\n")) out.push(part + (isBold && /^\s*(\(?[a-h][).]|[-•])\s/i.test(part) ? BOLD : ""));
          } else if (tag === "table") {
            for (const tr of el.querySelectorAll("tr")) out.push([...tr.children].map((c) => c.textContent.trim()).join("  "));
          } else walk(el, depth);
        }
      };
      walk(doc.body.firstChild, 0);
      return out.join("\n");
    }
    if (name.endsWith(".pdf")) {
      await load.pdf();
      const doc = await pdfjsLib.getDocument({ data: buf.slice() }).promise;
      const out = [];
      for (let p = 1; p <= Math.min(doc.numPages, 60); p++) {
        const tc = await (await doc.getPage(p)).getTextContent();
        let line = "";
        for (const it of tc.items) {
          line += it.str;
          if (it.hasEOL) { out.push(line); line = ""; }
        }
        if (line) out.push(line);
        out.push("");
      }
      const t = out.join("\n").trim();
      if (!t) throw new Error("This PDF has no readable text (it may be a scan). Use the Word file or paste the questions.");
      return t;
    }
    return new TextDecoder().decode(buf);
  }

  window.Quiz = { parseQuiz, markQuiz, publicQuestions, answerKey, answerText, correctText, readQuizFile, norm, SLOT };
})();
