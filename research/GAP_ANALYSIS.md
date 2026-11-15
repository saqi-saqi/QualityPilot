# Gap Analysis — Autonomous QA Agents: Research Literature & Existing Tools

**Rev 2 — 2026-11-13.** Revised after an external review (Claude Sonnet 5.5) challenged several claims; every accepted correction was re-verified against live sources before being folded in (see §6 changelog). Rev 1's "no dataset exists" claims were **overstated** and have been narrowed — this revision is the citable one.
**Purpose:** Backbone for the MSc research proposal — what previous research papers and existing SQA agents do NOT cover, and which of those gaps TestFlow is equipped to attack.
**Sources:**
- [Survey 1: LLM-based & agentic test generation 2023–2026](lit-survey-llm-agentic-test-generation-2023-2026.md) (per-item verification status inside)
- [Survey 2: Autonomous QA niche corners — healing, flaky, privacy, HITL](../lit-survey-autonomous-qa-2026-11-13.md) (per-item verification status inside)
- REA competitor analysis: `rea_work/TESTFLOW_IMPROVEMENT_PLAN.md` (file/line evidence)
- Competitor landscape notes: `ex.txt`
**Verification rule:** ✅ = I opened the cited page directly; ◐ = corroborated via a fetched secondary source or reported by external review but not yet verified on the primary page; ⚠️ = search-snippet only. Commercial-tool statements rest on **public positioning only**. Every remaining "no published work" claim is an absence-of-evidence finding from 2026-11-13 and **must be re-verified by a systematic literature review before the thesis claims novelty**.

---

## 1. Gaps in the research literature

### R1 — The oracle problem (dominant unsolved blocker)
An autonomous agent must decide whether observed behavior is *correct* without being told. WebTestPilot names it the "implicit oracle inference challenge": the agent must act as its own oracle, and an LLM's inconsistent reasoning makes it a shaky one ([WebTestPilot, FSE 2026, PACMSE vol. 3, DOI 10.1145/3797115](https://arxiv.org/abs/2602.11724) ✅). Most shipped tools still fall back to "no crash = pass."
**Implication:** any thesis touching agent-found findings inherits this problem; any thesis that *constrains* it addresses the field's #1 blocker.

### R2 — Hallucination vs. real bug
No standard method disambiguates an agent's real finding from an LLM hallucination. Adjacent evidence: RAG grounding on the real DOM cut execution failure from 70% → 10% in a 2026 preprint (arXiv 2601.06034, single domain, not peer-reviewed). **Measured verdict quality now exists for web test agents (full text verified ✅):** on the ATA benchmark (113 manual test cases, 3 offline apps), PinATA executed 61% of test cases correctly; paired with Sonnet it reached **94% sensitivity** but **specificity ≤ 57%** (0.57 GPT-4o, 0.47 Sonnet, 0.56 Gemini), with both ATAs exhibiting "a tendency to generate false failure alerts" ([Chevrot et al., ISSTA 2025, arXiv 2504.01495](https://arxiv.org/abs/2504.01495) — §5.2 and conclusion; the abstract's "94% specificity" is contradicted by the paper's own results tables and conclusion, so cite the body). This is exactly R2's problem, measured: web test agents over-flag failures — false alerts, not missed bugs.
**Implication:** precision of agent-found findings is a measurable, fundable question.

### R3 — No mutation-equivalent ground truth for UI/E2E
Mutation score works at unit level only. For UI the field improvises: bug injection (WebTestPilot), golden tests (SWT-Bench). No standard "UI mutation" methodology exists (⚠️ framing itself needs a full-text check of SWT-Bench/WebTestPilot methods before citing as a gap statement).
**Implication:** proposing a fault-injection standard for E2E suites is itself a methodological contribution.

### R4 — Fragmented evaluation, and the agent-as-tester benchmark space is now opening (⚠️ competition)
SE-venue web-testing papers evaluate on small demo apps with feature coverage ([AutoE2E/E2EBench, ICSE 2025](https://arxiv.org/abs/2408.01894) ✅); agent papers evaluate on task success (WebArena/Mind2Web) which says nothing about suite quality. **New since Rev 1 — direct neighbors, verified:**
- ["Are Autonomous Web Agents Good Testers?"](https://dl.acm.org/doi/10.1145/3728879) (Chevrot et al., **ISSTA 2025** ✅): PinATA executed 61% of test cases correctly, 94% sensitivity but specificity ≤57% (verified in full text; the abstract's "94% specificity" is contradicted by its own §5.2 and conclusion); limitations in handling assertions and errors.
- [WebTestBench](https://arxiv.org/abs/2603.25226) (Mar 2026 ✅, public dataset+code): benchmark for end-to-end automated web testing by computer-use agents, decomposed into checklist generation + defect detection, on AI-built ("vibe-coded") web apps.
- Additional neighbors from WebTestBench's comparison table: [GTArena](https://arxiv.org/abs/2412.18426) (Zhao et al. 2024 ✅ — unified environment evaluating the whole automated-GUI-testing process), GUITestBench (Gao et al., 2026 ◐ — surfaced but not opened), PlanATA (⚠️ — search-mentioned only). The agent-as-tester benchmark space is crowding fast; any benchmark contribution must open by positioning against all four.
**Implication:** a *benchmark for agents-as-testers* now exists — G3 must be narrowed accordingly: what remains unclaimed is **suite-quality axes beyond defect detection** (redundancy/dedup, triage correctness, maintenance & flakiness cost, human approval cost) and **full-pipeline evaluation** (plan → approve → matrix → triage → gate). Both papers are mandatory related work.

### R5 — Flaky E2E tests: public *sample collections* exist; public *run-level, matrix-parameterized* data does not (narrowed — Rev 1 overstated this)
Rev 1 claimed "no public dataset of flaky web E2E tests exists." **Corrected — public artifacts verified:**
- Romano et al.'s [dataset of UI-based flaky tests](https://zenodo.org/records/4456027) (Zenodo, 2021 ✅): 235 samples — 152 web + 83 mobile. Sample collection, not run data. Venue confirmed [ICSE 2021](https://dl.acm.org/doi/10.1109/ICSE43902.2021.00141) ✅; the "unsuited for rerunning" quote is in the abstract ✅.
- Yu Pei, Mike Papadakis, Jeongju Sohn, "An Empirical Study of Web Flaky Tests: Understanding and Unveiling DOM Event Interaction Challenges" ([ICST 2025](https://www.computer.org/csdl/proceedings-article/icst/2025/10989030/26S4INNzhkc); authorship verified on the [ORBilu record](https://orbilu.uni.lu/handle/10993/65305) ✅): 123 DOM-event-related flaky tests in 49 web projects; abstract states the dataset is publicly available.
- A dataset of [49 reproducible async-wait flaky web tests + fixes from 26 projects](https://dl.acm.org/doi/10.1145/3695989) ✅ — same group: Pei, Sohn, Habchi & Papadakis, "Non-flaky and nearly-optimal time-based treatment of asynchronous wait web tests," ACM TOSEM 2024 (attribution confirmed via the ICST'25 paper's reference list).
- [ReproFlake](https://arxiv.org/abs/2605.21677) (May 2026 ✅): **1,115 reproducible flaky tests** with reproduction scripts *and* passing/failing execution logs — but compiled/run via a build environment (Java-oriented legacy projects), **not web-E2E**, and not matrix-parameterized.
**Surviving claim (narrowed):** no public **run-level** flaky dataset for **web E2E** tests, parameterized across a browser × viewport × role execution matrix — and no detection method that uses cross-cell matrix disagreement as the flakiness signal. Romano et al. and ReproFlake both note rerunning heavy UI suites is impractical; the matrix turns one scan's cells into implicit repetitions, which is exactly the unexploited structure.
**Urgency note:** two of these datasets appeared in May 2026 alone — the field is moving; the window for "first matrix-parameterized web-E2E flaky dataset" is real but closing.

### R6 — Self-healing evaluated on private corpora; "false repair" never measured (scoped)
Every classic repair tool (WATER, WATERFALL, visual repair, Erratum, ICST'25 LLM repair) evaluated on private or ad-hoc corpora. [ReproBreak](https://arxiv.org/abs/2605.12158) ✅ — now published at **ASE 2026, Tools & Datasets track** ([program entry](https://conf.researchr.org/details/ase-2026/ase-2026-tools-and-data-sets/46/ReproBreak-A-Dataset-of-Reproducible-Web-Locator-Breaks) ✅) — provides 449 reproducible locator breaks; its own scope statement is "no public dataset of *reproducible* locator breaks for Cypress and Playwright," and the 449 breaks come from just **four projects** (a thin seed corpus — say so in the thesis). No paper or tool measures **false repairs** — healed tests that pass against the wrong element, silently changing test semantics.
**Implication:** a repair-semantics benchmark with a false-repair metric is still open territory; budget for enlarging the corpus beyond ReproBreak's four projects.

### R7 — Human-in-the-loop: nearest neighbors exist; the E2E approval-gate study does not (sharpened)
- **Must-cite neighbor (verified):** ["Preemptive, Buffered, or Guided?"](https://dl.acm.org/doi/10.1145/3817601) ✅ — two user studies (N₁=16, N₂=24) on human–LLM interaction strategies for software **test case development** (unit-test brainstorming): preemptive prompting improves test quality and creativity by >30%; users spend 126% more time than with web search. (A further claim circulated by external review — that *accepting more LLM-suggested test cases correlates with worse test quality* — is not visible in the accessible abstract; verify against the full text before citing it. ◐)
- **HULA** (arXiv 2411.12924) is about **Jira issue resolution**, not testing — cite it as SE-workflow HITL context only. ◐
- arXiv 2608.23642 is a **position paper**, not empirical evidence.
**Surviving claim:** no verified empirical study of an **approval gate for AI-generated E2E test plans** — none/soft-gate/full-review A/B with downstream suite-quality and human-cost measurement. This remains the emptiest corner.

### R8 — Privacy exposure of LLM-based test generation: neighbors exist, direct study does not (sharpened)
Verified closer neighbors:
- [AgentDAM](https://openreview.net/forum?id=qaxf7q41aK) (NeurIPS 2025 D&B ✅): evaluates whether web agents leak private information while performing tasks, with an explicit utility/privacy-tradeoff mechanism.
- [AgentLeak](https://arxiv.org/abs/2602.11510) (IEEE Access 2026 — related DOI 10.1109/ACCESS.2026.3704541 present on arXiv ✅): benchmark for internal-channel privacy leakage in multi-agent LLM systems; abstract verifies inter-agent messages leak 68.8% vs 27.2% for final outputs. Its sanitization-interceptor trade-off (31.5% → 2.4% leakage at a 4.7-point task-success cost, per external review ◐) is a ready-made template for RQ4's redaction–utility curve — verify the numbers in the full text before citing.
- Type-dependent PII leakage *from* code models (arXiv 2512.07814) — training-memorization threat, not prompt-exposure measurement.
**Surviving claim:** no verified study measures what a **test-generation pipeline** (crawl → plan → execute) sends to the LLM, nor the coverage/fault-detection cost of redaction in that setting. "First" is plausible pending SLR; frame the study as transferring the AgentDAM-style utility-privacy tradeoff lens to test generation.

### R9 — Triage/dedup of agent-found findings: sparse, with one GUI-capable classifier (sharpened)
- **Fair** ([Haben et al., arXiv 2111.03382](https://arxiv.org/html/2111.03382v1) ✅) detects legitimate failures arising from **GUI**, integration, and unit tests — so a GUI-capable failure classifier exists; use it as a baseline rather than claiming the slot empty.
- Alshammari et al. 2024 ([arXiv 2401.15788](https://arxiv.org/abs/2401.15788) ✅) is **Java-project** failure classification; the abstract itself states failure de-duplication is "extremely effective (with 100% specificity)" for some projects and "entirely ineffective" for others — figure verified directly on the arXiv abstract page.
- The SWT-Bench failure taxonomy (arXiv 2611.13395) is about *bug-reproduction tests failing*, a weak neighbor for E2E finding dedup. ◐
**Surviving claim:** no verified work on **deduplication and triage of autonomous-agent E2E findings** (clustering duplicate findings across matrix cells and runs). Open, but re-search before claiming "nobody."

### R10 — LLM-generated tests are flakier — but the evidence is DBMS-scoped (scoped)
Berndt et al. ([ICSE SEIP 2026](https://arxiv.org/abs/2601.08998) ✅) studied **four database systems** (SAP HANA, DuckDB, MySQL, SQLite) — not web E2E. Finding: a *slightly higher* proportion of flaky generated tests, **varying by project and model**; unordered collections caused 72/115 (63%) of flaky generated tests; flakiness transferred from prompt context. Do not generalize "LLM tests are flakier" beyond this scope; frame it as a hypothesis to test for web E2E — which itself is a claimable measurement.

---

## 2. Gaps in existing SQA agents

### 2.1 Open-source (evidence: REA analysis, `rea_work/TESTFLOW_IMPROVEMENT_PLAN.md`; landscape: `ex.txt`)

| Agent | What it does well | Structural gaps |
|---|---|---|
| **Playwright Test Agents** (planner/generator/healer) | Plan → generate → heal loop on real apps; MCP tooling | Healing edits code with guardrails but **no repair-semantics check** (false-repair risk unmeasured); no cross-run flaky memory; no combinatorial matrix; no dedup/triage; no released benchmark |
| **agent-qa** (Vostride) | 6-stage authoring lifecycle, repair routing, judge-model family separation | Single-path replay; heavy infra; no matrix, no flaky tracking, no public evaluation |
| **bug0-qa-agent** (LinearBytes) — **engine is open source** at bug0inc/qa-agent; closed-source framing applies to the **managed platform** | Redis action cache with effect verification; Claude+Gemini consensus assertions with tie-breaker | Consensus ≠ correctness oracle; no dataset/benchmark; no dedup; managed tier has an engineer verify every failure — which supports the "oversight as a paid service tier" observation |
| **jimmytoan/qa-agent** (AGPL — ideas only) | NL-defined tests, failure GIFs, run history | No triage, no matrix, no healing semantics |
| **ai-testing-agent** (furudo-erika) | API test plan → pytest → refine on feedback | Unit/API scope only; no UI; no matrix |

**Cross-cutting pattern:** all of them heal *locally* and forget *globally*; none detects flaky-vs-broken; none verifies a repair still tests the original target; none dedups findings; none releases a reproducible evaluation artifact.
**Correction vs. Rev 1:** vendor tooling is *not* empty on flaky detection — Cypress Cloud flags flaky tests and Playwright-ecosystem services offer retry/history-based detection (vendor descriptions, not audited). The differentiator is **matrix-variance detection** (cross-cell disagreement as a signal), not "memory" per se.

### 2.2 Commercial (QA Wolf, mabl, Testim/Tricentis, Katalon, Momentic, Octomind, testRigor, QA.tech — public positioning; closed-source)

- **Self-healing is proprietary and unevidenced** — no published repair rates, no wrong-element detection.
- **Zero public benchmarks or datasets**; accuracy claims are vendor marketing, unreplicable.
- **Oracles stay shallow in practice** (visual diff, status codes, no-crash) — the research frontier (inferred oracles) has not shipped into any product.
- **Human oversight is a service tier, not a studied gate.**
- **No privacy story** about what leaves the customer's app toward the vendor's LLM; no policy-compliance guarantees (ST-WebAgentBench: completion-under-policy under two-thirds of nominal, three open agents — see survey 1 §3).

---

## 3. The intersection — five claimable gaps (narrowed to what survives verification)

| # | Gap | Research papers | Tools/agents | Why TestFlow fits |
|---|---|---|---|---|
| **G1** | **Matrix-variance flaky detection** for web E2E + first **run-level, matrix-parameterized** flaky dataset (browser × viewport × role × repetition) | R5: sample collections exist (Romano, Pei, async-wait 49); run-level data exists only for Java (ReproFlake); web-E2E run-level matrix data void | Vendor retry/history detection exists; matrix-variance signal absent | Matrix, flaky tracker, monitors already built |
| **G2** | Healing benchmark with **false-repair** semantics metric | R6: never measured; ReproBreak (ASE 2026 T&D) = seed corpus, but 4 projects only | healing without verification | selectorResolver ladder = ready baseline |
| **G3** | Suite-quality evaluation beyond defect detection: redundancy/dedup, triage correctness, maintenance & flakiness cost, human approval cost — across the **full pipeline** | R4: WebTestBench + ISSTA'25 ATA study now cover agent-as-tester defect detection; suite-quality axes unclaimed | marketing claims only | Full pipeline + dedup + triage + reports already implemented |
| **G4** | First quantification of privacy exposure in **test generation** + redaction–utility trade-off (AgentDAM lens transferred) | R8: AgentDAM/AgentLeak are agent-task neighbors; test-gen pipelines unstudied | unaudited vendor pipelines | Automatic redaction + shape-only LLM context already implemented |
| **G5** | First empirical study of **approval gates for AI-generated E2E test plans** | R7: unit-brainstorming HITL studies exist (DOI 10.1145/3817601); E2E plan-approval unstudied | oversight = paid service tier | "Review plan" UI + plan_drafts persistence = ready A/B apparatus |

**Recommended flagship:** G1, with its narrowed framing (matrix-variance method + run-level matrix-parameterized web-E2E dataset). G2 as the artifact chapter, G5 as the study chapter; G4 as the fallback pure-measurement thesis. G3 is now the most contested — enter it only as a *suite-quality* extension of WebTestBench, explicitly positioned against it.

---

## 4. From gaps to research questions (draft wording for the proposal)

- **RQ1 (G1):** Can disagreement across a combinatorial execution matrix detect flaky web E2E tests with precision/recall comparable to rerun-based detection, at lower cost? *Ground truth: rerun-based oracle on N public apps; deliverable: method + first run-level, matrix-parameterized web-E2E flaky dataset. Baselines: reruns **and Fair** (failure-message classifier shown to save up to 20 minutes of computation per build on Chromium CI, [Haben et al., arXiv 2111.03382](https://arxiv.org/abs/2111.03382) ✅) and vendor retry/history detection. **Motivating evidence (Chromium CI, not web E2E — treat as motivation, not a measured property of this setting):** test-level flakiness-prediction methods with 99.2% precision still missed ~76.2% of all regression faults, while failure-focused methods improved MCC from 0.20 to 0.42 ([Haben et al., arXiv 2302.10594](https://arxiv.org/abs/2302.10594) ✅; an external review reports the misses split ~56.2% misclassification + 20% correctly-flagged-but-fault-revealing ◐ — verify in the body). The paper's own recommendation — predict *flaky failures*, not *flaky tests* — is the design rationale for matrix-variance: cross-cell disagreement is a failure-level signal. Requirement carried from this evidence: the matrix method must report missed-fault cost alongside detection accuracy.*
- **RQ2 (G2):** What fraction of automated locator repairs are *false repairs* (pass against the wrong element), across repair strategies, on ReproBreak + an enlarged corpus? *Deliverable: false-repair metric + healing harness + baseline results.*
- **RQ3 (G3):** Can suite quality beyond defect detection — redundancy, triage correctness, maintenance cost — be measured for autonomous-QA pipelines, and how do current configurations trade these off? *Deliverable: benchmark extension positioned explicitly against WebTestBench.*
- **RQ4 (G4):** How much PII/proprietary data does an LLM test-generation pipeline expose by pipeline stage, and what is the coverage/fault-detection cost of redaction? *Deliverable: measurement study + trade-off curve; AgentDAM/AgentLeak as the transferred lens; AgentLeak's sanitization-interceptor trade-off (◐ pending full-text check) as the curve template.*
- **RQ5 (G5):** What is the effect of a human approval gate (none vs. prune-only vs. full review) on plan quality, downstream suite quality, and human time? *Deliverable: A/B study; DOI 10.1145/3817601 as the nearest-neighbor design.*

---

## 5. Method caveats (carry these into the proposal's threat-to-validity)

1. **Absence-of-evidence ≠ evidence-of-absence.** R7/R8/R9 rest on search passes done 2026-11-13 (plus one external review); run a proper SLR before writing "first."
2. **Commercial-tool gaps are positioning-based**, not audited — cite them as observable-from-outside limitations, not facts.
3. **Verification status is per-item — and verify depth varies.** A ✅ mark means the claim was confirmed on the cited page (abstract, landing page, or record); several figures are body-only and stay ◐ until the full text is read (e.g., the ~56.2%/20% split of Chromium misses; AgentLeak's sanitization numbers; the acceptance↔quality correlation in DOI 10.1145/3817601). Known pending checks: Trident's TSE 2025 venue; WEFix (WWW 2024) and Tang et al. primary pages. **Absence claims in R7/R8/R9 rest on two search passes, not a systematic review — the proposal must not say "first" until the SLR is done.**
4. ReproFlake, WebTestBench, AgentLeak and the 2026 user-study line are **very recent** — re-check venue status at proposal-submission time; expect more datasets to appear in this space month by month.
5. **RQ1-specific threat (motivating evidence, Chromium CI — not measured web-E2E):** flaky-looking failures may carry real faults — test-level flakiness prediction with 99.2% precision missed ~76.2% of regression faults; failure-focused methods do better (MCC 0.20 → 0.42) but are not solved ([arXiv 2302.10594](https://arxiv.org/abs/2302.10594) ✅; ~56.2%/20% split of the misses ◐ pending body check). Report missed-fault cost alongside detection accuracy.

---

## 6. Changelog Rev 1 → Rev 2 (audit trail)

Accepted from external review and re-verified:
1. **R5 narrowed** — public flaky-UI sample datasets exist (Romano Zenodo 2021 ✅ — hosting and the 152 web/83 mobile split verified on the record; ICST 2025 study, 123 tests in 49 projects; 49 async-wait tests, TOSEM 2024). Found additionally during re-verification: **ReproFlake** (May 2026, 1,115 reproducible flaky tests with execution logs — Java-oriented). Surviving claim narrowed to run-level + matrix-parameterized web-E2E data. *(Attribution precision: the underlying survey scoped its claim to "from the works I verified" and said "test runs"; Rev 1 of this document overstated it as "no dataset … anywhere" — both wordings are now corrected.)*
2. **G1 "no cross-run memory anywhere" retracted** — vendor flaky detection exists; differentiator restated as matrix-variance detection.
3. **R4/G3 competition added** — "Are Autonomous Web Agents Good Testers?" (ISSTA 2025) and WebTestBench (Mar 2026) verified; G3 narrowed to suite-quality axes.
4. **R7 sharpened** — DOI 10.1145/3817601 user studies verified and abstract read; HULA reclassified as Jira-resolution (not testing); arXiv 2608.23642 flagged as position paper. The acceptance↔quality correlation claim could not be verified in accessible text (◐).
5. **R8 sharpened** — AgentDAM (NeurIPS 2025 D&B) and AgentLeak (IEEE Access 2026) verified as neighbors; "first" retained as plausible-but-SLR-pending.
6. **R6 scoped** — ReproBreak now cited as ASE 2026 Tools & Datasets; 449-breaks-from-4-projects thinness noted; scope of its "no dataset" statement corrected.
7. **R9 sharpened** — Fair (GUI-capable legitimate-failure classifier) verified and added; Alshammari scope (Java) noted; SWT-Bench taxonomy downgraded to weak neighbor.
8. **R10 scoped** — Berndt et al. restricted to DBMS; "slightly higher," not "higher"; web-E2E generalization reframed as an open hypothesis.
9. **Stale caveats fixed** — WebTestPilot cited as PACMSE vol. 3 (DOI 10.1145/3797115); Romano venue confirmed (ICSE 2021, DOI 10.1109/ICSE43902.2021.00141); bug0 engine's open-source status corrected.
Not verified (kept flagged, not deleted): Tang et al. 2023 venue; WEFix primary page; Trident TSE venue; R3's framing of UI-mutation absence. *(Round-2 update: Alshammari's 100%-specificity figure verified on the arXiv abstract — see R9 ✅.)*

### Rev 2.1 — round-2 external review fixes (2026-11-13)

Accepted and re-verified against primary sources:
- **R2:** measured agent-verdict quality added (PinATA ~60% correct verdicts, up to 94% specificity per abstract ✅; reported abstract-vs-conclusion discrepancy flagged ◐ pending full-text read).
- **R5:** ICST 2025 authorship confirmed (Yu Pei, Mike Papadakis, Jeongju Sohn — [ORBilu](https://orbilu.uni.lu/handle/10993/65305) ✅); Romano Zenodo hosting and split confirmed ✅; async-wait dataset attributed to Pei et al., TOSEM 2024 ✅.
- **RQ1:** Fair added as a mandatory baseline (20 min/build saving verified on the arXiv abstract ✅); missed-fault threat added with verified numbers (flaky tests reveal >1/3 of regression faults; naive flakiness filtering missed ~76.2% — arXiv 2302.10594 ✅).
- **R4:** GTArena verified ✅ (arXiv 2412.18426); GUITestBench ◐ and PlanATA ⚠️ recorded as named neighbors.
- **R8:** AgentLeak publication status updated (related IEEE Access DOI present ✅); its sanitization trade-off figures flagged ◐ pending full-text check; adopted as RQ4's curve template.
- **R9:** Alshammari specificity figure verified on the arXiv abstract ✅.
- **Changelog attribution precision fixed** (survey wording vs. Rev 1 wording distinguished).

### Rev 2.2 — round-3 external review fixes (2026-11-13)

- **PinATA discrepancy RESOLVED via full text** (arXiv HTML): the abstract's "94% specificity" is contradicted by the paper's own §5.2 (Sonnet 0.94 sensitivity / 0.47 specificity; GPT-4o 0.57; Gemini 0.56) and conclusion ("94% sensitivity … specificity not exceeding 57%"; "tendency to generate false failure alerts"). R2 and R4 updated to cite the body numbers; the finding inverts to exactly the false-alert problem R2 describes. ✅
- **76.2% reframed as motivating evidence, not a design constraint measured in this setting:** Chromium CI, test-level methods (99.2% precision, ~76.2% faults missed) vs. failure-focused methods (MCC 0.20 → 0.42) — both cited; the ~56.2%/20% split kept ◐ pending body verification; RQ1 and §5 threat 5 reworded accordingly; matrix-variance positioned as a failure-level signal per the paper's own recommendation. ✅ abstract-verified.
- **Verification-depth language softened:** ✅ = page-verified (often abstract-level), body-only figures stay ◐; absence claims in R7/R8/R9 explicitly require an SLR before "first" appears in the proposal (§5 caveat 3 strengthened).
- **Remaining unverified (unchanged):** Tang et al. venue; WEFix primary page; Trident TSE venue; R3 UI-mutation framing; agent-qa / jimmytoan / ai-testing-agent rows; commercial positioning; the ~56.2%/20% split; AgentLeak body figures; DOI 3817601 correlation claim.
