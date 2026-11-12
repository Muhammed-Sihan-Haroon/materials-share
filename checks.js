/* Materials Share: checks on a student's written work (lecturer side, runs in the browser).
 *  - citations and references: in-text citations, the reference list, and how they match up
 *  - signs of AI tools: text left behind by chatbots (strong), and writing-style hints (weak)
 * These are prompts for a conversation with the student, not proof. Reference lookups (Crossref)
 * and the AI reviewer's notes are done by the submissions service; this file only prepares them.
 */
(function () {
  "use strict";

  const YEAR = /\b(?:19|20)\d{2}[a-z]?\b/;
  const ND = /\bn\.\s?d\b/i;
  const REF_HEAD = /^\s*(?:\d+\.?\s*)?(references?(?:\s+list)?|bibliography|works\s+cited|sources|reference\s+list)\s*:?\s*$/i;
  const END_HEAD = /^\s*(?:\d+\.?\s*)?(appendi(?:x|ces)\b.*)\s*:?\s*$/i;
  const NOT_NAME = new Set(["see", "e.g", "eg", "cf", "also", "in", "and", "the", "for", "from", "since", "between", "by", "on", "at", "of", "as", "to", "a", "an", "until", "before", "after", "during", "circa", "c", "around", "about", "from", "figure", "fig", "table", "page", "p", "pp", "section", "chapter", "q", "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december", "spring", "summer", "autumn", "winter", "fall", "version", "v", "python", "iso", "ieee"]);

  const norm = (s) => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const words = (s) => norm(s).match(/[a-z0-9]+/g) || [];

  // ---------- split the text into body and reference list
  function splitRefs(text) {
    const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
    let at = -1;
    for (let i = lines.length - 1; i >= 0; i--) if (REF_HEAD.test(lines[i])) { at = i; break; }
    if (at < 0) return { body: text, refText: "", heading: "" };
    let end = lines.length;
    for (let i = at + 1; i < lines.length; i++) if (END_HEAD.test(lines[i])) { end = i; break; }
    return { body: lines.slice(0, at).join("\n"), refText: lines.slice(at + 1, end).join("\n"), heading: lines[at].trim() };
  }

  // one reference per paragraph or numbered item; joins lines that carry on from the one above
  function splitEntries(refText) {
    const raw = refText.split("\n").map((l) => l.trim()).filter(Boolean);
    const numbered = raw.filter((l) => /^(?:\[\d+\]|\d+[.)])\s+/.test(l)).length >= Math.max(2, raw.length * 0.4);
    const out = [];
    for (const l of raw) {
      const starts = numbered ? /^(?:\[\d+\]|\d+[.)])\s+/.test(l)
        : /^[A-Z\p{Lu}][\p{L}'’\-]+(?:,|\s+(?:[A-Z]\.|and|&|et al)|\s+[A-Z][\p{L}'’\-]+.*?(?:\(|,|\.)\s*(?:\(?(?:19|20)\d{2}|n\.d\.))/u.test(l) || YEAR.test(l.slice(0, 120));
      if (!out.length || starts || (out[out.length - 1].length > 40 && /[.)]$/.test(out[out.length - 1]) && !numbered && YEAR.test(l))) out.push(l);
      else out[out.length - 1] += " " + l;
    }
    return { entries: out.filter((e) => e.replace(/^(?:\[\d+\]|\d+[.)])\s*/, "").length >= 8), numbered };
  }

  function parseRef(raw, i, numbered) {
    const text = raw.replace(/\s+/g, " ").trim();
    const num = numbered ? Number((text.match(/^\[?(\d+)/) || [])[1]) || i + 1 : null;
    const body = text.replace(/^(?:\[\d+\]|\d+[.)])\s*/, "");
    const doiM = body.match(/\b(10\.\d{4,9}\/[^\s"<>]+)/i);
    const doi = doiM ? doiM[1].replace(/[.,;)\]]+$/, "") : "";
    const urlM = body.match(/https?:\/\/[^\s<>"]+/i);
    const url = urlM ? urlM[0].replace(/[.,;)\]]+$/, "") : "";
    // the access date isn't the publication year: read the year from the part before it
    const accM = body.match(/[\[(]?\s*\b(?:accessed|retrieved|viewed)\b[^\])]*[\])]?/i);
    const pubPart = accM ? body.slice(0, accM.index) + " " + body.slice(accM.index + accM[0].length) : body;
    const yM = pubPart.replace(/https?:\/\/\S+/g, " ").match(/\b((?:19|20)\d{2})[a-z]?\b/);
    const nd = /\bn\.\s?d\.?/i.test(body);
    const year = yM && !(nd && body.search(/\bn\.\s?d\.?/i) < yM.index) ? yM[1] : "";
    const lead = body.split(/[(,.]/)[0] || "";
    const key = (lead.match(/[\p{L}'’\-]+/u) || [""])[0];
    // title: quoted text (IEEE), else the part after "(year)." (Harvard/APA), else the second sentence
    let title = (body.match(/(?:^|[\s(.,:])[“"‘']([^”"’']{8,300}?)[”"’'](?=[\s.,;:)]|$)/) || [])[1] || "";
    if (!title) {
      const after = body.split(/\(\s*(?:(?:19|20)\d{2}[a-z]?|n\.\s?d\.?)[^)]*\)\s*[.,]?\s*/i)[1];
      if (after) title = after.split(/(?<=[a-z0-9?!])\.\s|\s(?:Available at|Retrieved|Accessed|\[Online\]|In:)\b/i)[0];
    }
    if (!title) title = (body.split(/\.\s+/)[1] || "");
    title = title.replace(/^['‘’"“”]+|['‘’"“”.,]+$/g, "").trim().slice(0, 300);
    const accessed = !!accM;
    const accessedOn = accM ? parseDate(accM[0]) : null;
    // a website, as opposed to a journal article or book that happens to have a link
    const web = !!url && !doi && !/\b(journal|proceedings|proc\.|conference|vol\.|volume|pp\.|edn\.|edition|press|publishers?|isbn)\b/i.test(body);
    let host = "", homepage = false;
    try { const u = new URL(url); host = u.hostname.replace(/^www\./, ""); homepage = (u.pathname === "/" || u.pathname === "") && !u.search; } catch {}
    return { i, num, text, key, year, nd, doi, url, title, accessed, accessedOn, web, host, homepage, kind: siteKind(host, body) };
  }

  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  function parseDate(s) {
    const t = String(s).toLowerCase();
    let m = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?,?\s+((?:19|20)\d{2})/);      // 3 March 2024
    if (m && MONTHS.includes(m[2].slice(0, 3))) return new Date(Date.UTC(+m[3], MONTHS.indexOf(m[2].slice(0, 3)), +m[1]));
    m = t.match(/\b([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+((?:19|20)\d{2})/);           // March 3, 2024
    if (m && MONTHS.includes(m[1].slice(0, 3))) return new Date(Date.UTC(+m[3], MONTHS.indexOf(m[1].slice(0, 3)), +m[2]));
    m = t.match(/\b(\d{1,2})[/.\-](\d{1,2})[/.\-]((?:19|20)\d{2})\b/);                          // 03/03/2024 (UK order)
    if (m && +m[2] <= 12) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
    m = t.match(/\b((?:19|20)\d{2})-(\d{2})-(\d{2})\b/);                                           // 2024-03-03
    if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    m = t.match(/\b((?:19|20)\d{2})\b/);
    return m ? new Date(Date.UTC(+m[1], 0, 1)) : null;
  }

  // sources worth a second look in academic work
  const SITE_KINDS = [
    [/(^|\.)(chegg|coursehero|studocu|quizlet|brainly|bartleby|scribd|ukessays|studymode|123helpme|essaysauce|nursinganswers|homeworkify)\./, "essay or answer-sharing site"],
    [/(^|\.)(chatgpt|chat\.openai|openai|gemini\.google|bard\.google|copilot\.microsoft|claude\.ai|perplexity|poe)\./, "AI tool"],
    [/(^|\.)wikipedia\.org$/, "Wikipedia"],
    [/(^|\.)(medium|blogspot|wordpress|substack|hashnode|dev\.to|tumblr|wix|weebly)\./, "blog"],
    [/(^|\.)(reddit|quora|answers\.yahoo|facebook|instagram|tiktok|x|twitter|linkedin)\./, "social media or forum"],
    [/(^|\.)(youtube|youtu\.be|vimeo)\./, "video"],
    [/(^|\.)(geeksforgeeks|w3schools|tutorialspoint|javatpoint|programiz|stackoverflow|stackexchange)\./, "tutorial or Q&A site"],
  ];
  function siteKind(host, body) {
    const h = host + ".";
    for (const [re, label] of SITE_KINDS) if (re.test(h) || re.test(host)) return label;
    if (/\b(chatgpt|openai|copilot|gemini|claude|bard)\b/i.test(body)) return "AI tool";
    return "";
  }

  // ---------- in-text citations
  function citations(body) {
    const out = [];
    const keyOf = (s) => {
      const w = (s.replace(/\bet\s*al\.?/gi, " ").match(/[\p{Lu}][\p{L}'’\-]+/gu) || []).filter((x) => !NOT_NAME.has(norm(x)));
      return w[0] || "";
    };
    // (Smith, 2020), (Smith and Jones, 2019; Lee et al., 2021, p. 4)
    for (const m of body.matchAll(/\(([^()]{3,250})\)/g)) {
      if (!YEAR.test(m[1]) && !ND.test(m[1])) continue;
      for (const part of m[1].split(";")) {
        const y = part.match(/\b((?:19|20)\d{2})[a-z]?\b|\bn\.\s?d\.?/i);
        if (!y) continue;
        const before = part.slice(0, y.index);
        if (!/[\p{Lu}]/u.test(before)) continue;
        const key = keyOf(before);
        if (key) out.push({ kind: "author", key, year: y[1] || "n.d.", text: part.trim() });
      }
    }
    // Smith (2020), Smith and Jones (2019), Lee et al. (2021)
    for (const m of body.matchAll(/\b([\p{Lu}][\p{L}'’\-]+)(?:\s+et\s+al\.?|\s+(?:and|&)\s+[\p{Lu}][\p{L}'’\-]+)?\s*\(((?:19|20)\d{2}|n\.\s?d\.?)[a-z]?(?:,[^)]*)?\)/gu)) {
      if (NOT_NAME.has(norm(m[1]))) continue;
      out.push({ kind: "author", key: m[1], year: /^n/i.test(m[2]) ? "n.d." : m[2], text: m[0] });
    }
    // [1], [2, 3], [4-6]
    for (const m of body.matchAll(/\[(\d{1,3}(?:\s*[-–,]\s*\d{1,3}){0,10})\]/g)) {
      for (const bit of m[1].split(",")) {
        const r = bit.split(/[-–]/).map((x) => Number(x.trim()));
        if (r.length === 2 && r[1] >= r[0] && r[1] - r[0] < 50) for (let n = r[0]; n <= r[1]; n++) out.push({ kind: "num", num: n, text: m[0] });
        else if (r[0]) out.push({ kind: "num", num: r[0], text: m[0] });
      }
    }
    // the same citation written twice in one place shouldn't count twice
    const seen = new Set();
    return out.filter((c) => { const k = c.kind + (c.num || norm(c.key) + c.year) + c.text; if (seen.has(k)) return false; seen.add(k); return true; });
  }

  function refMatches(c, r) {
    if (c.kind === "num") return r.num === c.num;
    if (c.year === "n.d." ? !(r.nd && !r.year) : r.year !== c.year) return false;
    if (norm(r.text.slice(0, 160)).includes(norm(c.key)) || (r.host && r.host.includes(norm(c.key)))) return true;
    // (NCSC, 2023) for "National Cyber Security Centre (2023)"
    const lead = r.text.replace(/^(?:\[\d+\]|\d+[.)])\s*/, "").split(/[(,]/)[0];
    const initials = (lead.match(/\b[\p{Lu}]/gu) || []).join("").toLowerCase();
    return initials.length >= 2 && initials === norm(c.key);
  }

  function references(text, opts = {}) {
    const when = opts.submitted ? new Date(opts.submitted) : new Date();
    const { body, refText, heading } = splitRefs(text);
    const { entries, numbered } = splitEntries(refText);
    const refs = entries.map((e, i) => parseRef(e, i, numbered));
    const cites = citations(body);
    const authorCites = cites.filter((c) => c.kind === "author").length, numCites = cites.length - authorCites;
    const style = !cites.length ? "none" : authorCites && numCites && Math.min(authorCites, numCites) / cites.length > 0.2 ? "mixed" : numCites > authorCites ? "numbered" : "author-date";

    const unmatched = [];
    const used = new Set();
    const groups = new Map();
    for (const c of cites) {
      const hit = refs.filter((r) => refMatches(c, r));
      hit.forEach((r) => used.add(r.i));
      const label = c.kind === "num" ? `[${c.num}]` : `${c.key} (${c.year})`;
      const g = groups.get(label) || { label, n: 0, matched: !!hit.length };
      g.n++;
      groups.set(label, g);
      if (!hit.length && !unmatched.includes(label)) unmatched.push(label);
    }
    const issues = [];
    for (const r of refs) {
      const p = [];
      if (!r.year && !r.nd) p.push("no year");
      if (r.web && !r.accessed) p.push("website with no date accessed");
      if (r.web && !r.year && !r.nd) p.push("website with no year (use n.d. if there isn't one)");
      if (r.accessedOn && r.accessedOn > when) p.push("date accessed is after it was handed in");
      if (r.accessedOn && r.year && r.accessedOn.getUTCFullYear() < Number(r.year)) p.push("date accessed is before it was published");
      if (r.web && r.homepage) p.push("links to a home page, not the page used");
      if (r.web && !/^[\p{L}]/u.test(r.text.replace(/^(?:\[\d+\]|\d+[.)])\s*/, ""))) p.push("no author or organisation");
      if (r.kind) p.push(r.kind === "AI tool" ? "cites an AI tool" : r.kind);
      if (!used.has(r.i) && cites.length) p.push("not cited in the text");
      r.problems = p;
    }
    const dupes = [];
    const seen = new Map();
    for (const r of refs) {
      const k = r.doi ? norm(r.doi) : words(r.title).join(" ");
      if (k.length < 12) continue;
      if (seen.has(k)) dupes.push([seen.get(k), r.i]); else seen.set(k, r.i);
    }
    if (!refs.length && cites.length) issues.push("There are citations in the text but no reference list was found (looked for a heading such as References or Bibliography).");
    if (refs.length && !cites.length) issues.push("There's a reference list but no in-text citations were found.");
    if (style === "mixed") issues.push("Citation styles are mixed: some author-date, some numbered.");
    if (unmatched.length) issues.push(`${unmatched.length} in-text citation${unmatched.length === 1 ? " has" : "s have"} no matching reference: ${unmatched.slice(0, 12).join(", ")}${unmatched.length > 12 ? "…" : ""}.`);
    const uncited = refs.filter((r) => cites.length && !used.has(r.i));
    if (uncited.length) issues.push(`${uncited.length} reference${uncited.length === 1 ? " is" : "s are"} never cited in the text.`);
    for (const [a, b] of dupes) issues.push(`References ${a + 1} and ${b + 1} look like the same source.`);
    const noYear = refs.filter((r) => !r.year && !r.nd).length;
    if (noYear) issues.push(`${noYear} reference${noYear === 1 ? " has" : "s have"} no year.`);
    const webRefs = refs.filter((r) => r.web);
    const noAcc = webRefs.filter((r) => !r.accessed).length;
    if (noAcc) issues.push(`${noAcc} website${noAcc === 1 ? " has" : "s have"} no date accessed.`);
    const home = webRefs.filter((r) => r.homepage).length;
    if (home) issues.push(`${home} website reference${home === 1 ? " links" : "s link"} to a home page instead of the page used.`);
    const badAcc = refs.filter((r) => r.accessedOn && (r.accessedOn > when || (r.year && r.accessedOn.getUTCFullYear() < Number(r.year)))).length;
    if (badAcc) issues.push(`${badAcc} date${badAcc === 1 ? "" : "s"} accessed can't be right (before publication or after hand-in).`);
    const shady = refs.filter((r) => r.kind === "essay or answer-sharing site");
    if (shady.length) issues.push(`${shady.length} reference${shady.length === 1 ? " is" : "s are"} from essay or answer-sharing sites (${[...new Set(shady.map((r) => r.host))].join(", ")}).`);
    const kinds = {};
    for (const r of refs) if (r.kind && r.kind !== "essay or answer-sharing site") kinds[r.kind] = (kinds[r.kind] || 0) + 1;
    for (const [k, n] of Object.entries(kinds)) issues.push(`${n} reference${n === 1 ? " is" : "s are"} ${k === "AI tool" ? "an AI tool" : k === "Wikipedia" ? "Wikipedia" : "a " + k}: check the source is suitable.`);
    // web addresses pasted into the text instead of citing them
    const bodyUrls = [...new Set((body.match(/https?:\/\/[^\s<>"]+/gi) || []).map((u) => u.replace(/[.,;)\]]+$/, "")))];
    if (bodyUrls.length) issues.push(`${bodyUrls.length} web address${bodyUrls.length === 1 ? " is" : "es are"} pasted into the text instead of being cited.`);
    const recent = refs.filter((r) => r.year).map((r) => Number(r.year));
    const now = new Date().getFullYear();
    const future = recent.filter((y) => y > now).length;
    if (future) issues.push(`${future} reference${future === 1 ? " is" : "s are"} dated in the future.`);
    return { heading, style, refs, cites, groups: [...groups.values()], issues, words: words(body).length, bodyUrls, webCount: webRefs.length };
  }

  // ---------- signs of AI tools
  const ARTEFACTS = [
    [/utm_source=chatgpt\.com/i, "a link copied from ChatGPT (utm_source=chatgpt.com)"],
    [/oaicite|contentReference\s*\[|:contentReference|turn\d+search\d+|【\d+[^】]*】|†source/i, "ChatGPT citation markers left in the text"],
    [/\bas an ai (?:language )?model\b/i, "\"As an AI language model\""],
    [/\bas of my (?:last )?(?:knowledge )?(?:update|cutoff|training)/i, "chatbot wording about its knowledge cut-off"],
    [/\b(?:certainly|sure|absolutely|of course)[!,.]\s+here(?:'s| is| are)\b/i, "a chatbot reply opening (\"Certainly! Here is…\")"],
    [/\bi hope (?:this|that) helps\b/i, "\"I hope this helps\""],
    [/\b(?:let me know if you(?:'d| would)? (?:like|need|want)|feel free to (?:ask|let me know))\b/i, "a chatbot sign-off (\"Let me know if you'd like…\")"],
    [/\[(?:insert|your|add) [^\]]{2,40}\]/i, "an unfilled template placeholder such as [Insert …]"],
    [/\bhere(?:'s| is) (?:a |an |the )?(?:revised|rewritten|improved|refined|polished|more concise) (?:version|draft)\b/i, "\"Here's a revised version\""],
    [/\bregenerate response\b|\bcopy code\b/i, "chatbot interface text (\"Copy code\" / \"Regenerate response\")"],
    [/^\s*#{2,4}\s+\S/m, "Markdown headings (### …) pasted as plain text"],
    [/\*\*[^*\n]{3,80}\*\*/, "Markdown bold (**text**) pasted as plain text"],
  ];
  const PHRASES = ["delve", "delves", "delving", "tapestry", "underscore", "underscores", "pivotal", "intricate", "intricacies", "realm", "showcase", "showcasing", "multifaceted", "it is important to note", "it's important to note", "it is worth noting", "plays a crucial role", "plays a vital role", "crucial role", "in today's", "fast-paced", "ever-evolving", "navigate the complexities", "seamless", "seamlessly", "leverage", "leveraging", "furthermore", "moreover", "additionally", "in conclusion", "in summary", "overall,", "holistic", "robust", "comprehensive", "paramount", "foster", "fostering", "landscape", "embark", "unlock", "harness", "nuanced", "meticulous", "meticulously", "commendable", "invaluable", "noteworthy", "a testament to", "serves as a", "not only", "game-changer", "cutting-edge"];

  function aiSigns(text) {
    const t = String(text || "");
    const strong = [];
    for (const [re, label] of ARTEFACTS) {
      const m = t.match(re);
      if (m) strong.push({ label, quote: excerpt(t, m.index, m[0].length) });
    }
    const lower = norm(t).replace(/[’]/g, "'");
    const nWords = words(t).length || 1;
    const found = [];
    for (const p of PHRASES) {
      const re = new RegExp((/^\w/.test(p) ? "\\b" : "") + p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + (/\w$/.test(p) ? "\\b" : ""), "g");
      const n = (lower.match(re) || []).length;
      if (n) found.push({ p: p.replace(/,$/, ""), n });
    }
    found.sort((a, b) => b.n - a.n);
    const total = found.reduce((s, x) => s + x.n, 0);
    const per1000 = Math.round((total / nWords) * 1000 * 10) / 10;
    const sentences = t.replace(/\s+/g, " ").split(/(?<=[.!?])\s+(?=[A-Z"“])/).map((s) => words(s).length).filter((n) => n >= 3);
    let cv = null;
    if (sentences.length >= 15) {
      const mean = sentences.reduce((a, b) => a + b, 0) / sentences.length;
      const sd = Math.sqrt(sentences.reduce((a, b) => a + (b - mean) ** 2, 0) / sentences.length);
      cv = Math.round((sd / mean) * 100) / 100;
    }
    const dashes = (t.match(/—/g) || []).length;
    const weak = [];
    if (per1000 >= 6 && total >= 5) weak.push(`Many words and phrases chatbots overuse: ${per1000} per 1,000 words (${found.slice(0, 8).map((x) => `${x.p} ×${x.n}`).join(", ")}).`);
    if (cv !== null && cv < 0.35) weak.push(`Sentences are unusually even in length (variation ${cv}; people usually write above 0.45).`);
    if (dashes >= 4 && dashes / nWords > 0.004) weak.push(`Lots of long dashes (— ×${dashes}), a common habit of chatbot writing.`);
    return { strong, weak, phrases: found, per1000, cv, words: nWords };
  }

  function excerpt(t, at, len) {
    const s = Math.max(0, at - 50), e = Math.min(t.length, at + len + 50);
    return (s > 0 ? "…" : "") + t.slice(s, e).replace(/\s+/g, " ").trim() + (e < t.length ? "…" : "");
  }

  // ---------- one plain-text report (for copying into notes or a case file)
  function report({ who, activity, refs, ai, lookups, urlLookups, reviewer }) {
    const L = [];
    L.push(`Checks on written work: ${who}`, activity, `Run ${new Date().toLocaleString()}`, "");
    L.push("These are indicators to discuss with the student, not proof. AI-writing detection is unreliable, so don't rely on it alone.", "");
    L.push("SIGNS OF AI TOOLS");
    if (!ai.strong.length && !ai.weak.length) L.push("- None found.");
    for (const s of ai.strong) L.push(`- Strong: ${s.label}. "${s.quote}"`);
    for (const w of ai.weak) L.push(`- Weak: ${w}`);
    if (reviewer) {
      L.push("", "AI REVIEWER'S NOTES", reviewer.summary || "");
      for (const s of reviewer.signs || []) L.push(`- "${s.quote}": ${s.why}`);
      if ((reviewer.questions || []).length) { L.push("", "Questions to ask the student:"); for (const q of reviewer.questions) L.push(`- ${q}`); }
    }
    L.push("", "CITATIONS AND REFERENCES");
    L.push(`Style: ${refs.style}. ${refs.cites.length} in-text citation${refs.cites.length === 1 ? "" : "s"}, ${refs.refs.length} reference${refs.refs.length === 1 ? "" : "s"}.`);
    if (!refs.issues.length) L.push("- No problems found.");
    for (const x of refs.issues) L.push(`- ${x}`);
    if (refs.refs.length) {
      L.push("", "REFERENCE LIST");
      refs.refs.forEach((r, k) => {
        const lk = lookups && lookups[k];
        L.push(`${k + 1}. ${r.text}`);
        if (lk) L.push(`   Lookup: ${lk.label}${lk.match ? ` (${lk.match})` : ""}`);
        if (r.problems.length) L.push(`   Notes: ${r.problems.join("; ")}`);
      });
    }
    if (refs.bodyUrls && refs.bodyUrls.length) {
      L.push("", "WEB ADDRESSES IN THE TEXT");
      refs.bodyUrls.slice(0, 10).forEach((u, k) => { const lk = urlLookups && urlLookups[k]; L.push(`- ${u}${lk ? ` (${lk.label})` : ""}`); });
    }
    return L.join("\n");
  }

  window.Checks = { references, aiSigns, report, splitRefs, parseRef, citations };
})();
