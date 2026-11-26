# QA-Bench v1.0.0 (`NovaOps Workspace Portal`)

Version-locked, self-contained modern web application benchmark fixture for Testigator.

## Design & Reproducibility

- **Version lock**: Zero third-party runtime npm dependencies (`Node.js >= 22.19.0`, standard `node:http` + HTML5/CSS/vanilla ES module SPA).
- **Roles**: Three authentication contexts exercised via cookie sessions (`qp_bench_session`):
  - `anon` (unauthenticated visitor)
  - `user` (`user@novaops.local`)
  - `admin` (`admin@novaops.local`)
- **Dual build modes**:
  - `--clean` (`v1.0.0` clean baseline): establishes clean visual baselines (`desktop` + `mobile`) and validates `/visual-masked` `[data-dynamic]` mask rules.
  - Default regressed build (`v1.1.0`): injects 58 distinct regressions while keeping 5 explicit false-positive controls (`mustNotFind`) green.

## Seeded Regressions (58) + FP Controls (5)

Defined canonically in [groundtruth.json](file:///E:/My_Projects/sqa-agent/benchmark/qa-bench/groundtruth.json) alongside [openapi.json](file:///E:/My_Projects/sqa-agent/benchmark/qa-bench/openapi.json) and [plan.js](file:///E:/My_Projects/sqa-agent/benchmark/qa-bench/plan.js):

| Domain | Seeded Count | Coverage Examples |
|---|---:|---|
| Accessibility (`a11y`) | 14 | Missing `alt`, orphan inputs, unlabeled icon buttons, low contrast, missing `<title>`/`lang`, heading skips, invalid ARIA role, missing `<iframe>` title, malformed `<ul>`, positive `tabindex`, nested interactive controls |
| Security (`security`) | 14 | Plain HTTP transport, 5 missing security headers, insecure cookie attributes (`HttpOnly`, `SameSite`), GET SQL error leak (`SQLITE_ERROR`), POST body SQLi tautology bypass, login form SQLi bypass, DOM XSS (`/#/search`), 2 unauthenticated `/api/admin/*` endpoints |
| API & Runtime (`api_runtime`) | 14 | 500/502 API regressions, OpenAPI/schema type & missing-field drift, authenticated `/api/user/*` contract failures, fuzz 500 crashes, broken 404/500 internal links, failed XHR/img requests, `console.error`, uncaught JS `TypeError` |
| End-to-End (`e2e`) | 8 | Broken user login welcome state, `$NaN` pricing calculator, settings persistence revert, filter mismatch, modal confirm no-op, failed CSV export, admin maintenance 403 error, blocked onboarding step 2 |
| Visual (`visual`) | 4 | Hero banner layout & color shift (`/`), horizontal tier card shift (`/pricing`), checkout summary overlay (`/checkout`), document height expansion (`/reports`) |
| Performance (`perf`) | 4 | Slow TTFB (`>950ms`), slow LCP image (`>2600ms`), `3.4MB` CSS payload (`>3MB`), slow analytics API (`>1100ms`) |
| **FP Controls (`mustNotFind`)** | **5** | Clean accessible `/clean-health`, textContent-escaped `/search-safe`, healthy `/api/health`, session-gated `401` `/api/orders/private`, masked dynamic ticker `/visual-masked` (`[data-dynamic]`) |

## Methodology

Run via [benchmark/run-qa-bench.mjs](file:///E:/My_Projects/sqa-agent/benchmark/run-qa-bench.mjs):

1. Start `qa-bench` in `--clean` mode, seed `user` and `admin` `SessionStore` sessions (`qa-bench-roles`), and capture clean visual baselines (`[data-dynamic]` masked on `/visual-masked`).
2. Switch `qa-bench` to `regressed` mode without restarting or changing port.
3. Run Testigator across:
   - **Heuristic discovery (`testigator check` with `SQA_LLM_PROVIDER=mock`)**: zero-LLM baseline + `--openapi` + `--login qa-bench-roles`.
   - **Local Ollama discovery (`testigator check --llm-preset ollama`)**: local `gemma:2b` model with zero cloud API keys (`OPENAI_API_KEY` empty).
   - **Deterministic approved plan replay (`testigator replay plan.json`)**: executes explicit multi-role E2E flows, API response schemas/latency budgets, visual baselines, a11y, fuzz, injection, authz, and perf budgets.

## Playwright Agents Note

Checked `npx playwright init-agents --help` (Playwright `1.63.0`): it only initializes prompt configurations for interactive IDE/coding-agent loops (`--loop` choices: `"claude"`, `"codex"`, `"copilot"`, `"opencode"`, `"vscode"`, `"vscode-legacy"`). Because Playwright Agents offers no standalone headless autonomous CLI mode comparable to `testigator check`, it is excluded rather than fabricated.
