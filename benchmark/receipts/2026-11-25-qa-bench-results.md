# QA-Bench v1.0.0 Benchmark Receipt (2026-11-25)

- **QualityPilot**: v0.5.0 (commit `f66d9015d152fc08522b136ba379a2289c495c33`)
- **Target**: NovaOps Workspace Portal (benchmark/qa-bench v1.0.0) (version 1.0.0)
- **Roles seeded**: anon, user, admin
- **Ground truth**: 58 seeded regressions across a11y, security, api_runtime, e2e, visual, perf + 5 false-positive controls

## Summary Matrix

| Mode | Wall Time (ms) | Matched / Total | Recall | FP Violations | Total Findings |
|---|---:|---:|---:|---:|---:|
| Heuristic Check (no LLM) | 110560 | 41 / 58 | 70.7% | 0 / 5 | 121 |
| Local Ollama Check (gemma:2b) | 344812 | 41 / 58 | 70.7% | 0 / 5 | 113 |
| Replay Approved Plan (plan.json) | 176273 | 52 / 58 | 89.7% | 0 / 5 | 69 |

## Recall by Domain

| Domain | Seeded | Heuristic Check (no LLM) | Local Ollama Check (gemma:2b) | Replay Approved Plan (plan.json) |
|---|---:|---:|---:|---:|
| a11y | 14 | 14/14 (100%) | 14/14 (100%) | 14/14 (100%) |
| security | 14 | 14/14 (100%) | 14/14 (100%) | 14/14 (100%) |
| api_runtime | 14 | 6/14 (43%) | 6/14 (43%) | 8/14 (57%) |
| e2e | 8 | 0/8 (0%) | 0/8 (0%) | 8/8 (100%) |
| visual | 4 | 4/4 (100%) | 4/4 (100%) | 4/4 (100%) |
| perf | 4 | 3/4 (75%) | 3/4 (75%) | 4/4 (100%) |

## Playwright Agents Assessment

- **Status**: excluded
- **Reason**: Playwright 1.63.0 `npx playwright init-agents --help` provides --loop choices ("claude", "codex", "copilot", "opencode", "vscode", "vscode-legacy") for interactive IDE coding agents rather than a standalone headless autonomous CLI scanner.

## Run Details: Heuristic Check (no LLM)

- **Command**: `qualitypilot check http://127.0.0.1:55973 --openapi openapi.json --login qa-bench-roles --allow-private --max-pages 18 --max-depth 2 --concurrency 4 --timeout 360000 --fail-on none --format json (SQA_LLM_PROVIDER=mock)`
- **False-positive violations**: 0 / 5
- **Missed expectations (17)**:
  - `QB-API-01` (api_runtime / `api-status-mismatch, network-first-party-500` @ `/api/billing/summary`): GET /api/billing/summary regressed from 200 to 500
  - `QB-API-02` (api_runtime / `api-schema-mismatch` @ `/api/projects/active`): GET /api/projects/active missing ownerEmail and returns totalCount as string
  - `QB-API-03` (api_runtime / `api-schema-mismatch` @ `/api/deployments/latest`): GET /api/deployments/latest returns string 'yes' for boolean healthy
  - `QB-API-04` (api_runtime / `api-status-mismatch` @ `/api/webhooks/ping`): POST /api/webhooks/ping regressed from 200 to 502
  - `QB-API-05` (api_runtime / `api-schema-mismatch` @ `/api/user/profile`): Authenticated GET /api/user/profile drops required email and role fields
  - `QB-API-06` (api_runtime / `api-status-mismatch` @ `/api/user/notifications`): Authenticated GET /api/user/notifications regressed to 500
  - `QB-NET-03` (api_runtime / `network-first-party-404` @ `/reports`): /reports XHR fetches /api/telemetry/missing-widget.json returning 404
  - `QB-NET-04` (api_runtime / `network-first-party-404` @ `/reports`): /reports image /assets/missing-chart.png returns 404
  - `QB-E2E-01` (e2e / `e2e-flow-failure, e2e-flow-selector-timeout` @ `/workspace`): Logged-in workspace greeting shows undefined instead of user@novaops.local
  - `QB-E2E-02` (e2e / `e2e-flow-failure, e2e-flow-selector-timeout` @ `/checkout`): Checkout seat calculator renders Total: $NaN/mo instead of $147/mo
  - `QB-E2E-03` (e2e / `e2e-flow-failure, e2e-flow-selector-timeout` @ `/settings`): Settings save reverts display name to Guest instead of persisting Ada Lovelace
  - `QB-E2E-04` (e2e / `e2e-flow-failure, e2e-flow-selector-timeout` @ `/workspace`): Workspace filter returns 0 projects match for Core API
  - `QB-E2E-05` (e2e / `e2e-flow-failure, e2e-flow-selector-timeout` @ `/workspace`): Confirming archive modal fails to dismiss #confirm-modal
  - `QB-E2E-06` (e2e / `e2e-flow-failure, e2e-flow-selector-timeout` @ `/reports`): Reports CSV export shows error state instead of #export-ready
  - `QB-E2E-07` (e2e / `e2e-flow-failure, e2e-flow-selector-timeout` @ `/admin`): Authenticated admin receives 403 Forbidden toggling maintenance mode
  - `QB-E2E-08` (e2e / `e2e-flow-failure, e2e-flow-selector-timeout` @ `/onboarding`): Onboarding Next button never reveals #wizard-step-2
  - `QB-PERF-04` (perf / `api-latency-budget` @ `/api/analytics/heavy`): GET /api/analytics/heavy takes ~1100ms exceeding 250ms budget

## Run Details: Local Ollama Check (gemma:2b)

- **Command**: `qualitypilot check http://127.0.0.1:55973 --openapi openapi.json --login qa-bench-roles --allow-private --max-pages 18 --max-depth 2 --concurrency 4 --timeout 360000 --llm-preset ollama --fail-on none --format json (OPENAI_MODEL=gemma:2b)`
- **False-positive violations**: 0 / 5
- **Missed expectations (17)**:
  - `QB-API-01` (api_runtime / `api-status-mismatch, network-first-party-500` @ `/api/billing/summary`): GET /api/billing/summary regressed from 200 to 500
  - `QB-API-02` (api_runtime / `api-schema-mismatch` @ `/api/projects/active`): GET /api/projects/active missing ownerEmail and returns totalCount as string
  - `QB-API-03` (api_runtime / `api-schema-mismatch` @ `/api/deployments/latest`): GET /api/deployments/latest returns string 'yes' for boolean healthy
  - `QB-API-04` (api_runtime / `api-status-mismatch` @ `/api/webhooks/ping`): POST /api/webhooks/ping regressed from 200 to 502
  - `QB-API-05` (api_runtime / `api-schema-mismatch` @ `/api/user/profile`): Authenticated GET /api/user/profile drops required email and role fields
  - `QB-API-06` (api_runtime / `api-status-mismatch` @ `/api/user/notifications`): Authenticated GET /api/user/notifications regressed to 500
  - `QB-NET-03` (api_runtime / `network-first-party-404` @ `/reports`): /reports XHR fetches /api/telemetry/missing-widget.json returning 404
  - `QB-NET-04` (api_runtime / `network-first-party-404` @ `/reports`): /reports image /assets/missing-chart.png returns 404
  - `QB-E2E-01` (e2e / `e2e-flow-failure, e2e-flow-selector-timeout` @ `/workspace`): Logged-in workspace greeting shows undefined instead of user@novaops.local
  - `QB-E2E-02` (e2e / `e2e-flow-failure, e2e-flow-selector-timeout` @ `/checkout`): Checkout seat calculator renders Total: $NaN/mo instead of $147/mo
  - `QB-E2E-03` (e2e / `e2e-flow-failure, e2e-flow-selector-timeout` @ `/settings`): Settings save reverts display name to Guest instead of persisting Ada Lovelace
  - `QB-E2E-04` (e2e / `e2e-flow-failure, e2e-flow-selector-timeout` @ `/workspace`): Workspace filter returns 0 projects match for Core API
  - `QB-E2E-05` (e2e / `e2e-flow-failure, e2e-flow-selector-timeout` @ `/workspace`): Confirming archive modal fails to dismiss #confirm-modal
  - `QB-E2E-06` (e2e / `e2e-flow-failure, e2e-flow-selector-timeout` @ `/reports`): Reports CSV export shows error state instead of #export-ready
  - `QB-E2E-07` (e2e / `e2e-flow-failure, e2e-flow-selector-timeout` @ `/admin`): Authenticated admin receives 403 Forbidden toggling maintenance mode
  - `QB-E2E-08` (e2e / `e2e-flow-failure, e2e-flow-selector-timeout` @ `/onboarding`): Onboarding Next button never reveals #wizard-step-2
  - `QB-PERF-04` (perf / `api-latency-budget` @ `/api/analytics/heavy`): GET /api/analytics/heavy takes ~1100ms exceeding 250ms budget

## Run Details: Replay Approved Plan (plan.json)

- **Command**: `qualitypilot replay plan.json --url http://127.0.0.1:55973 --fail-on none --format json`
- **False-positive violations**: 0 / 5
- **Missed expectations (6)**:
  - `QB-NET-01` (api_runtime / `broken-link-404` @ `/workspace`): Link to /docs/migration-v1 on /workspace returns 404
  - `QB-NET-02` (api_runtime / `broken-link-500` @ `/`): Link to /legacy-billing on / returns 500
  - `QB-NET-03` (api_runtime / `network-first-party-404` @ `/reports`): /reports XHR fetches /api/telemetry/missing-widget.json returning 404
  - `QB-NET-04` (api_runtime / `network-first-party-404` @ `/reports`): /reports image /assets/missing-chart.png returns 404
  - `QB-CON-01` (api_runtime / `console-error` @ `/workspace`): /workspace logs console.error on load
  - `QB-CON-02` (api_runtime / `uncaught-exception` @ `/checkout`): /checkout throws uncaught TypeError reading currencySymbol
