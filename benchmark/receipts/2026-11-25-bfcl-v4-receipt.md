# BFCL V4 Primary-Source Receipt (2026-11-25)

- **Captured at:** 2026-11-25
- **Source URL:** `https://gorilla.cs.berkeley.edu/data_overall.csv` (UC Berkeley Gorilla — Berkeley Function Calling Leaderboard V4, 109 evaluated rows)
- **Reason:** Remediation Plan WS2.2 governance rule — verify any BFCL tool-calling claims directly against the live leaderboard CSV and retire unverified composite figures (specifically the earlier audit's unverified "78.5% -> 37.0% / 41.5 percentage point drop" figure, which does not appear in any public repository copy).

## Exact Measured Figures (`data_overall.csv`, 2026-11-25)

| Rank | Model | Organization | License | Non-Live AST Acc (Single-Turn) | Live Acc (Single-Turn) | Multi Turn Acc | Drop (Non-Live -> Multi Turn) |
| ---: | :--- | :--- | :--- | ---: | ---: | ---: | ---: |
| 1 | `Claude-Opus-4-5-20251101 (FC)` | Anthropic | Proprietary | 88.58% | 79.79% | 68.38% | -20.20 pp |
| 4 | `GLM-4.6 (FC thinking)` | Zhipu AI | MIT | 87.56% | 80.90% | 68.00% | -19.56 pp |
| 29 | `Qwen3-32B (FC)` | Qwen | apache-2.0 | 88.77% | 82.01% | 47.87% | -40.90 pp |
| 39 | `Qwen3-8B (FC)` | Qwen | apache-2.0 | 87.58% | 80.53% | 41.75% | -45.83 pp |
| 43 | `Qwen3-14B (FC)` | Qwen | apache-2.0 | 84.94% | 80.01% | 34.75% | -50.19 pp |
| 54 | `Qwen3-4B-Instruct-2507 (FC)` | Qwen | apache-2.0 | 87.88% | 76.39% | 22.12% | -65.76 pp |
| 62 | `Llama-3.3-70B-Instruct (FC)` | Meta | Llama 3 Community | 88.02% | 76.61% | 21.50% | -66.52 pp |
| 66 | `Gemma-3-12b-it (Prompt)` | Google | gemma-terms-of-use | 79.44% | 74.24% | 5.75% | -73.69 pp |
| 69 | `Gemma-3-27b-it (Prompt)` | Google | gemma-terms-of-use | 87.17% | 74.54% | 10.75% | -76.42 pp |
| 85 | `Llama-3.1-8B-Instruct (Prompt)` | Meta | Llama 3 Community | 84.00% | 70.76% | 11.12% | -72.88 pp |

## Takeaways for QualityPilot Architecture

- Locally runnable open-weight models (`4B`–`32B`) score **79.4%–88.8%** on single-turn AST function/structured-call tasks, but drop steeply to **5.8%–47.9%** on multi-turn tool trajectories (drops of **40.9–76.4 percentage points** vs. Non-Live AST).
- QualityPilot uses at most **single-shot structured planning** (`buildTestPlan`) before falling back to deterministic matrix execution (`runMatrix`), avoiding fragile multi-turn local-model control loops in CI.
- Any public copy citing BFCL numbers MUST cite this dated receipt or re-pull `https://gorilla.cs.berkeley.edu/data_overall.csv` on release.
