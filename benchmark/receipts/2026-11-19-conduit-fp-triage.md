# QualityPilot false-positive triage — RealWorld/Conduit

- **Date:** 2026-11-19
- **Target:** https://demo.realworld.show
- **QualityPilot:** package version 0.4.0 · commit **not recorded** (receipt predates audit M-8 provenance capture; SHA left null rather than guessed)
- **Run:** `run_matrix_1795076912219_0de80c0b`
- **Command:** `qualitypilot check https://demo.realworld.show --authorized-target --max-pages 12 --max-depth 2 --timeout 2400000 --format json`
- **Crawl:** 140 URLs deduplicated
- **Status:** completed
- **Post-dedup findings:** 95
- **Gate score:** 0

## Result

The active false-positive-sensitive checks returned no:

- SQL or DOM injection findings
- Missing authorization findings

The remaining 95 findings covered 17 rule families, led by performance budgets,
accessibility checks, visual observations, and missing HTTP security headers.
No destructive writes were performed: the scan used unauthenticated public pages
and active injection checks against the explicitly authorized target.

## Finding families

| Family | Count | Triage |
|---|---:|---|
| `perf-budget-*` | 57 | Performance observations based on browser timing budgets |
| `axe-*` | 13 | Accessibility findings; browser/runtime dependent |
| `visual-*` | 17 | Visual baseline or viewport observations |
| HTTP security headers | 8 | Missing or invalid header findings on the public demo |

The 95 total is the deduplicated run count. The table is a family summary,
not a claim that every finding is a defect or a false positive. The Conduit
spec's `401`, `404`, `409`, and `422` responses were not treated as defects in
the false-positive-sensitive injection and authorization checks.
