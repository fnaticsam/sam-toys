# Flights v4 performance evidence

Measured on ai-box, 30 October 2026, Node v24.20.0. Five iterations per case, medians below. The benchmark executes the actual inline application script with a minimal DOM, a fixed fixture date, reduced motion, normalized recorded search cards, and a controlled 120 ms asynchronous provider delay. It uses no browser or live network.

These are JavaScript-to-DOM-write and data-readiness timings. They do **not** establish actual paint timing, INP, layout stability, smoothness, or feedback latency for every physical tap. Browser validation remains with the reviewer, as requested.

| Measurement | Before | v4 |
| --- | ---: | ---: |
| Cold search: first loading-shell DOM write | 0.29 ms | 1.60 ms |
| Cold search: result data rendered | 124.20 ms | 127.04 ms |
| Repeat query in the same page: result data rendered | 123.52 ms | 3.51 ms |
| Repeat query in a new page sharing sessionStorage: result data rendered | 123.58 ms | 3.81 ms |
| Direct results-history entry restored on a new page | unavailable; search view fallback | 5.61 ms inline initialization |
| Search requests per repeated query | 1 | 0 |
| Search requests per new-page session query | 1 | 0 |
| Flex request started alongside cold search | no | yes, all 5 runs |

Both versions wrote a loading skeleton before the delayed provider resolved in all five cold runs. The baseline already had synchronous shell feedback; v4 adds a richer skeleton and route shell, so this experiment shows a small cold-render cost rather than a cold-search speedup. The substantial measured gain comes from removing the repeated search round trip.

In the first v4 cold trace, the search request began at 2.64 ms and flex began at 2.85 ms, before the search response. The baseline started search at 3.46 ms and made no parallel flex request. A new page can restore cached cards immediately while independently warming flex; that warmup does not block the reported search-ready time. Direct history restoration succeeded in all 5 v4 runs with zero search requests; baseline restoration succeeded in none.

The DOM stub deliberately does not parse HTML, perform style or layout work, or synthesize browser input. It observes actual application DOM assignments and calls actual search/cache/history functions. Back/forward browser event delivery, pointerdown timing, font loading, animation, phone layout, CLS, and perceived feedback require the browser checks and reviewer inspection.

Reproduce the comparison without a browser:

```sh
git show 7b7a760:flights/index.html > /tmp/flights-before-v4.html
node tests/flights/perf-check.cjs --baseline /tmp/flights-before-v4.html --runs 5 --verify
```

The baseline inline script at `7b7a760` matches the pre-change snapshot exactly (SHA-256 `797cf0c292ccb0b6640c8d3e49d3053a916f8fc6512c9cbb38a68ca592ae6e95`). The benchmark accepts either a whole HTML file or an extracted inline script. `--verify` passed six contracts: skeleton before provider completion, parallel flex startup, same-page cache reuse, session cache reuse in a new page, results-history restoration, and median shell DOM-write time below 100 ms. This benchmark is separate from the unit-test counts.

Final validation: flights unit tests pass; the full Node run still requires the ignored private `api/_lib/dev.html`, which was not shipped to this mirror. Browser checks were extended and syntax-checked, but were not run per the task boundary. The Opus design-review packet was attempted with `FACTORY_TASK_CLASS=design-review`; the launcher could not create its detached worktree because the shared clone Git metadata is read-only in this sandbox. Rendered desktop/phone comparison and Opus review remain pending with the reviewer.
