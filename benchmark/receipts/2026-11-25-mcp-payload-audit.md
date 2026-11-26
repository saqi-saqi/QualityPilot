# MCP Tool Payload Audit Receipt (2026-11-25)

- **Target:** Local fixture app (`test/fixtures/site/server.js`, 6 pages + 3 API routes)
- **Measurement basis:** UTF-8 wire bytes of MCP `content[0].text` and conservative 4-bytes/token estimate (`Math.ceil(bytes / 4)`)
- **Budget target:** `<= 2,000` tokens (`SQA_MCP_TOKEN_BUDGET` default `1800` tokens) with complete findings + evidence written to `.qualitypilot/artifacts/<runId>/report.json` when output exceeds budget or `verbosity === 'full'`

## Measured Results (Before vs. After WS4.3)

| MCP Tool Call | Before (bytes / ~tokens) | After (bytes / ~tokens) | Notes |
| :--- | ---: | ---: | :--- |
| `quick_check` (`page-ok.html`) | 338 / ~85 | 257 / ~65 | Compact single-line JSON |
| `quick_check` (`page-a11y-fail.html`) | 850 / ~213 | 668 / ~167 | Compact single-line JSON |
| `check_accessibility` (`page-a11y-fail.html`) | 620 / ~155 | 502 / ~126 | Compact single-line JSON |
| `check_api_contract` (observed) | 178 / ~45 | 149 / ~38 | Compact single-line JSON |
| `check_api_contract` (`GET /api/always-400`) | 637 / ~160 | 523 / ~131 | Compact single-line JSON |
| `explain_finding` (`image-alt`) | 281 / ~71 | 260 / ~65 | Compact single-line JSON |
| `start_full_scan` | 147 / ~37 | 130 / ~33 | Returns `job_id` + polling hints |
| `get_scan_status` (`complete`) | 117 / ~30 | 125 / ~32 | Status + `pagesScanned` |
| `get_scan_report` (`summary`, 6 pages / 18 findings) | Failed validation* | **5,464 / ~1,366** | Single-copy findings + `artifactPath` (`truncated: true`) |
| `get_scan_report` (`full`, 6 pages / 18 findings) | **61,139 / ~15,285** | **5,464 / ~1,366** | 91.1% reduction; full 21,587-byte redacted artifact on disk at `artifactPath` |

\* Before WS4.3, `summary` stripped `evidence` before computing fallback node signatures, causing two `perf-budget-pageSizeBytes` entries from desktop/mobile viewports to fail the `validateReport` duplicate check. Syncing `getNodeSignature` fallback in `src/mcp/redact.js` and deduplicating the wire response fixed both validation and payload bloat.
