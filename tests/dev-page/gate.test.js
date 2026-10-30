// Acceptance test for api/dev.js: drives the handler with mock req/res objects.
// Usage: node gate.test.js (uses dummy credentials)
const assert = require("assert");
const crypto = require("crypto");
const { EventEmitter } = require("events");
const path = require("path");

const fs = require("fs");
const REPO = process.env.REPO_DIR || path.resolve(__dirname, "..", "..");

// The private guide is deliberately absent from public checkouts and CI.
if (!fs.existsSync(path.join(REPO, "api", "_lib", "dev.html"))) {
  require("node:test").test("dev-page: gate", {
    skip: "api/_lib/dev.html is private and absent from this checkout",
  }, () => {});
} else {
process.env.DEV_PASSWORD = "test-dev-password-not-real";
delete process.env.DEV_TRUSTED_IPS;
const handler = require(path.join(process.env.REPO_DIR || path.resolve(__dirname, "..", ".."), "api", "dev.js"));

function makeReq({ method = "GET", url = "/dev", headers = {}, body = null }) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  process.nextTick(() => {
    if (body !== null) req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}
function makeRes() {
  const res = { statusCode: 200, headers: {}, body: "" };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.end = (chunk) => { res.body = chunk || ""; res._resolve(res); };
  res.done = new Promise((r) => { res._resolve = r; });
  return res;
}
async function call(opts) { const res = makeRes(); handler(makeReq(opts), res); return res.done; }
const sign = (secret, t) => crypto.createHmac("sha256", secret).update(`dev-session-v2|${t}`).digest("hex");
const TOKEN_RE = /^dev_session=(\d+\.[0-9a-f]{64}); Max-Age=31536000; Path=\/dev; HttpOnly; Secure; SameSite=Lax$/;

(async () => {
  const PASS = process.env.DEV_PASSWORD;
  assert.ok(PASS, "DEV_PASSWORD must be set for the test");
  const results = [];
  const check = (name, cond) => { results.push([name, !!cond]); if (!cond) process.exitCode = 1; };
  const isPrivate = (r) => /no-store/.test(r.headers["cache-control"] || "") && /noindex/.test(r.headers["x-robots-tag"] || "");

  // 1. GET without cookie -> 401 login page
  let r = await call({});
  check("GET no cookie -> 401", r.statusCode === 401);
  check("401 has login form", /<form method="post" action="\/dev">/.test(r.body));
  check("401 no-store + noindex", isPrivate(r));
  check("401 does not leak page body", !/id="factory-what"/.test(r.body));
  check("401 shows no error on first visit", !/Wrong password/.test(r.body));

  // 2. HEAD without cookie -> 401 empty body
  r = await call({ method: "HEAD" });
  check("HEAD no cookie -> 401 empty", r.statusCode === 401 && r.body === "");

  // 3. POST wrong password -> 401 with error, no cookie
  r = await call({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "password=nope" });
  check("POST wrong -> 401 with error, no cookie", r.statusCode === 401 && /Wrong password/.test(r.body) && !r.headers["set-cookie"]);

  // 4. wrong-length guesses are rejected identically (no length short-circuit path)
  r = await call({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "password=" + encodeURIComponent(PASS + "x") });
  check("POST right+1 char -> 401", r.statusCode === 401 && !r.headers["set-cookie"]);

  // 5. POST wrong content-type -> 401
  r = await call({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: PASS }) });
  check("POST json body ignored -> 401", r.statusCode === 401 && !r.headers["set-cookie"]);

  // 6. POST right password -> 303 + time-bound cookie scoped to /dev
  r = await call({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "password=" + encodeURIComponent(PASS) });
  check("POST right -> 303 to /dev", r.statusCode === 303 && r.headers["location"] === "/dev" && isPrivate(r));
  const m = TOKEN_RE.exec(r.headers["set-cookie"] || "");
  check("cookie: Path=/dev, Max-Age 30d, HttpOnly, Secure, SameSite=Lax, token <issued>.<hmac>", !!m);
  const token = m ? m[1] : "";
  const issued = Number(token.split(".")[0]);
  check("token issued-at is now-ish", Math.abs(Date.now() - issued) < 5000);
  check("token mac matches v2 signing", token.split(".")[1] === sign(PASS, issued));
  check("token is not the password", !token.includes(PASS));

  // 7. two logins produce different tokens (issue time differs)
  await new Promise((res) => setTimeout(res, 3));
  const r2 = await call({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "password=" + encodeURIComponent(PASS) });
  const m2 = TOKEN_RE.exec(r2.headers["set-cookie"] || "");
  check("second login -> different token", m2 && m2[1] !== token);

  // 8. GET with valid cookie -> 200 page
  r = await call({ headers: { cookie: "foo=bar; dev_session=" + token } });
  check("GET valid cookie -> 200", r.statusCode === 200);
  check("200 serves page", /<title>sam\.toys \/ dev<\/title>/.test(r.body) && /id="factory-what"/.test(r.body) && /id="box-what"/.test(r.body));
  check("200 private no-store, noindex, no-referrer", r.headers["cache-control"] === "private, no-store, max-age=0" && /noindex/.test(r.headers["x-robots-tag"]) && r.headers["referrer-policy"] === "no-referrer");
  r = await call({ method: "HEAD", headers: { cookie: "dev_session=" + token } });
  check("HEAD valid cookie -> 200 empty", r.statusCode === 200 && r.body === "");

  // 9. tampered / forged / expired / future tokens -> 401
  const mac = token.split(".")[1];
  r = await call({ headers: { cookie: "dev_session=" + issued + "." + mac.replace(/^./, (c) => (c === "0" ? "1" : "0")) } });
  check("tampered mac -> 401", r.statusCode === 401);
  r = await call({ headers: { cookie: "dev_session=" + (issued + 1) + "." + mac } });
  check("tampered issued-at -> 401", r.statusCode === 401);
  const old = Date.now() - 366 * 24 * 60 * 60 * 1000;
  r = await call({ headers: { cookie: "dev_session=" + old + "." + sign(PASS, old) } });
  check("expired (366 days) -> 401", r.statusCode === 401);
  const fresh = Date.now() - 364 * 24 * 60 * 60 * 1000;
  r = await call({ headers: { cookie: "dev_session=" + fresh + "." + sign(PASS, fresh) } });
  check("364-day-old valid token -> 200", r.statusCode === 200);
  const future = Date.now() + 10 * 60 * 1000;
  r = await call({ headers: { cookie: "dev_session=" + future + "." + sign(PASS, future) } });
  check("future-dated (10 min) -> 401", r.statusCode === 401);
  r = await call({ headers: { cookie: "dev_session=" + sign(PASS, issued) } });
  check("v1-style constant token -> 401", r.statusCode === 401);
  r = await call({ headers: { cookie: "dev_session=" + issued + "." + crypto.createHmac("sha256", PASS).update("dev-session-v1").digest("hex") } });
  check("v1 label signed token -> 401", r.statusCode === 401);
  r = await call({ headers: { cookie: "lp_session=" + token } });
  check("lp_session cookie ignored -> 401", r.statusCode === 401);

  // 10. logout clears cookie on the same path
  r = await call({ url: "/dev?logout=1", headers: { cookie: "dev_session=" + token } });
  check("logout -> 303 + cleared cookie on /dev", r.statusCode === 303 && /^dev_session=; Max-Age=0; Path=\/dev; HttpOnly; Secure; SameSite=Lax$/.test(r.headers["set-cookie"]) && isPrivate(r));

  // 10b. hardening headers and strict parsing
  r = await call({});
  check("401 has nosniff + X-Frame-Options DENY + no-referrer", r.headers["x-content-type-options"] === "nosniff" && r.headers["x-frame-options"] === "DENY" && r.headers["referrer-policy"] === "no-referrer");
  r = await call({ headers: { cookie: "dev_session=" + token } });
  check("200 has nosniff + X-Frame-Options DENY", r.headers["x-content-type-options"] === "nosniff" && r.headers["x-frame-options"] === "DENY");
  r = await call({ url: "/dev?notlogout=1&x=logout=1", headers: { cookie: "dev_session=" + token } });
  check("substring 'logout=1' in another param does not log out", r.statusCode === 200 && !r.headers["set-cookie"]);
  r = await call({ url: "/dev?logout=1&other=2", headers: { cookie: "dev_session=" + token } });
  check("logout=1 among other params logs out", r.statusCode === 303);
  r = await call({ headers: { cookie: "dev_session=0" + issued + "." + mac } });
  check("leading-zero issued-at rejected -> 401", r.statusCode === 401);

  // 10c. trusted-IP auto-admit (DEV_TRUSTED_IPS), only via Vercel's x-real-ip
  process.env.DEV_TRUSTED_IPS = "203.0.113.5, 198.51.100.7";
  r = await call({ headers: { "x-real-ip": "203.0.113.5" } });
  check("trusted x-real-ip, no cookie -> 200", r.statusCode === 200 && /id="factory-what"/.test(r.body));
  const tm = TOKEN_RE.exec(r.headers["set-cookie"] || "");
  check("trusted admit sets a valid year-long session cookie", !!tm && tm[1].split(".")[1] === sign(PASS, Number(tm[1].split(".")[0])));
  r = await call({ headers: { "x-real-ip": "198.51.100.7" }, method: "HEAD" });
  check("second trusted ip, HEAD -> 200 empty", r.statusCode === 200 && r.body === "");
  r = await call({ headers: { "x-real-ip": "203.0.113.9" } });
  check("untrusted x-real-ip -> 401", r.statusCode === 401 && !r.headers["set-cookie"]);
  r = await call({ headers: { "x-forwarded-for": "203.0.113.5" } });
  check("x-forwarded-for alone is not trusted -> 401", r.statusCode === 401);
  r = await call({ headers: { "x-real-ip": "203.0.113.9", "x-forwarded-for": "203.0.113.5" } });
  check("spoofed x-forwarded-for with untrusted x-real-ip -> 401", r.statusCode === 401);
  r = await call({ headers: { "x-real-ip": "203.0.113.5", cookie: "dev_session=" + token } });
  check("trusted ip with existing valid cookie -> 200, no new cookie", r.statusCode === 200 && !r.headers["set-cookie"]);
  r = await call({ headers: { "x-real-ip": "203.0.113.5", cookie: "dev_session=" + old + "." + sign(PASS, old) } });
  check("trusted ip with expired cookie -> 200 and a fresh cookie", r.statusCode === 200 && TOKEN_RE.test(r.headers["set-cookie"] || ""));
  process.env.DEV_TRUSTED_IPS = "";
  r = await call({ headers: { "x-real-ip": "203.0.113.5" } });
  check("empty allow-list trusts nobody -> 401", r.statusCode === 401);
  delete process.env.DEV_TRUSTED_IPS;
  r = await call({ headers: { "x-real-ip": "203.0.113.5" } });
  check("unset allow-list trusts nobody -> 401", r.statusCode === 401);

  // 11. oversized POST -> 413
  r = await call({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "password=" + "x".repeat(5000) });
  check("oversized POST -> 413 private", r.statusCode === 413 && isPrivate(r));

  // 12. other methods -> 405 with Allow, no-store, text/plain
  r = await call({ method: "PUT" });
  check("PUT -> 405 + Allow + private + text/plain", r.statusCode === 405 && r.headers["allow"] === "GET, HEAD, POST" && isPrivate(r) && /text\/plain/.test(r.headers["content-type"]));

  // 13. missing secret -> 503 fail closed, private
  delete process.env.DEV_PASSWORD;
  r = await call({ headers: { cookie: "dev_session=" + token } });
  check("no secret -> 503 even with cookie", r.statusCode === 503 && isPrivate(r));

  for (const [name, ok] of results) console.log((ok ? "PASS" : "FAIL") + "  " + name);
  console.log(results.filter((x) => x[1]).length + "/" + results.length + " checks passed");
})().catch((e) => { console.error(e); process.exit(1); });

}
