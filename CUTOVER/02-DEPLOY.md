# 02 · Deploy

**Status: ACTIVE**

NoPM's Vercel deploys are **manual** — there is no git-push→deploy hook wired up (verified: `sprint-log/2026-08-13_oss-finetune/SPRINT_SUMMARY.md`, "Vercel was NOT hooked to git pushes"). Every production release is a deliberate `vercel deploy` from a checked-out commit you've already tested locally.

## Ordering rule — migrations first

**Apply migrations before deploying the code that depends on them.** Every wave's code must be backward-compatible with the schema state one migration behind it within the same wave (additive columns/tables, guarded reads), so:

1. Migrate (step 1 below) against the live database.
2. Deploy (step 2 below) the code that expects the new schema.

Never deploy code that assumes a migration hasn't landed yet — a mid-deploy failure or a slow migration then leaves old code pointed at a half-migrated schema. If a migration must be reverted, see [03-ROLLBACK.md](03-ROLLBACK.md) — restore-from-backup, not a down-migration.

## 1. Apply migrations

From `web/`, against the target database's `DB_URL`:
```bash
node scripts/migrate.mjs
```
Idempotent — already-applied files (tracked in the `_nopm_migrations` ledger) are skipped. See [01-INSTALL.md](01-INSTALL.md) step 5 for what this does.

**Large/production installs — the `CONCURRENTLY` note.** `web/scripts/apply-migrations.mjs` wraps each migration file in one `begin … commit` transaction, and Postgres rejects `CREATE INDEX CONCURRENTLY` inside a transaction block outright. Migration `web/supabase/migrations/20260814000030_workspace_indexes.sql` documents this in its header and ships plain `CREATE INDEX IF NOT EXISTS` — acceptable at NoPM's own (portfolio-demo) table volume, where the SHARE lock is single-digit milliseconds. **If you are applying this migration (or any future index migration) against a live, heavily-written table at production volume, do not run it through this runner** — instead read the equivalent `CREATE INDEX CONCURRENTLY` statements out of the migration file and apply them manually, one at a time, outside a transaction, against the target database.

## 2. Deploy the app

From `web/`:
```bash
vercel deploy --prod --yes
```
This builds and promotes to production in one step, aliasing the production domain (`stillnotbald.com`) to the new deployment.

## Post-deploy verification
```bash
curl https://stillnotbald.com/api/health
node scripts/auth-smoke.mjs            # BASE defaults to the live site
```
Both must be green before the wave is considered live-deployed (see memory: deploy-each-wave-live — never ship a feature half-deployed).

## The rollback-freezes-alias gotcha

Vercel's **instant rollback** (dashboard → Deployments → previous deployment → "Instant Rollback", or `vercel rollback`) re-points the production alias at an older build **and pins it there** — it does not just temporarily patch things while you keep shipping. Every deploy after a rollback (including a routine `vercel deploy --prod --yes`) will silently target the *rolled-back* alias state until you explicitly **promote** a build again:
```bash
vercel promote <deployment-url-or-id>
```
Concretely: if you roll back after a bad release, then fix the bug and run `vercel deploy --prod --yes`, the new build **still deploys** but the production alias may not move the way you expect until you promote it. Always run `vercel ls` (or check the dashboard) after a rollback to confirm which deployment currently owns the `stillnotbald.com` alias before assuming your next deploy went live. See [03-ROLLBACK.md](03-ROLLBACK.md) for when to use rollback at all.

---

**Signature**

| Role | Name | Date | Signature |
|---|---|---|---|
| Owner (deploy executed) | | | |
| Client witness (optional) | | | |
