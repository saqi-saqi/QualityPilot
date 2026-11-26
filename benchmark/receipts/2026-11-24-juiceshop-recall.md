# QualityPilot recall benchmark — OWASP Juice Shop v20.4.0 (Windows standalone zip)

- **Run:** run_matrix_1795515851938_53b7275d · status `completed` · score 0
- **Tooling:** qualitypilot@0.5.0 · commit `f66d9015d152fc08522b136ba379a2289c495c33` · **working tree dirty** — the run predates the commit of the v0.6.0 LLM-preset work (`README.md`, `src/cli/check.js`, `src/explorer/llmProvider.js`, `test/llmPresets.test.js`). Those files touch planning/CLI only; no executor, matrix or SSRF code differs, so the scanned surface is unchanged. Plan inference in this benchmark is the deterministic heuristic path (no LLM configured).
- **Scan params:** max-pages 12, max-depth 2, timeout 900000ms, wall time 189s
- **Findings (post-dedup):** 78 findings across 25 distinct rules

## Recall: 10/10 = **100%**

| # | ruleId | severity | detector | status |
|---|--------|----------|----------|--------|
| JS-EXP-01 | `header-content-security-policy` | high | security | ✅ detected |
| JS-EXP-02 | `header-referrer-policy` | low | security | ✅ detected |
| JS-EXP-03 | `header-permissions-policy` | low | security | ✅ detected |
| JS-EXP-04 | `header-cross-origin-opener-policy` | low | security | ✅ detected |
| JS-EXP-05 | `header-cross-origin-resource-policy` | low | security | ✅ detected |
| JS-EXP-06 | `transport-http` | high | security | ✅ detected |
| JS-EXP-07 | `injection-sqli` | high | injection | ✅ detected |
| JS-EXP-08 | `injection-sqli-error` | medium | injection | ✅ detected |
| JS-EXP-09 | `injection-xss-dom` | high | injection | ✅ detected |
| JS-EXP-10 | `authz-missing` | medium | authz | ✅ detected |

## Must-not-find (false-positive guard): ✅ all clear

## Observational findings (not scored) — 15 distinct rules

| ruleId | count | severity |
|--------|-------|----------|
| `visual-regression-viewport` | 15 | low |
| `broken-link-404` | 11 | info |
| `visual-baseline-captured` | 9 | info |
| `perf-budget-TBT` | 8 | medium |
| `axe-color-contrast` | 6 | serious |
| `axe-label-content-name-mismatch` | 5 | serious |
| `axe-label` | 3 | critical |
| `axe-link-in-text-block` | 2 | serious |
| `perf-budget-CLS` | 2 | high |
| `api-status-mismatch` | 1 | low |
| `axe-aria-prohibited-attr` | 1 | serious |
| `axe-button-name` | 1 | critical |
| `axe-document-title` | 1 | serious |
| `axe-html-has-lang` | 1 | serious |
| `visual-regression` | 1 | medium |

## Reproduce

```bash
# with Juice Shop v20.4.0 serving on :3000
SQA_ALLOW_PRIVATE=true ALLOW_PRIVATE_HOSTS=true \
  node benchmark/run-recall-benchmark.mjs --base-url http://127.0.0.1:3000 --min-recall 1.0
```
