# Vendored Sam ID client

Source: `fnaticsam/sam-id`, commit
`6eb4e830a3199a6a9e19324df6bf947f8f09191f`,
`packages/client/index.ts` (Git blob
`d450bcde08292435e84c8452a18071e2433fb14c`). The Air checkout was unavailable
on ai-box; the source, root README, SPEC and client README were read through
the connected GitHub repository. The source blob was checked at that commit.

`index.ts` is the unchanged upstream file. `index.mjs` strips TypeScript types
and formats the JavaScript, so this CommonJS repository can import it without a build
step. Regenerate using Node 24:

```sh
node --input-type=module -e 'import {readFileSync,writeFileSync} from "node:fs"; import {stripTypeScriptTypes} from "node:module"; writeFileSync("api/_lib/samid/index.mjs", "// Generated from index.ts with Node 24 stripTypeScriptTypes; see README.md.\n"+stripTypeScriptTypes(readFileSync("api/_lib/samid/index.ts","utf8"), {mode:"transform"}));'
```

The only dependency is `jose` 6.2.3, pinned in this directory's manifest and
lockfile. Install it with `npm ci --prefix api/_lib/samid`. The root manifest
and lockfile are deliberately untouched for this packet. See
[`docs/FLIGHTS-AUTH.md`](../../../docs/FLIGHTS-AUTH.md) for the Vercel install
command, function settings and rewrites required during integration.

The upstream client owns state, nonce, S256 PKCE, Basic client authentication,
ES256 verification and request-local transaction cookies. Every callback
attempt clears those cookies. The application owns its 12-hour signed session.
