# sam.toys — repo guide & boundaries

This repo is **`fnaticsam/sam-toys`**, deployed as the Vercel project **`sam-toys`** → **https://sam.toys**.
It is a collection of independent, self-contained static toys, one per top-level folder. No build step; each is a single `index.html` (+ assets). Deploy with `vercel deploy --prod --yes` from this directory (the GitHub→Vercel webhook is unreliable). Always dry-run a preview deploy first, then read back the **public prod URL** (preview URLs are SSO-gated → 302).

## ⚠️ SECURITY REMEDIATION IS ACTIVE

The canonical backlog is **GitHub issue [#2 — Security remediation backlog](https://github.com/fnaticsam/sam-toys/issues/2)**. Read it before modifying backend/API behavior or deploying `sam.toys`.

- Prioritize the P0/P1 security items ahead of new backend features: durable abuse controls for paid Gemini endpoints, explicit `.env*` exclusions, refresh authentication/method/timeout hardening, and clear upload privacy disclosure.
- Never print, paste, commit, stage, package, upload, or include secret values in issues, logs, diffs, test output, screenshots, or agent reports. Preserve the existing untracked `.env.prod`; do not delete or overwrite it without explicit approval.
- Treat `Origin` checks and process-local in-memory rate limits as defence in depth, not authentication or durable abuse prevention.
- Make security changes in small reviewable packets. Add targeted tests, run dependency/secret checks, deploy a preview first, verify public behavior and headers, then obtain an independent security review before closing issue #2.
- The issue is public: update its checkboxes and evidence, but put no credentials, subscriber data, private request payloads, or exploit instructions there.

## Folders → live URLs
- `api/dev.js` + `api/dev-ask.js` → **https://sam.toys/dev** — private operator guide (factory + dev box) behind one password (`DEV_PASSWORD`) with trusted-IP auto-admit (`DEV_TRUSTED_IPS`), plus "Ask dev" (`POST /dev/ask`, Gemini). **The page body `api/_lib/dev.html` is git-ignored on purpose (public repo) and deployed from the working tree** — see `api/_lib/DEV-PAGE.md`; tests in `tests/dev-page/`.
- `tantra/index.html`  → **https://sam.toys/tantra** — "The Loom of Union" tantra course (Ink & Gold Thread design). `noindex`.
- `taotime/index.html` → **https://sam.toys/taotime** — *LEGACY* copy of the Watercourse Way site (see boundary below).
- `voicenotes/index.html` → **https://sam.toys/voicenotes** — WhatsApp voice-note → transcript + bullets (WhatsApp-dark chat UI). `noindex`. Backed by `api/transcribe.js` (Vercel function → Gemini `gemini-3.5-flash` audio input; needs `GEMINI_API_KEY` prod env var, set 2026-07-13). `vercel.json` exists only to give that function `maxDuration: 60`. This is the one exception to "no backend" here — keep new toys static unless there's a real reason.

## ⚠️ CRITICAL BOUNDARY: there are TWO "taotime" things. Do not conflate them.
1. **taotime.me = the PRIMARY / live Watercourse Way site.** It is a *separate project entirely*:
   - codebase: **`~/Code/taotime`** — its own git repo, its own **private GitHub repo `fnaticsam/taotime`** (separate from this `sam-toys` repo; backup only, deploy is still manual `vercel deploy --prod`)
   - Vercel project: **`taotime`** (prj_qQXiAkwyEo095RpBGQCrMdiQKkty), domain **taotime.me**
   - **NOTHING in this repo affects taotime.me.** Editing/deleting `sam-toys`'s `taotime/` folder or any `sam-toys` branch has ZERO effect on taotime.me.
2. **sam.toys/taotime = a stale LEGACY mirror** living in this repo's `taotime/` folder. It is not the source of truth; taotime.me is. Don't invest work here; if anything, this folder may eventually be retired (but it's live at 200 today — don't delete without explicit say-so).

**Rule of thumb:** "watercourse / Tao / taotime.me work" → go to `~/Code/taotime`, deploy the `taotime` Vercel project. "sam.toys/anything" (incl. the legacy `taotime/` mirror, and `tantra/`) → this repo, deploy `sam-toys`. When in doubt, check `.vercel/project.json` (this repo = `sam-toys`) before deploying.

## Branches
Keep it to `main`. Stale/abandoned branches are deleted, not merged — and a sam-toys branch can never touch taotime.me regardless.
@docs/PROJECT.md
