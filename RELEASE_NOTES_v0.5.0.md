# v0.5.0 — audit remediation: a green gate has to be earned

This release is the remediation of an independent adversarial audit of the scan pipeline, the CI gate, and the outbound integrations. 24 findings (3 High, 8 Medium, 10 Low, 3 Nit) were fixed, plus two same-class defects found while fixing them.

The headline: **a passing replay can no longer skip the work.** Matrix cells that fail now fail the run, missing login sessions fail the run, and executor names that would produce zero cells fail loudly instead of returning a perfect score.

## Upgrade notes (read this first)

These are deliberate behavior changes — `0.5.0` is a minor bump because `0.4.1` would misrepresent them.

- **`qualitypilot replay` exits 70 when matrix cells fail or abort.** A broken replay used to score an empty finding set and exit 0 with `PASS`. Pipelines that were silently green will now go red — that is the fix, not a regression.
- **Default scans now include `legacy-links`, `legacy-console` and `legacy-network`.** These executors were listed in the default plan but had no matrix cell and never ran. They now run in one site-wide cell, so scans can produce new link/console/network findings and take longer. They are observational in the benchmark ground truth (never scored).
- **Unknown executor names in a plan are a hard error** (exit 70) instead of a zero-cell green run. Names that were silently dead now either run (`legacy-*`) or fail with the known-executor list.
- **`--login <recording>` with a nonexistent recording fails the run** instead of silently scanning anonymously.
- **JUnit marks waived findings `<skipped type="waived">`; SARIF adds `suppressions`.** Artifacts now agree with an exit-0 gate.
- **Replay honors `--timeout` and `--max-pages`.** Both were parsed and ignored; a hung replay could outlive the Action's patience.
- **`check --openapi` actually imports the spec.** The parsed spec was dropped before execution — the flag was a silent no-op.

## High

- **H-1** — Replay fails (exit 70) on failed/aborted matrix cells and prints the failing cell errors.
- **H-2** — `--authorized-target` is threaded to the execution matrix, so active injection probing works on non-loopback staging targets; `replay` and the GitHub Action gained `authorized_target` / `--authorized-target`. Same-class fix: `--openapi` was dropped by `createRunWithMatrix`.
- **H-3** — Issue-tracker bodies scrub description/evidence/repro steps/suggested fixes through the same credential boundary as MCP responses; security cookie findings no longer embed cookie values; API-contract evidence is scrubbed and truncated.

## Medium

- **M-1** — Missing explicit login recording fails the run.
- **M-2** — Waiver-aware JUnit + SARIF (see upgrade notes).
- **M-3** — Unknown executors throw; page-scoped `legacy-*` checks are scheduled (one site-wide cell) and receive the crawled page data they need.
- **M-4** — Removed the destructive `DROP`/`UNION` SQL payloads from the fuzz generators (executor and input matrix).
- **M-5** — Replay `--timeout` aborts the matrix at the deadline → exit 70.
- **M-6** — Failed security-header probes emit an event and no longer inflate `pagesAudited` (`pagesProbeFailed` added).
- **M-7** — `safeFetch` composes a per-hop deadline with the caller's abort signal, so one hanging endpoint can't stall an executor until the run aborts.
- **M-8** — README benchmark numbers aligned to the committed receipt; every new receipt records `tooling {version, commit, dirty}`.

## Low / Nit

- e2e **and** visual flows apply their viewport via `page.setViewportSize` (the `newPage({ viewport })` argument was ignored).
- axe-core is injected only from the local install — the unpinned CDN fallback is gone (executor + MCP quick check).
- TestRail and Xray validate their credential-bearing base URLs before attaching credentials.
- MCP quick-check pins the validated IP in Chromium (DNS-rebinding parity with the scan pool).
- Severity/confidence keys are case-normalized in scoring and gates (`"Medium"` no longer deducts 0).
- A non-GET 5xx API-contract mismatch is no longer downgraded to "anonymous replay"; 4xx auth/CSRF-shaped mismatches still are.
- `authz` skips an unusable base URL instead of aborting the whole probe loop, and announces cap truncation.
- The DOM-XSS sink probe falls back to the captured search endpoint for path-routed/SSR apps.
- Page-scope promotion requires ≥3 covered pages and a failing minority.
- Run-to-run diff normalizes URLs (trailing slash, host case, default port); hash routes stay distinct.
- Gate reasons are rounded to one decimal; replay scores coverage; `--max-pages` caps the plan page set.

## Verification

- Full suite: **1,157 tests / 240 suites / 0 fail** (baseline before this work: 1,128 / 234 / 0).
- Live checks: replay with an unlaunchable browser cell → exit 70; missing `--login` → run failed; fixture scan → 5/5 cells ok including the site-wide legacy cell; `check --openapi` → live `OpenAPI import: 1 endpoint(s)` event.
- Benchmark gate: the nightly workflow re-verifies recall with `--min-recall 1.0` and fails on any regression or false-positive-guard hit. Dispatch it before tagging so the release receipt reflects the new default surface.

## Known limitations (unchanged)

- axe emits `serious` severities that are not part of the gate's severity ranking — `--fail-on high` does not count them yet (tracked for a product decision).
- `--min-score` deliberately keeps using the unwaived run score.
- Playwright browsers are required for browser cells; `npx playwright install chromium` on fresh machines.

## Install / pin

```bash
npm install -g qualitypilot@0.5.0
```

```yaml
- uses: saqi-saqi/QualityPilot@v0.5.0
  with:
    plan: qualitypilot/plan.json
    url: ${{ secrets.PREVIEW_URL }}
    fail_on: critical,high
```
