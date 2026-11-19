# QualityPilot recall benchmark — OWASP Juice Shop v20.4.0 (Windows standalone zip)

- **Run:** run_matrix_1795076779880_ba4b4d0f · status `completed` · score 0
- **Scan params:** max-pages 12, max-depth 2, timeout 2400000ms, wall time 183s
- **Findings (post-dedup):** 62 distinct rules: 24

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

## Observational findings (not scored) — 14 distinct rules

| ruleId | count | severity |
|--------|-------|----------|
| `visual-regression-viewport` | 14 | low |
| `visual-baseline-captured` | 9 | info |
| `axe-label-content-name-mismatch` | 7 | serious |
| `perf-budget-TBT` | 7 | medium |
| `axe-label` | 3 | critical |
| `axe-color-contrast` | 2 | serious |
| `perf-budget-CLS` | 2 | high |
| `api-status-mismatch` | 1 | low |
| `axe-aria-prohibited-attr` | 1 | serious |
| `axe-link-in-text-block` | 1 | serious |
| `axe-document-title` | 1 | serious |
| `axe-html-has-lang` | 1 | serious |
| `axe-button-name` | 1 | critical |
| `visual-regression` | 1 | medium |
