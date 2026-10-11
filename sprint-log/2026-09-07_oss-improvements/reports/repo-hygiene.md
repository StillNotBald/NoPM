# Repo hygiene — contributor experience (R-92)

Prepared for the 2026-09-07 open-source release. Covers issue templates, PR template, dependabot, the public roadmap page, the CLAUDE.md pointer note, the landing-page contact link, and the CONTRIBUTING/guide updates that tie them together.

## Files changed

New files:

- `.github/ISSUE_TEMPLATE/bug_report.yml`
- `.github/ISSUE_TEMPLATE/change_request.yml`
- `.github/ISSUE_TEMPLATE/feature_request.yml`
- `.github/ISSUE_TEMPLATE/config.yml`
- `.github/PULL_REQUEST_TEMPLATE.md`
- `.github/dependabot.yml`
- `docs/ROADMAP.md`
- `sprint-log/2026-09-07_oss-improvements/reports/repo-hygiene.md` (this file)

Edited files:

- `CLAUDE.md` — added a two-line italic pointer at the top only. No other line touched.
- `web/src/app/page.tsx` — added a `CONTACT_URL` constant (reads `NEXT_PUBLIC_CONTACT_URL`, falls back to the GitHub issue chooser) and one "Raise a change request" link in the nav and one in the footer. No new components, existing theme classes reused.
- `web/.env.example` — added `NEXT_PUBLIC_CONTACT_URL=` with a one-line comment.
- `docs/guide/05-getting-help-and-paid-services.md` — the "How to raise one" paragraph under Paid change requests now points at the "Change request" issue template by name and explains `NEXT_PUBLIC_CONTACT_URL` for self-hosters. Rest of the file untouched.
- `docs/guide/README.md` — added a `../ROADMAP.md` row to the guide table.
- `docs/CONTRIBUTING.md` — added three sections after the existing "Quick check before a PR": "Before you open a PR" (points at the PR template checklist), "Issue templates" (which template to use for what), and "Licensing of contributions" (Apache-2.0 §5 inbound=outbound, no CLA).

## Design notes

- **Issue templates** use GitHub's YAML form schema (`name`, `description`, `title`, `labels`, `body[]` of typed fields). `change_request.yml` fields match the CR intake template in `sprint-log/2026-09-07_open-source-release/reports/feature-inventory.md` §5 exactly: requester context, summary, category, affected area, business justification, desired timeline, acceptance criteria, environment, plus a required checkbox acknowledging the "will not build" list. `config.yml` sets `blank_issues_enabled: false` and points Security to `docs/SECURITY.md` (via the repo's security policy URL), Paid services to guide 05, and the live demo to stillnotbald.com, matching the brief.
- **PR template** checklist items map one-to-one to the constitution's always-rules in root `CLAUDE.md` (one audit row per mutation, workspace-filtered queries, `requireScope`, `{ data }`/`{ error }` contract, same-commit RTM, tests, OpenAPI/llms.txt/MCP registry sync, no secrets/client names, green `npm run test` / `npx tsc --noEmit` / `npm run rtm:verify`). The "Do not open a PR that…" list mirrors the ask-first and will-not-build items from the same file and from `docs/guide/05-getting-help-and-paid-services.md`.
- **Dependabot**: npm ecosystems for `/web` and `/cli`, weekly, grouped minor+patch updates, plus weekly `github-actions` updates. Note: I removed a `security-updates-only` key I initially drafted — it is not a real dependabot.yml key. GitHub's security updates (for known-vulnerable versions) are controlled by the repo's Code security settings once Dependabot alerts are enabled, not by anything in this file; I left a comment explaining that instead of a non-functional key, since a made-up key would silently do nothing.
- **ROADMAP.md**: Shipped section links `requirements/REQUIREMENTS.md` (canonical R-IDs) rather than re-listing every feature. The paid-module menu is transcribed from feature-inventory.md §2b's decision-matrix table (8 items), each rewritten as a 2-line description plus what exists today plus rough size, no prices, "quote on request" per the brief. Not-planned section mirrors the constitution's ask-first/will-not-build list with a one-line reason per item, not just a bare list. No em-dashes anywhere in the new prose.
- **Landing page link**: used `process.env.NEXT_PUBLIC_CONTACT_URL ?? "https://github.com/StillNotBald/NoPM/issues/new/choose"` exactly as specified. Confirmed `StillNotBald/NoPM` is the actual intended public path by cross-checking `web/src/lib/onboarding/hints.ts` (`DOCS_BASE_URL`) and `sprint-log/2026-09-07_open-source-release/PUBLISH_RUNBOOK.md`, both of which already use that same path.
- **CLAUDE.md**: only the two-line italic note was added, immediately under the H1, nothing else in the file was touched.

## Verification

- `cd web && npx tsc --noEmit` — clean, no errors.
- `cd web && npx eslint src/app/page.tsx` — clean, no warnings or errors.
- All five new/changed YAML files (`bug_report.yml`, `change_request.yml`, `feature_request.yml`, `config.yml`, `dependabot.yml`) parsed successfully with `js-yaml` (available in `web/node_modules`) and passed a basic structural check (`name`/`description`/`body[]` present, every body item has a `type`) for the three issue-template forms.
- No git commits were made, per scope instructions. `git status` at the end of this task shows only the files listed above as new/modified in my scope; other teammates' staged/unstaged changes across the tree were left untouched.

## Requests for lead (R-92 RTM text)

Suggested RTM row for `requirements/TRACEABILITY.md` (I did not touch `requirements/` — out of my file scope):

> **R-92 — Contributor experience (issue templates, PR template, dependabot, public roadmap).** Implemented: `.github/ISSUE_TEMPLATE/{bug_report,change_request,feature_request,config}.yml`, `.github/PULL_REQUEST_TEMPLATE.md`, `.github/dependabot.yml`, `docs/ROADMAP.md`. Verified: YAML forms parse and match GitHub's issue-form schema; `web/src/app/page.tsx` change passes `tsc --noEmit` and `eslint`. No automated test suite covers GitHub-native template files (they aren't executed by the app); verification was structural (parse + schema-shape) rather than by a vitest case.

One judgment call worth flagging: the brief's dependabot spec said "security updates on," but there is no such per-ecosystem key in `dependabot.yml` — security updates are a repository-level toggle (Code security settings), independent of this file. I documented that in a comment rather than inventing a key, so the lead may want to confirm that toggle is (or will be) turned on in the actual GitHub repo settings once the repo goes public, since nothing in this file can do that for them.
