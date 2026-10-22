const controls = require("./_lib/abuse-controls");
const fs = require("fs");
const path = require("path");
const { injectStats, loadStats } = require("./_lib/dev-stats");

// Single-password gate for /dev, modelled on api/londonplan.js but hardened:
// time-bound session tokens, fixed-width secret comparison, cookie scoped to
// /dev, no-store + noindex on every exit path.
//
// The page body (api/_lib/dev.html) is deliberately NOT committed: this repo is
// public on GitHub, so anything in git is world-readable regardless of the
// gate. It is deployed from the working tree with `vercel deploy --prod`.
// See api/_lib/DEV-PAGE.md. If the file is missing the function fails closed.
let HTML = null;
try {
  HTML = fs.readFileSync(path.join(__dirname, "_lib", "dev.html"), "utf8");
  HTML = injectStats(HTML, loadStats(path.join(__dirname, "_lib")));
} catch {
  HTML = null;
}

// Session mechanics live in api/_lib/dev-session.js so that this gate and
// api/dev-ask.js ("Ask dev") enforce exactly one admission rule.
const {
  SESSION_TTL_MS,
  COOKIE,
  COOKIE_ATTRS,
  matches,
  issueToken,
  privateHeaders,
  wantsLogout,
  authorize,
} = require("./_lib/dev-session");

const LOGIN = (failed) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>sam.toys / dev</title>
<style>
:root{--bg:#0b0b0f;--card:#15151c;--line:#26262f;--text:#f0efe9;--dim:#9a99a6;--accent:#ffb454}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(900px 500px at 15% -10%,rgba(255,180,84,.10),transparent 60%),radial-gradient(900px 500px at 90% 0%,rgba(139,124,255,.10),transparent 55%),var(--bg);color:var(--text);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}.card{width:min(100%,400px)}.mark{font-size:34px;font-weight:800;letter-spacing:-.03em;line-height:1}.mark .dot{color:var(--accent)}.mark .path{color:var(--dim);font-weight:600}.intro{margin:18px 0 24px;color:var(--dim)}input{width:100%;height:50px;border:1px solid var(--line);border-radius:12px;padding:0 14px;background:var(--card);color:var(--text);font:500 17px inherit;outline:none}input:focus{border-color:var(--accent)}.button{width:100%;height:50px;margin-top:12px;border:0;border-radius:12px;background:var(--accent);color:#0b0b0f;font:700 16px inherit;cursor:pointer}.error{margin:14px 0 0;color:#ff8b55;font-size:14px}
</style>
</head>
<body><main class="card">
<div class="mark">sam<span class="dot">.</span>toys <span class="path">/ dev</span></div>
<p class="intro">Private page. Enter the password to continue.</p>
<form method="post" action="/dev">
<input type="password" name="password" autocomplete="current-password" autofocus required>
<button class="button" type="submit">Enter</button>
</form>
${failed ? '<p class="error">Wrong password — try again.</p>' : ""}
</main></body>
</html>`;

function sendLogin(req, res, failed) {
  res.statusCode = 401;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  privateHeaders(res);
  return res.end(req.method === "HEAD" ? "" : LOGIN(failed));
}
function sendText(req, res, status, text) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  privateHeaders(res);
  return res.end(req.method === "HEAD" ? "" : text);
}
function redirect(res, cookie) {
  res.statusCode = 303;
  res.setHeader("Location", "/dev");
  res.setHeader("Set-Cookie", cookie);
  privateHeaders(res);
  return res.end();
}

function handlePost(req, res, secret) {
  const chunks = [];
  let size = 0;
  let finished = false;
  req.on("data", (chunk) => {
    if (finished) return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > 4096) {
      finished = true;
      return sendText(req, res, 413, "Payload too large.");
    }
    chunks.push(data);
  });
  req.on("end", async () => {
    if (finished) return;
    finished = true;
    const type = req.headers["content-type"] || "";
    const form = /^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(type);
    const password = form
      ? new URLSearchParams(Buffer.concat(chunks).toString("utf8")).get("password")
      : null;
    try { await controls.checkLogin(req, "dev"); }
    catch (error) {
      return sendText(req, res, error.status === 429 ? 429 : 503,
        error.status === 429 ? "Too many sign-in attempts. Try again later." : "Sign-in is temporarily unavailable.");
    }
    if (!matches(password === null ? null : password.trim(), secret)) return sendLogin(req, res, true);
    return redirect(res, `${COOKIE}=${issueToken(secret)}; Max-Age=${SESSION_TTL_MS / 1000}; ${COOKIE_ATTRS}`);
  });
  req.on("error", () => {
    if (finished) return;
    finished = true;
    return sendText(req, res, 400, "Invalid request.");
  });
}

module.exports = (req, res) => {
  const SECRET = process.env.DEV_PASSWORD;
  if (!SECRET) return sendText(req, res, 503, "Password not configured.");

  if (!["GET", "HEAD", "POST"].includes(req.method)) {
    res.setHeader("Allow", "GET, HEAD, POST");
    return sendText(req, res, 405, "Method not allowed.");
  }

  if (req.method === "GET" && wantsLogout(req.url)) {
    return redirect(res, `${COOKIE}=; Max-Age=0; ${COOKIE_ATTRS}`);
  }
  if (req.method === "POST") return handlePost(req, res, SECRET);

  const { ok, trusted } = authorize(req, SECRET);
  if (!ok) return sendLogin(req, res, false);
  if (HTML === null) return sendText(req, res, 503, "Page body not deployed.");
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  privateHeaders(res);
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  if (trusted) res.setHeader("Set-Cookie", `${COOKIE}=${issueToken(SECRET)}; Max-Age=${SESSION_TTL_MS / 1000}; ${COOKIE_ATTRS}`);
  return res.end(req.method === "HEAD" ? "" : HTML);
};
