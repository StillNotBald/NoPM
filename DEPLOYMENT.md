# Deployment

Content lives in one place: [`CUTOVER/02-DEPLOY.md`](CUTOVER/02-DEPLOY.md).

- Migrate first, then `vercel deploy --prod --yes` from `web/` (manual — no git-push→deploy hook).
- Watch the rollback-freezes-alias gotcha documented there before your next deploy after any rollback.

This file is a pointer only — do not restate deploy steps here.
