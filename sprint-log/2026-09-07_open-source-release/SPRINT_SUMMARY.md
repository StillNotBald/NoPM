# Sprint Summary — 2026-09-07_open-source-release

**TL;DR:** Prepared NoPM for public release under Apache-2.0. AI-assisted development: sequential implementation passes, each cross-checked by independent automated review, then a manual diff review and full gate re-run. Audit areas: security, sensitivity, feature inventory, licensing, guides; every finding was verified against the exact code or the live GitHub API before a fix. One Critical finding blocks the visibility flip until the maintainer recreates the repository (pre-purge commits are still fetchable on GitHub by SHA). Working tree is staged and gated; **not committed, not pushed** (maintainer actions, see `PUBLISH_RUNBOOK.md`).

## Declared goals (maintainer, 2026-09-07)
1. Demo site stays for look-and-feel; visitors play via Claude + MCP.
2. Source published as Apache-2.0.
3. Maintainer charges for an implementation guide + change requests.
4. Segregate open-source vs premium.
5. Deep security + sensitivity check; plain-language guides.

## Outcomes

### Decision: everything open, premium = services (`DECISIONS.md` D1)
No code is withheld. The governance thesis needs inspectable code, and the codebase has no seam to split on (governance runs through the shared `route()` wrapper). Premium is the paid Implementation Guide (12-chapter outline in `docs/guide/05`), change requests (intake template + "will not build" list), optional hosted setup and training. A feature inventory considered a future paid-module menu (SSO, multi-tenant admin, board-pack reporting, DR kit, integrations, hosted BYOK vault, compliance exports); none of it exists today and no code is removed.

### License switch MIT → Apache-2.0
- `LICENSE` replaced with the canonical text (fetched from apache.org, diffed byte-identical). `NOTICE` added (copyright, third-party callouts, fonts, icons, trademarks). `license` field updated in root, `web/`, `cli/` package.json. README gained a guides row, a License section, and a Trademarks section.
- Dependency audit: 15 direct prod deps MIT/ISC; 541-package tree has no GPL/AGPL/SSPL/EPL/CDDL; MPL items are dev-only; dual-licensed items used under their permissive option; no bundled Apple fonts (SF Pro is a CSS fallback name only); no copied code. Verdict: compatible, no exceptions.

### Security (all findings verified against code or the live API)
| ID | Sev | Finding | State |
|---|---|---|---|
| F1 | Critical | 18 of 19 pre-purge commits still fetchable on GitHub by SHA, one of them listing a private research file; local object absent, server object present | **Maintainer action**: recreate repo from a `--no-local` clone, rename to keep the URL, archive old (`PUBLISH_RUNBOOK.md` steps 1-2) |
| F2 | Medium | `auth-smoke.mjs` printed the admin email into CI logs | Fixed: email is now masked; old run logs stay in the archived private repo |
| F3 | Medium | Document uploads accepted any declared `mime_type`; PDF-labelled HTML rendered inline in an iframe | Fixed: `normalizeMimeType` (executable types → octet-stream), `matchesMagicBytes` on attach for PDF/PNG/JPEG/GIF/WebP (422 on mismatch), non-inline types served as downloads; 12 new tests; OpenAPI + `docs/SECURITY.md` + R-39 updated |
| F4 | Low | No branch protection on `main` (plan-gated while private) | Runbook step 5 (free once public) |
| F5 | Low | `gitleaks-action` pinned by tag | Fixed: SHA-pinned `ff98106e…` (# v2) |
| F6 | Info | pptxgenjs "bump" pre-flip item | Moot: 4.0.1 is the latest; `image-size` has no upstream fix; documented exception stands |
| — | Pass | No secrets in 709 tracked files or reachable history; workspace filter present on all 5 spot-checked routes; BYOK AES-256-GCM; PAT SHA-256; assistant ceiling has no approve/admin scope; no SSRF; demo LLM key capped 20/h; CSV injection neutralized; no `pull_request_target`; `GITHUB_TOKEN` read-only | — |

Also fixed while there: `bootstrap.mjs` now honors `ADMIN_EMAIL` and no longer echoes the admin password; five unused create-next-app SVGs (Vercel/Next logos) removed from `web/public/`.

### Sensitivity
A sweep for real emails, phones, addresses, machine paths, session URLs, project refs and internal codenames in tracked files found none outside gitignored folders (re-confirmed via `git ls-files`). Applied: a client-relationship bullet removed from `docs/product/PRODUCT.md` (+ planning-voice banner); 12 sprint-log files reworded from internal tool jargon and second-person notes into report voice (counts preserved); one seed-cast name made consistent. `sprint-log/` stays public as evidence. The leak gate also caught the sweep report itself repeating the strings it searched for, so working reports were not kept in the repository.

### Guides (`docs/guide/`, 7 files, ~600 lines, zero `[CHECK]` markers left)
Start-here README · try the demo with Claude (claude.ai / Desktop / Claude Code / mcp-remote, demo terms box) · run it yourself (env table, common mistakes) · how governance works (audit, scopes, four-eyes, change control, lock/rebaseline, period-close, Trust Center) · for developers (contract, `route()`, adding an endpoint and an MCP tool, RTM) · help and paid services (free vs paid, guide outline, CR intake, will-not-build list, Apache-2.0 in plain words) · FAQ (18 answers).

## Gates (final, on the staged tree)
tsc clean · vitest **1929/1929** (85 files) · eslint 0 errors (1 pre-existing warning) · `rtm:verify` OK (77 R-IDs, 578 paths) · `gen-metrics --check` fresh · CLI 23/23 · leak gate: 704 tracked files clean and staged set clean.

## RTM
R-39 (documents + file storage) text updated in `REQUIREMENTS.md` and its Tests cell in `TRACEABILITY.md` in this same change set. No new R-ID: the release is a publication event, not a functional requirement.

## Owed / next (maintainer)
1. `git add -A && git commit` (message in `PUBLISH_RUNBOOK.md` step 0).
2. Runbook steps 1-6: fresh `--no-local` clone → new repo → verify old SHAs 404 → rename to keep `StillNotBald/NoPM` → re-add the six Actions secrets → point local origin → flip public → branch protection → enable Issues, Dependabot, secret scanning → `vercel deploy --prod` so the live site carries the upload hardening and the guides link.
3. Optional later: SHA-pin the first-party `actions/*` too; nonce-strict CSP follow-up (R-79) unchanged.

## Method notes
- AI-assisted development: sequential implementation passes, each cross-checked by independent automated review, then a manual diff review and full gate re-run. Every confirmed finding was hand-verified (F1 reproduced with `gh api` + `git cat-file`) before editing.
- Lesson: a history-rewrite purge does not remove objects from GitHub; verify with `gh api .../commits/<old-sha>` and recreate the repo.
