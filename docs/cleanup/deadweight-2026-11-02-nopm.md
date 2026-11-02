# Deadweight cleanup 2026-11-02 (NoPM)

Method: knip 5 with a Next.js entry config, then a repo-wide grep (code, docs, RTM, scripts, configs) per candidate.

## Removed (4 exports, 14 lines, 0 files, 0 deps)
- `web/src/lib/api-client.ts` `apiPatchWithWarnings`: no reference anywhere in the repo (its POST sibling is used).
- `web/src/lib/evm.ts` `FORECAST_METHODS`: no reference anywhere; the `ForecastMethod` type stays.
- `web/src/lib/audit/action-glossary.ts` `describeAuditAction` and its private `DESCRIPTIONS` map: no importer; the `AUDIT_ACTION_GLOSSARY` list stays.
- `web/src/lib/nudges/settings.ts` `getStaleDays`: no reference anywhere; `getNudgeSettings` stays.

## Proposed, needs owner
- `web/src/lib/auth/mfa.ts` `requiresMfaChallenge`: unused fail-open variant, comment says "kept for reference". Security module, so left alone.
- `web/src/components/registers/risk-detail.tsx` `RiskDataList`: responsive risk list (F5) with no importer; looks like a mobile-register feature that is not wired in.
- `web/src/lib/integrations/lark/handlers.ts` `handleLarkCardAction` / `handleLarkEvent`: entry points for the self-host relay route, no caller today.
- `web/src/lib/auth/mfa-factor.ts` `resetMissingTotpStepWarning`: "test seam" with no test using it.
- About 160 other exports flagged only because nothing outside their own file imports them (constants, message strings, helpers used in-file). Removing the `export` keyword is churn with no gain, so not touched.

## Kept on purpose
- `web/scripts/local-db/*` (20 files): knip calls them unused, but they are a manually run probe suite with a README, cited by the RTM, CUTOVER and sprint docs.
- `supabase` and `tailwindcss` devDependencies: supabase CLI is used by the backup/restore runbook; tailwindcss is imported by `globals.css`.
- `cli/commands/*.mjs`: loaded by dynamic import in `cli/nopm.mjs`.
- `runtime` exports in `lib/assistant/*`, `*Input` / `*Enum` schema types in `app/api/**/_schema.ts`: conventions and public type surface.
- No committed build output, logs, `.bak` or scratch files found; every script in `scripts/` and `web/scripts/` is referenced.
