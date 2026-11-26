# Discovery, Namesakes & Public Rollout (`Testigator`)

Last verified: **2026-11-25**

## 1. Live Availability & Audit Findings (2026-11-25)

Because **"QualityPilot"** collided with multiple unrelated projects (`@qlens/cli` / `qlens.dev` on npm and `virinchisai/QualityPilot` on GitHub), the project was rebranded to **`Testigator`**:

| Surface / Identifier | Verified Live Status (2026-11-25) | Status / Owner Action |
| :--- | :--- | :--- |
| npm `testigator` (`https://registry.npmjs.org/testigator`) | **HTTP 404 (Available — zero collisions; target `1.0.0`)** | Ready to publish cleanly via `npm publish --access public` |
| GitHub search (`testigator in:name`) | **0 matching repositories** (`saqi-saqi/Testigator` live) | Repository renamed cleanly to `saqi-saqi/Testigator` |
| npm legacy `qualitypilot` (`0.5.0`) | Live under owner account (**deprecated**: `"moved to testigator"`) | Completed — installers directed to `testigator` |
| LobeHub `saqi-saqi-sqa_agent` | Stale `"TestFlow" v0.3.0` linking `SQA_Agent` | **Owner action:** delist/remove stale entry |
| LobeHub `saqi-saqi-qualitypilot` | Stale `"QualityPilot" v0.3.0` | **Owner action:** delist or rename/re-link to `saqi-saqi/Testigator` (`testigator-mcp`) |
| Glama (`glama.ai/mcp/servers`) | 0 matching `testigator` or `qualitypilot` entries | **Owner action:** submit `saqi-saqi/Testigator` (`testigator-mcp`) |
| Smithery (`smithery.ai/servers`) | 0 matching entries | **Owner action:** submit `saqi-saqi/Testigator` (`testigator-mcp`) |
| PulseMCP (`pulsemcp.com`) | Host TLS handshake failed in automated check; 0 indexed search hits | **Owner action:** submit `saqi-saqi/Testigator` (`npm: testigator`, `testigator-mcp`) |
| Netlify landing site | Previously `qualitypilot.netlify.app` | **Owner action:** update Netlify site/domain from `landing/index.html` and redeploy |

---

## 2. Public Setup Update Checklist (Owner Steps)

Run these steps once logged into GitHub, npm, Netlify, and the MCP directories:

1. **Rename GitHub Repository**
   - Go to **GitHub -> `saqi-saqi/QualityPilot` -> Settings -> General -> Repository name** -> rename to `Testigator`.
   - GitHub automatically redirects `saqi-saqi/QualityPilot` URLs until someone claims the old name.
   - Update your local remote after pushing the rename commit:
     ```bash
     git remote set-url origin https://github.com/saqi-saqi/Testigator.git
     ```
   - Optional repo metadata refresh (`gh` CLI):
     ```bash
     gh repo edit saqi-saqi/Testigator \
       --description "Self-hosted, deterministic-first web & API QA gate orchestrator on Playwright + SQLite with MCP server (npm: testigator)" \
       --add-topic qa --add-topic playwright --add-topic quality-gate --add-topic visual-regression --add-topic security-testing
     ```

2. **Publish `testigator` to npm (Clean New Package Name)**
   ```bash
   npm login
   npm publish --dry-run
   npm publish
   # Optional: point legacy package installers to the new package
   npm deprecate qualitypilot "Package renamed to testigator. Run: npm install -g testigator"
   ```

3. **Update Netlify Landing Page**
   - Deploy updated `landing/index.html` cleanly and rename the Netlify subdomain (`Site configuration -> Domain management`) if desired (e.g. `testigator-qa.netlify.app` or custom domain), then update any badges/links in `README.md` if you use a custom domain.

4. **Update External MCP Directories (Submission-Ready Copy Below)**

---

## 3. Ready-to-Submit Copy for External MCP Directories

Use the metadata below for **LobeHub**, **Smithery**, **Glama**, and **PulseMCP**:

- **Name:** `Testigator`
- **Identifier / Slug:** `saqi-saqi/Testigator` (`testigator-mcp`)
- **Homepage / Repository:** `https://github.com/saqi-saqi/Testigator`
- **npm Package:** `testigator` (`https://www.npmjs.com/package/testigator`)
- **License:** `Apache-2.0`
- **Category / Tags:** `testing`, `qa`, `playwright`, `accessibility`, `wcag`, `security`, `api-testing`, `ci-cd`, `developer-tools`
- **One-line tagline (≤ 120 chars):**
  > Self-hosted, deterministic-first web & API QA gate agent on Playwright + SQLite, with 7 compact MCP tools.
- **Full Description:**
  > Testigator is an open-source (Apache-2.0), zero-cloud web & API quality-gate orchestrator built on Node.js and Playwright with embedded SQLite persistence (`saqi-saqi/Testigator`, npm `testigator`; formerly QualityPilot). Its stdio MCP server (`testigator-mcp`) gives coding agents like Claude Code and Cursor 7 structured tools (`quick_check`, `check_accessibility`, `check_api_contract`, `explain_finding`, `start_full_scan`, `get_scan_status`, `get_scan_report`) returning compact JSON verdicts (`<= 2,000` tokens) and disk artifact paths (`.testigator/artifacts/`), backed by an SSRF boundary, privacy redaction, and deterministic scoring invariants.

### Transport & Config Snippet (`stdio`)

```json
{
  "mcpServers": {
    "testigator": {
      "command": "npx",
      "args": ["-y", "--package=testigator", "testigator-mcp"],
      "env": {
        "SQA_ALLOW_PRIVATE": "true"
      }
    }
  }
}
```
