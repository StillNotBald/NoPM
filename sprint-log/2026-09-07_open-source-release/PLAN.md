# PLAN — 2026-09-07 open-source release (working state; resume from first unchecked item)

Maintainer intent:
1. Demo site (stillnotbald.com) stays for look-and-feel; visitors play via Claude + MCP.
2. Source code published as **Apache-2.0** (currently MIT — switch).
3. Paid: implementation guide + change requests (CR) — maintainer charges for these.
4. Segregate open-source vs premium.
5. Deep security + sensitivity check; plain-language guides for others.
Constraints: AI-assisted development: sequential implementation passes, each cross-checked by independent automated review, then a manual diff review and full gate re-run.

## Phases
- [x] P1 Recon across five areas: security sweep, sensitivity sweep, feature inventory (open vs premium matrix), license audit, guide drafts
      → working reports were not retained in the repo; guide drafts in `docs/guide/` (new files only)
- [x] P2 Adversarial verification of top security/sensitivity findings (verify against exact code/live before fixing)
- [x] P3 Decisions: open/premium split (maintainer recommendation), license switch, what to fix pre-flip
- [x] P4 Apply fixes: LICENSE → Apache-2.0 (+NOTICE, package.json license fields), sensitivity redactions, pre-flip items
      (pptxgenjs bump / smoke-log email mask / GitHub GC note), finalize guides
- [x] P5 Gates: tsc, vitest, rtm:verify, leak gate (`node scripts/commit-gate.mjs --all` or equivalent), gen-metrics
- [x] P6 SPRINT_SUMMARY.md receipt + RTM row if warranted + final summary to the maintainer (do NOT push / flip repo public — maintainer's call)

## Log
- 00:01 created folder, recon started.
- 00:20 all five audit areas reported; F1/F2/F3/bootstrap/seed-name/svgs verified by hand. DECISION: everything open under Apache-2.0, premium = services. Started redaction pass (sprint-log + PRODUCT.md) and guide finalization (docs/guide). Core items: LICENSE/NOTICE/package.json/README, auth-smoke mask, document MIME allow-list, gitleaks pin, bootstrap ADMIN_EMAIL, seed name, delete public svgs.
- 00:30 P4 lead items DONE: LICENSE (canonical Apache-2.0, diffed IDENTICAL) + NOTICE + 3× package.json; README guide row + License + Trademarks; auth-smoke email masked; bootstrap honors ADMIN_EMAIL + no password echo; gitleaks SHA-pinned; seed Okafor→Okoro; 5 boilerplate SVGs git rm'd; F3 MIME normalize + magic-byte verify (storage.ts, file/route.ts, +12 tests, openapi, SECURITY.md, R-39 RTM). Gates: tsc clean, vitest 1929/1929, lint 0 err, RTM OK 77, metrics regenerated, CLI 23/23, leak gate 704 clean. DECISIONS.md + PUBLISH_RUNBOOK.md written. Lesson noted: purged objects persist on GitHub.
- WAITING on redaction pass + guide finalization. Then: pattern checks, `git add -A` + staged leak gate, SPRINT_SUMMARY.md, final summary. NO commit/push (maintainer).
- 00:45 ALL PHASES DONE. Staged (not committed). Receipt: SPRINT_SUMMARY.md. Maintainer: PUBLISH_RUNBOOK.md steps 0-6.
