# Retest - runner C (automated)

| UAT ID | Retest date | Retested by (UAT runner C) | Method | Outcome | Notes |
|---|---|---|---|---|---|
| UAT-016 | 2026-10-18 | UAT runner C | Full Playwright suite against localhost:3000 (sign-out spec left opt-in), then the opt-in write journeys with E2E_WRITES=1. | Pass | Full suite 77 passed, 0 failed, 12 skipped (opt-in). Write journeys 13 passed, 0 failed, 1 skipped; token mint, invite and second-identity saved views now pass with demo@example.com as the demo user. Two extra stale-test causes found and fixed: nav mode and column choice persist per account, and PAT revoke now asks for confirmation. |
| UAT-017 | 2026-10-18 | UAT runner C | Reran probe-github, probe-lark and probe-api against the local stack and fake-lark. | Pass, with one carve-out | probe-github 8/8 (GH3, GH4, GH6 pass). probe-lark 51/51 (LK-X1 and the 16 LK-EM checks pass; LK-EM7 needed the same version fixture). probe-api 13/15: API8 and API11 fail only on the replayed-decision step (wanted 422, got 200), which is owner decision UAT-018, not test debt. |
