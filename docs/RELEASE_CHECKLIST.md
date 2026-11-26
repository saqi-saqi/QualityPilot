# Testigator Release Checklist

Run every step below before tagging a new release (`vX.Y.Z`) or publishing to npm.

## 1. Automated Verification
- [ ] Run the full test suite: `npm test` (0 failures, 0 skipped assertions).
- [ ] Run the README path & link audit: `node scripts/verify-readme-paths.mjs` (every repository path and relative link in `README.md` resolves cleanly).
- [ ] Run the Juice Shop / QA-Bench recall benchmarks and commit fresh receipts under `benchmark/receipts/` when benchmark targets or executors change.

## 2. Documentation & Governance Audit
- [ ] **README module-map & CLI audit:** Confirm `README.md` module paths (`src/`, `dashboard/`, `scripts/`, `benchmark/`, `docs/`, `.github/`) and CLI commands (`check`, `export`, `replay`, `report`, `merge-reports` via `testigator`) match the clean git tree (`node scripts/verify-readme-paths.mjs`).
- [ ] **BFCL & external metrics governance:** Confirm no external benchmark or competitor pricing number appears in `README.md`, `landing/index.html`, or release notes without an as-of date and a dated primary-source receipt in `benchmark/receipts/`.
- [ ] **Version & pin alignment:** Update `package.json`, `package-lock.json`, `action.yml` examples in `README.md`, and verify GitHub Action SHA/digest pins per `README.md` supply-chain instructions.

## 3. Quarterly External-Listing & Collision Review
*(Perform at least once per quarter and on every minor release `v0.x.0`)*
- [ ] **LobeHub:** Verify `saqi-saqi/Testigator` (`testigator-mcp`) shows the latest version & URL, and confirm stale `saqi-saqi-sqa_agent` / `saqi-saqi-qualitypilot` entries are delisted or redirected.
- [ ] **Smithery / Glama / PulseMCP:** Verify active searchable listing points to `github.com/saqi-saqi/Testigator` and `npm: testigator`.
- [ ] **npm & GitHub collision check:** Re-check `npmjs.com/package/testigator` and GitHub search for any new collisions; keep [docs/DISCOVERY_AND_LISTINGS.md](DISCOVERY_AND_LISTINGS.md) current.

## 4. Package & Tag Publication (Requires Owner Authorization)
- [ ] Run `npm publish --dry-run` and inspect the tarball file list (no `.env`, DB files, scratch logs, `.testigator/`, or `benchmark/results/`).
- [ ] Publish to npm (`npm publish`), create release tag (`git tag vX.Y.Z && git push origin vX.Y.Z`), and publish GitHub Release notes.
