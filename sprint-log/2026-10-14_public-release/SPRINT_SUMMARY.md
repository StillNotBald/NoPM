# Sprint Summary — 2026-10-14_public-release

**TL;DR:** NoPM is public under Apache-2.0 at `github.com/StillNotBald/NoPM`, served from a freshly created repository whose entire history was rewritten and verified before upload; the previous private repository is archived.

## Declared goals
- Final working-tree sanitization before release (continues `2026-09-07_open-source-release`).
- A brand-new GitHub repository whose whole history contains nothing private, keeping the public URL.
- Licence, contributor and security docs confirmed for Apache-2.0.

## Actual outcomes
- **Tree sweep.** Build receipts, contributor instructions and product docs reworded: client and partner references, employer references and personal identifiers removed; internal tooling and model names rewritten in plain English; owner-address phrasing made third-person. The 2026-09-07 sprint's working reports were removed and its summary, plan, decisions and runbook reworded to stand alone.
- **Leak gate.** The hashed blocklist was extended with every new term (hashes only). Model-family names are blocked as prose but allowed inside provider model identifiers, because the BYOK model picker ships them as product data.
- **History rewrite** (in a fresh `--no-local` clone, never in the working checkout): content and commit-message replacement for every term category, author emails mapped to the GitHub noreply address, AI-session links and model names removed from commit trailers, and the removed reports folder dropped from all history. The commit count was unchanged.
- **New repository.** It was created private from the rewritten clone, then took the `NoPM` name by rename. The old repository was renamed and archived, not deleted. Actions secrets were re-added from local configuration, with no values printed.
- **Going public.** Visibility was flipped only after the pre-purge objects were proven absent. `main` is protected (requires `verify`, blocks force-push and deletion). Dependabot alerts, secret scanning and push protection are on.

## R-IDs touched
- None (release operations and documentation only).

## Files
- `CLAUDE.md`, `NOTICE`, `README.md` (licence badge), `docs/product/PRODUCT.md`, `docs/CONTRIBUTING.md`, `docs/processes/README.md`, `docs/adr/0009-*`, `requirements/REQUIREMENTS.md` (wording only), sprint-log receipts.
- `scripts/commit-gate.mjs` (blocklist extension + model-identifier rule).
- `.gitleaksignore` (one entry: a test-fixture password in a schema validation test, not a credential).
- `web/src/app/(console)/change-control/page.tsx` (local variable rename).

## Tests / verification
All of this ran against the rewritten clone before upload, and again after the visibility flip where marked.
- Every term, as a strict pattern, was checked across every blob, commit message and author line: 0 hits. The literal per-term `log -S`, `log --grep` and `git grep` checks over all revisions had residual hits only as substrings of ordinary words, as the plural of an internal abbreviation, or as provider model identifiers.
- The leak gate's hashed scan over all of history, including blocklist entries that pre-date this sprint, found 0 objects; its full-tree scan was clean.
- Author and committer emails are only the noreply address, Dependabot and GitHub's merge committer.
- gitleaks over all history found no leaks (after the single false positive above was recorded).
- The full gate passed: typecheck, unit and governance tests, RTM integrity, generated-metrics freshness and CLI contract tests.
- Pre-purge and pre-rewrite commit SHAs (the known-sensitive one plus five more) answer "No commit found" on the new repository, both authenticated and anonymously after going public.
- CI on `main` is green on the public repository. The README renders logged out with the licence badge and the License and Trademarks sections. GitHub detects Apache-2.0, and a scoped code search for sample terms returns nothing beyond the product model identifiers.

## Follow-ups
- The owner sets the remaining Actions secret for the authenticated weekly smoke, then runs the smoke manually and confirms the admin address is masked in the log.
- The owner deploys the release commit to production (`vercel deploy --prod` from `web/`). Vercel was never Git-linked, so no relink was needed.
- Delete the archived private repository after about a month. Keep the pre-purge backup mirror offline, and delete it once it is no longer needed.
- Dependabot PRs opened while the repository was private failed only on Actions billing; re-run them before reviewing.
- The UI/UX overhaul is prepared on a separate branch and lands as a pull request after a visual check.
