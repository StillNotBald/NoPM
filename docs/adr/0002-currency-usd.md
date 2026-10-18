# ADR 0002 — Currency standardized to USD (reversal of MYR)

- **Status:** Accepted
- **Date:** 2026-06-08

## Context

`MASTER-PLAN.md` and early migrations resolved on **MYR** (Malaysian Ringgit) as the budget currency. Migration `20260608000004_resource_budget.sql` and the enrichment pass (`adb5929`) explicitly standardized on `"MYR"` in the budget schema and API `fix(budget): standardize currency on MYR`.

Later the same day, the Wave B final commit (`b8ed1e8`) reversed this decision, standardizing everything on **USD**, via:
- `web/supabase/migrations/20260608000013_currency_usd.sql` — alters default and existing rows
- `web/src/app/(console)/budget/page.tsx` — `defaultValue="USD"` and `locale="en-US"`
- API route schemas — currency field defaults changed to `"USD"`
- EVM panel and all report exporters — dollar-sign formatting

## Decision

Use **USD** universally as the single budget currency for v1.

**Rationale:**
1. NoPM is an employer-facing portfolio piece. USD is the lingua franca for international PMO work and makes the demo legible to any hiring manager regardless of geography.
2. Locale `en-US` number formatting (`$1,234.56`) is immediately readable; `RM 1,234.56` adds cognitive load for non-Malaysian reviewers.
3. A single hardcoded currency eliminates a multi-currency complexity axis that is out of scope for v1 (no exchange-rate logic, no per-project currency selection).
4. The reversal cost was one migration + trivial UI string changes; the direction is defensible and consistent.

## Consequences

- All budget amounts in the DB, API responses, and UI display as USD / `$`.
- The MASTER-PLAN reference to MYR is superseded; treat this ADR as the canonical record.
- Multi-currency support (per-project currency, FX rates) is explicitly deferred to a future version.
- `web/src/lib/evm.ts` formats all EVM outputs (`PV/EV/AC/EAC/VAC`) as USD.
