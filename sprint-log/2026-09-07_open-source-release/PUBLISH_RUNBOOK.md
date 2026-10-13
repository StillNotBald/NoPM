# Publish runbook — flipping NoPM public (maintainer-executed, in order)

Plain-language, one step at a time. Everything in code is already done in the working tree; these are the actions only the repository maintainer can take. Do them in order. Stop at any step that does not match what you expect.

## Why step 1 exists (read this first)

On 2026-08-13 the history was purged with `git filter-repo` and force-pushed. The purge worked for every reachable commit. But GitHub keeps the *old* objects on its servers until it runs garbage collection, and 25 days later it still has not. Checked on 2026-09-07: 18 of the 19 pre-purge commits still answer on the GitHub API by SHA, including one whose file list contains a private research file. While the repo is private only you can reach them. The moment it is public, anyone with a SHA can. So the repository must be recreated from a fresh clone, which never uploads the old objects at all.

## Step 0 — commit the release changes locally

```bash
cd "<projects-dir>/stillnotbald/NoPM"
git add -A
git commit -m "chore(release): open-source under Apache-2.0 — license switch, guides, security + sensitivity hardening"
```
The pre-commit leak gate runs automatically. Do **not** push to the old repo yet (pushing is harmless, but pointless: the old repo is being retired).

## Step 1 — recreate the repository from a fresh clone

```bash
cd "<projects-dir>/stillnotbald"
git clone --no-local --single-branch --branch main "<projects-dir>/stillnotbald/NoPM" NoPM-public
cd NoPM-public
git log --oneline | wc -l          # expect 117 (116 + the release commit)
git cat-file -t <pre-purge-sha>   # expect "fatal: Not a valid object name" (old objects absent)
git gc --prune=now --quiet
git remote remove origin
gh repo create StillNotBald/NoPM-next --private --source=. --remote=origin --push
```
Then prove the old objects are gone from the new repo (expect `404` on every line):
```bash
for s in <pre-purge-sha> <another-sha>; do gh api repos/StillNotBald/NoPM-next/commits/$s >/dev/null 2>&1 && echo "STILL THERE $s" || echo "404 ok $s"; done
```
(Take three or four pre-purge SHAs from the offline backup mirror and test each; use them in place of the placeholders above.)

## Step 2 — move the name so the public URL stays `github.com/StillNotBald/NoPM`

```bash
gh repo rename NoPM-private-archive --repo StillNotBald/NoPM --yes
gh repo rename NoPM --repo StillNotBald/NoPM-next --yes
gh repo archive StillNotBald/NoPM-private-archive --yes
```
Renaming the old repo first frees the name; renaming the new one takes it. GitHub redirects only exist for the *old* name, so nothing leaks through a redirect. Keep the archived private repo for a month, then delete it.

## Step 3 — re-add the GitHub Actions secrets on the new repo

The workflows read exactly these six secrets (values are in `web/.env.local` and your password manager, never in the repo):

| Secret | Used by |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | reseed, e2e-smoke |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | reseed, e2e-smoke |
| `SUPABASE_SERVICE_ROLE_KEY` | reseed, e2e-smoke |
| `ADMIN_EMAIL` | e2e-smoke (now masked in logs) |
| `DEMO_EMAIL` | reseed |
| `DEMO_PASSWORD` | reseed |

```bash
gh secret set NEXT_PUBLIC_SUPABASE_URL --repo StillNotBald/NoPM < <(printf '%s' "$VALUE")   # repeat per secret
```
`GITHUB_TOKEN` is automatic. The old repo's Action run logs (which printed the admin email) stay inside the archived private repo and never become public.

## Step 4 — point your local checkout at the new repo

```bash
cd "<projects-dir>/stillnotbald/NoPM"
git remote set-url origin https://github.com/StillNotBald/NoPM.git
git fetch origin && git status    # expect: up to date with origin/main
```
Delete the `NoPM-public` clone afterwards; it was only a vehicle. The pre-purge mirror `../NoPM-backup-2026-08-13.git` contains the private material: keep it offline, never push it anywhere.

## Step 5 — flip to public, then lock the branch

```bash
gh repo edit StillNotBald/NoPM --visibility public --accept-visibility-change-consequences
gh api -X PUT repos/StillNotBald/NoPM/branches/main/protection \
  -F required_pull_request_reviews=null -F enforce_admins=false -F restrictions=null \
  -F required_status_checks[strict]=true -f 'required_status_checks[contexts][]=verify' \
  -F allow_force_pushes=false -F allow_deletions=false
```
Branch protection is free once public. If the API call is fiddly, do it in Settings → Branches: require the `verify` check, block force-pushes and deletions.

Optional but recommended in the same sitting: Settings → General → Features: enable **Issues** (leave Discussions off unless you want to moderate it). Settings → Security: enable Dependabot alerts and secret scanning (free for public repos).

## Step 6 — first-day checks

- Open `https://github.com/StillNotBald/NoPM` logged out. The README should show the Apache-2.0 license badge area, the guides row, and the License and Trademarks sections.
- Re-run the SHA check from Step 1 against `StillNotBald/NoPM` (the renamed new repo). Expect 404s.
- Run the weekly smoke manually: `gh workflow run e2e-smoke.yml --repo StillNotBald/NoPM`, then read the log. The line should read `Authenticated smoke as ad***@stillnotbald.com`.
- Deploy the release commit to Vercel so the live site carries the document-upload hardening and the guides link: `cd web && vercel deploy --prod --yes` (the maintainer runs it; the harness is blocked from deploying).
- If Vercel's Git integration was linked to the old repo, relink it to the new one in the Vercel dashboard (Settings → Git). If you deploy manually with `vercel deploy`, nothing changes.

## What was deliberately NOT done by the assistant

- No commit, no push, no repo creation, no visibility change. All of those are outward-facing and the maintainer's.
- No deletion of anything on GitHub.
- The old private repo is archived, not deleted, so you can still consult its Issues or Action logs if ever needed.
