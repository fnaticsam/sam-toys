const controls = require('./_lib/abuse-controls');
// POST /dev/ask — { q } -> { answer, sections:[{id,title}], fromGuide, model }
//
// "Ask dev": answers a question about the private operator guide at /dev using
// the guide itself as the context. Same admission rule as the page (a valid
// dev_session cookie or a trusted address, via api/_lib/dev-session.js), so an
// anonymous caller can never spend the Gemini quota or read the guide through
// the model. Never sets a cookie; never echoes the question outside JSON.
//
// The guide text is derived at cold start from api/_lib/dev.html — the same
// uncommitted file api/dev.js serves (see api/_lib/DEV-PAGE.md). A missing or
// unparseable file fails closed as "not_configured", never a stack trace.

const fs = require("fs");
const path = require("path");
const { authorize, clientIp, privateHeaders } = require("./_lib/dev-session");

const MODEL = "gemini-3.5-flash";
const GEMINI_TIMEOUT_MS = 25_000;
const MAX_BODY_BYTES = 4096;
const Q_MIN = 3;
const Q_MAX = 500;
const MAX_GUIDE_CHARS = 70_000;
const EXPECTED_SECTIONS = 34;
const MIN_SECTIONS = 10;
const MAX_CITED = 6;

// Defence in depth only — process-local, so it caps a warm instance's quota
// burn; it is not durable abuse prevention (the session gate is).
const RL_WINDOW_MS = 60_000;
const RL_MAX = 20;
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  if (hits.size > 1000) for (const [k, v] of hits) if (now - v.t > RL_WINDOW_MS) hits.delete(k);
  const rec = hits.get(ip);
  if (!rec || now - rec.t > RL_WINDOW_MS) { hits.set(ip, { n: 1, t: now }); return false; }
  return ++rec.n > RL_MAX;
}

// ---------------------------------------------------------------- guide text

const ENTITIES = {
  lt: "<", gt: ">", amp: "&", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ",
  mdash: "—", ndash: "–", middot: "·", bull: "•", hellip: "…",
  rarr: "→", larr: "←", harr: "↔", times: "×", divide: "÷",
  laquo: "«", raquo: "»", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
  deg: "°", plusmn: "±", copy: "©", reg: "®", trade: "™",
  infin: "∞", ne: "≠", le: "≤", ge: "≥",
};
function decodeEntities(s) {
  // one pass, so a literal "&amp;lt;" decodes to "&lt;" and not to "<"
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return whole;
      try { return String.fromCodePoint(code); } catch { return whole; }
    }
    const key = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : whole;
  });
}
function collapse(s) { return s.replace(/\s+/g, " ").trim(); }
function stripTags(html) {
  return String(html)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ");
}
function textOf(html) { return collapse(decodeEntities(stripTags(html))); }

// <section id="..."> ... </section>; the guide does not nest sections, so a
// non-greedy match is exact. Sections without an id are skipped.
function parseSections(html) {
  const out = [];
  const re = /<section\b([^>]*)>([\s\S]*?)<\/section>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const idMatch = /(?:^|\s)id\s*=\s*"([^"]+)"/i.exec(m[1] || "");
    if (!idMatch) continue;
    const inner = m[2] || "";
    const h3 = /<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(inner);
    const id = idMatch[1].trim();
    const title = h3 ? textOf(h3[1]) : "";
    const text = textOf(inner);
    if (!text) continue;
    out.push({ id, title: title || id, text });
  }
  return out;
}

// Water-fill the per-section text so the longest sections are trimmed first.
function capTexts(texts, budget) {
  const total = (limit) => texts.reduce((n, t) => n + Math.min(t.length, limit), 0);
  let hi = texts.reduce((n, t) => Math.max(n, t.length), 0);
  if (total(hi) <= budget) return texts;
  let lo = 0;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (total(mid) <= budget) lo = mid; else hi = mid - 1;
  }
  return texts.map((t) => (t.length > lo ? t.slice(0, lo).trimEnd() + " …" : t));
}
function buildGuideText(sections) {
  const heads = sections.map((s) => `### ${s.id} — ${s.title}\n`);
  const fixed = heads.reduce((n, h) => n + h.length + 1, 0); // + one trailing newline per block
  const texts = capTexts(sections.map((s) => s.text), Math.max(0, MAX_GUIDE_CHARS - fixed));
  if (texts.some((t, i) => t !== sections[i].text)) {
    console.warn(`dev-ask: guide truncated to fit ${MAX_GUIDE_CHARS} chars`);
  }
  return sections.map((s, i) => heads[i] + texts[i] + "\n").join("");
}

// Cold-start load. null means "not configured" — the handler answers 503.
let GUIDE = null;
(function loadGuide() {
  let html;
  try {
    html = fs.readFileSync(path.join(__dirname, "_lib", "dev.html"), "utf8");
  } catch (err) {
    console.error("dev-ask: cannot read the guide body:", (err && err.code) || "unknown error");
    return;
  }
  const sections = parseSections(html);
  if (sections.length < MIN_SECTIONS) {
    console.error(`dev-ask: only ${sections.length} guide sections parsed (expected ${EXPECTED_SECTIONS}) - answering not_configured`);
    return;
  }
  if (sections.length !== EXPECTED_SECTIONS) {
    console.warn(`dev-ask: parsed ${sections.length} guide sections (expected ${EXPECTED_SECTIONS})`);
  }
  const titles = new Map(sections.map((s) => [s.id, s.title]));
  GUIDE = { sections, titles, text: buildGuideText(sections) };
})();

const INSTRUCTIONS = [
  "You are Ask dev, the assistant for Sam's private operator guide at sam.toys/dev.",
  "Answer the question from the guide you are given.",
  "Be concise: two to six sentences, or a short numbered list.",
  "Quote exact commands from the guide in backticks, copied verbatim.",
  "In `sections`, list the ids of the guide sections you used, and only ids that exist in the guide.",
  "If the guide does not cover the question, set fromGuide to false, say so in the first sentence, then give a brief best-effort answer from general knowledge - and do not invent commands, paths or settings.",
  "Plain text only: no markdown headings, no HTML.",
].join(" ");

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    answer: { type: "STRING" },
    sections: { type: "ARRAY", items: { type: "STRING" } },
    fromGuide: { type: "BOOLEAN" },
  },
  required: ["answer", "sections", "fromGuide"],
};

// ------------------------------------------------------------------ plumbing

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  privateHeaders(res);
  return res.end(JSON.stringify(payload));
}
const fail = (res, status, error, detail) =>
  send(res, status, detail ? { error, detail } : { error });

function readBody(req) {
  return new Promise((resolve) => {
    // Vercel's Node helper buffers the stream before the handler runs and
    // exposes it as a lazy `req.body` getter that parses by Content-Type.
    // Three consequences, all handled here so nothing throws or hangs:
    //  - the getter itself throws on invalid JSON;
    //  - a JSON scalar (`42`, `true`, `null`) is pre-parsed too, and the
    //    stream is already consumed, so "end" would never fire;
    //  - an empty JSON body arrives pre-parsed as {}.
    let pre;
    try { pre = req.body; }
    catch { return resolve({ ok: false, status: 400, error: "bad_request", detail: "Body must be JSON." }); }
    if (pre !== undefined && pre !== null) {
      if (typeof pre === "string") return resolve({ ok: true, raw: pre });
      if (Buffer.isBuffer(pre)) return resolve({ ok: true, raw: pre.toString("utf8") });
      try { return resolve({ ok: true, raw: String(JSON.stringify(pre)) }); }
      catch { return resolve({ ok: false, status: 400, error: "bad_request", detail: "Body could not be read." }); }
    }
    if (req.complete === true || req.readableEnded === true) {
      // stream already consumed and nothing pre-parsed: treat as an empty body
      return resolve({ ok: true, raw: pre === null ? "null" : "" });
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk) => {
      if (done) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > MAX_BODY_BYTES) { done = true; return resolve({ ok: false, status: 413, error: "payload_too_large" }); }
      chunks.push(buf);
    });
    req.on("end", () => { if (done) return; done = true; resolve({ ok: true, raw: Buffer.concat(chunks).toString("utf8") }); });
    req.on("error", () => { if (done) return; done = true; resolve({ ok: false, status: 400, error: "bad_request", detail: "Body could not be read." }); });
  });
}

// C0 and C1 control characters, written as escapes so this file stays ASCII-safe
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001F\\u007F-\\u009F]", "g");
function cleanQuestion(value) {
  if (typeof value !== "string") return { error: 'Send a question as a "q" string.' };
  const q = collapse(value.replace(CONTROL_CHARS, " "));
  if (q.length < Q_MIN) return { error: `The question is too short - ${Q_MIN} characters minimum.` };
  if (q.length > Q_MAX) return { error: `The question is too long - ${Q_MAX} characters maximum.` };
  return { q };
}

function parseModelJson(text) {
  const attempt = (s) => { try { return JSON.parse(s); } catch { return null; } };
  let out = attempt(text);
  if (out) return out;
  const fenced = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  out = attempt(fenced);
  if (out) return out;
  const first = fenced.indexOf("{");
  const last = fenced.lastIndexOf("}");
  if (first >= 0 && last > first) out = attempt(fenced.slice(first, last + 1));
  return out;
}

function citedSections(ids) {
  if (!Array.isArray(ids)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of ids) {
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (!GUIDE.titles.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, title: GUIDE.titles.get(id) });
    if (out.length >= MAX_CITED) break;
  }
  return out;
}

// ------------------------------------------------------------------- handler

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return fail(res, 405, "method_not_allowed", "Use POST.");
  }

  const secret = process.env.DEV_PASSWORD;
  if (!secret || !authorize(req, secret).ok) return fail(res, 401, "unauthorized");

  if (rateLimited(clientIp(req) || "unknown")) return fail(res, 429, "rate_limited");

  if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || "").trim())) {
    return fail(res, 400, "bad_request", "Send Content-Type: application/json.");
  }

  const body = await readBody(req);
  if (!body.ok) return fail(res, body.status, body.error, body.detail);
  if (Buffer.byteLength(body.raw, "utf8") > MAX_BODY_BYTES) return fail(res, 413, "payload_too_large");

  let parsed = null;
  try { parsed = JSON.parse(body.raw); } catch { return fail(res, 400, "bad_request", "Body must be JSON."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail(res, 400, "bad_request", 'Body must be a JSON object with a "q" string.');
  }
  const cleaned = cleanQuestion(parsed.q);
  if (cleaned.error) return fail(res, 400, "bad_request", cleaned.error);

  const key = process.env.GEMINI_API_KEY;
  if (!key) { console.error("dev-ask: GEMINI_API_KEY is not set"); return fail(res, 503, "not_configured"); }
  if (!GUIDE) return fail(res, 503, "not_configured");

  let reservation;
  try { reservation = await controls.reservePaid(req); }
  catch (error) { return fail(res, error.status === 429 ? 429 : 503,
    error.status === 429 ? "rate_limited" : "temporarily_unavailable"); }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  let text = "";
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: "POST",
      signal: controller.signal,
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: INSTRUCTIONS }] },
        contents: [{
          role: "user",
          parts: [{ text: `GUIDE\n\n${GUIDE.text}\nQUESTION\n\n${cleaned.q}` }],
        }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 700,
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
        },
      }),
    });
    if (!r.ok) {
      if (r.body) await r.body.cancel().catch(() => {});
      console.error("dev-ask: model error", r.status);
      return fail(res, 502, "model_error");
    }
    const data = await r.json().catch(() => null);
    const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content
      ? data.candidates[0].content.parts
      : null;
    text = Array.isArray(parts) ? parts.map((p) => (p && p.text) || "").join("") : "";
    if (!text) {
      console.error("dev-ask: model returned no text");
      return fail(res, 502, "model_error");
    }
  } catch (err) {
    console.error("dev-ask: model call failed", err && err.name === "AbortError" ? "timeout" : "network");
    return fail(res, 502, "model_error");
  } finally {
    clearTimeout(timer);
    await reservation.release();
  }

  const out = parseModelJson(text);
  if (!out || typeof out !== "object" || Array.isArray(out)) {
    console.error("dev-ask: model reply was not JSON");
    return fail(res, 502, "model_error");
  }
  const answer = typeof out.answer === "string" ? out.answer.trim() : "";
  if (!answer) {
    console.error("dev-ask: model reply had an empty answer");
    return fail(res, 502, "model_error");
  }

  return send(res, 200, {
    answer,
    sections: citedSections(out.sections),
    fromGuide: out.fromGuide !== false,
    model: MODEL,
  });
};

// Exposed for the local preview server and tests; not part of the HTTP contract.
module.exports.guide = () => GUIDE;
