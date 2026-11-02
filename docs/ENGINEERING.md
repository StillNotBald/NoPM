# Engineering and operations

The quality gates and operations docs behind NoPM, moved here from the root README so the README stays a front door.

## The governance gates travel with the clone

- **pre-commit** — leak gate over staged files (hashed confidential-token blocklist + secret-filename check)
- **pre-push** — typecheck, full test suite, RTM integrity, generated-metrics freshness, CLI contract tests
- **CI** — all of the above plus full-tree name scan, gitleaks (full history), dependency audit, and a weekly authenticated page-render smoke against the live site
- **Proof metrics are generated, not typed** — the case-study numbers come from `web/scripts/gen-metrics.mjs` (RTM + vitest + route tree); CI fails if they drift

## Operations & governance docs

- Go-live / cutover procedure: [`CUTOVER/`](../CUTOVER/README.md) — install, deploy, rollback, backup-restore, go/no-go, dry-run records
- How the pieces fit together: [`system_architecture.md`](architecture/system_architecture.md)
- What is live right now (the production snapshot): [`PROD_DOOR.md`](ops/PROD_DOOR.md)
- Test evidence tree: [`testing-log/`](../testing-log/README.md)
- Console user manual (operator / admin / agents): [`user-manual/README.md`](../user-manual/README.md)
- Common-pattern defaults (how open product questions are decided): [`adr/0015-common-pattern-defaults.md`](adr/0015-common-pattern-defaults.md)
