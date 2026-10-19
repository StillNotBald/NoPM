# 13 - Audit anchor: keeping the audit chain head outside the database

*Wave 5, W5-E (R-168, R-169, R-170). Owner decision Q8: a different database. Optional: with nothing set, the product works exactly as before and every screen says "Not anchored".*

## Why

The hash chain (migration 0104) proves the audit rows agree with each other. It cannot prove that the newest rows were not deleted, or that every row after an edit was recomputed, by someone who owns the NoPM database. The defence is a copy of the chain head in a place that person cannot write. The app saves `(workspace, chain_seq, head_hash, row_count, time)` into a SECOND database, once a day and at every chain check, and later compares the live chain with it. If the live chain is shorter, or the row at the anchored position has a different hash, the state is **mismatch**.

What it does not prove: a person who owns BOTH databases. Keep the two logins with different people, or at least different passwords in different places (D9).

## What the owner provides

| Item | Value |
|---|---|
| A second Postgres database | A second project at the same provider, under a separate login (D9). The free tier is enough: one row per workspace per day. |
| A role for the app | `nopm_anchor`, **insert and select only** on one table (D12). |
| One host variable | `NOPM_ANCHOR_DB_URL` on the app host (Vercel). Server-only. Never put it in a file in the repo. |

## Setup (about ten minutes)

1. **Create the second database.** In the provider, create a new project (separate login from the NoPM project). Copy its owner connection string. Call it `OWNER_URL` below. Do not give it to the app.
2. **Create the role.** Connect as the owner and run (choose a long random password, keep it in your password manager):

   ```sql
   create role nopm_anchor login password '<generated-password>';
   ```

3. **Create the table and the grants.** From the repo root, run the file once as the owner:

   ```sh
   psql "$OWNER_URL" -f web/anchor-db/001_audit_anchors.sql
   ```

   It creates the append-only table `audit_anchors` (updates, deletes and truncates are refused for every role by triggers), then grants the role `select` and `insert` only. The file is safe to run again. If you ran it before creating the role, run it again after step 2.
4. **Check the role cannot rewrite history.** Connect as `nopm_anchor` and try:

   ```sql
   update audit_anchors set head_hash = 'x';   -- permission denied
   delete from audit_anchors;                  -- permission denied
   ```

5. **Set the variable on the host.** Connection string of the role (not the owner), TLS on:

   ```
   NOPM_ANCHOR_DB_URL=postgresql://nopm_anchor:<generated-password>@<host>:5432/<db>
   ```

   Redeploy. The connection always uses TLS and the server certificate IS verified (a forged answer from the network could otherwise hide a mismatch). If the provider's certificate authority is not trusted by the host runtime and the connection fails with `certificate not trusted`, set `NOPM_ANCHOR_SSL_VERIFY=0` to keep TLS but skip the certificate check, and say so in your records.

   The app never creates the table itself: with the insert-and-select role a missing table shows as "Anchor unreachable" with the message "run web/anchor-db/001_audit_anchors.sql". (`NOPM_ANCHOR_BOOTSTRAP=1` makes the app create it on first use, for a rehearsal with an owner role. Never set it in production: a role that can create the table can also drop its append-only trigger.)
6. **First anchor.** Open the Trust Center as an admin and press "Verify now". The anchor card should read "Anchored <time> (n rows)". The daily run (01:07 UTC) anchors every workspace without anyone pressing anything.
7. **Read it back with SQL**, as the owner of the second database:

   ```sql
   select workspace_id, chain_seq, left(head_hash, 12) as head, row_count, anchored_at
     from audit_anchors order by anchored_at desc limit 10;
   ```

   The newest `chain_seq` for a workspace should match the head the weekly report or the audit pack prints ("Audit chain head: ...").

## What the screens show

| State | Trust Center | Meaning |
|---|---|---|
| Not anchored | grey "Not anchored" and how to turn it on | Variable unset, or this workspace was never anchored. Always the answer when the variable is unset. |
| Anchored | green "Anchored <time> (n rows)" | Compared with the outside copy and equal. Under every state except "Not anchored" the card says "State as of the last check, <time>" (the last "Verify now"); before any check it says it is the state from the last daily run, because the card first reads a record in the app database and the real comparison happens at each check and each daily run. |
| Behind | grey "Anchored <time>, N rows behind" | Equal, and the log has grown since. Normal between runs. |
| Unreachable | amber "Anchor unreachable since <time>" | The outside copy could not be read or written. Nothing else is affected. One `audit.anchor_failed` row per streak. The next success writes one `audit.anchored` row and clears it. |
| Mismatch | red "Anchor mismatch" | The log no longer matches the outside copy. One `audit.anchor_mismatch` row per streak. The verify call answers `ok: false`. Nothing is anchored while it lasts. |

The audit pack cover has one line: `Anchor: not anchored`, `Anchor: anchored <time> (n rows)`, `Anchor: MISMATCH ...` or `Anchor: unreachable`.

Error texts shown in the Trust Center and stored in the audit trail are a code and a fixed phrase only (for example `ENOTFOUND: DNS lookup failed`, `28P01: login refused`); they never contain the host, the role name or any part of the URL. Full detail is in the host's own logs of the provider.

## If it says Mismatch

1. Do not edit anything. The log and the outside copy are both evidence.
2. Compare: in the app database, `select chain_seq, row_hash, created_at from audit_log where workspace_id = '<id>' order by chain_seq desc limit 5;` and in the anchor database the newest `audit_anchors` rows for that workspace. The audit row `audit.anchor_mismatch` (written once) states which anchored position disagrees.
3. Rows removed: the live head is below the anchored `chain_seq`. Rows rewritten: the hash at the anchored `chain_seq` differs.
4. **After a legitimate restore from backup** (owner decision D20): the live log is shorter than the anchors, so it reads Mismatch. Once you have confirmed the restore was intended, the owner of the ANCHOR database records a **reset** for that workspace with the live head of the restored log. Read the head first, in the app database:

   ```sql
   select chain_seq, row_hash from audit_log where workspace_id = '<workspace-id>' order by chain_seq desc limit 1;
   ```

   Then, as the owner of the anchor database (not the app role), insert it:

   ```sql
   insert into audit_anchors (workspace_id, chain_seq, head_hash, row_count, anchored_at, source)
   values ('<workspace-id>', <chain_seq>, '<row_hash>', <chain_seq>, now(), 'reset');
   ```

   The newest `reset` row for a workspace is the new baseline: older anchor rows stay as history and are no longer compared. The next check (or the 01:07 UTC run) reads Anchored, the Trust Center says "Re-baselined on <date> after a restore", and the mismatch streak closes. A reset never hides anything that goes wrong AFTER it: later anchors are compared as usual, and a reset whose head does not match the live log is itself a mismatch. A reset is visible evidence, not a silent edit: it is a permanent row, inserted by the owner of the anchor database, with its own time.
5. Rows that were rewritten (not a restore) are not fixed by a reset. Investigate first; reset only when you can say why the log differs. There is deliberately no button for this and no manual anchor route.

## Failure behaviour (D8)

A head is anchored only after the chain was checked back to the previous anchor (or to row 1 for a first anchor): a partial check such as `?limit=1` passes but is not anchored on. A failed anchor never blocks a business write, a chain check or the daily job. The daily step has its own 8 second budget; after the first failed connection the other workspaces are marked failed without further attempts. The app never says "anchored" unless the outside copy was written and read back with the same hash.

## Rehearsal (local, no new container)

`web/scripts/local-db/probe-anchor.mjs` (12 checks, including the reset and the missing-table cases) creates a second database `nopm_anchor` and the role inside the existing local Postgres (port 54322, loopback only) and proves: unset variable, first anchor, newer anchor, same head again, role cannot update or delete, tamper becomes mismatch, same position different hash is a conflict, shorter chain is a mismatch, and an unreachable database fails fast without leaking the URL.

```sh
cd web && node scripts/local-db/probe-anchor.mjs
```

## Rollback

Unset `NOPM_ANCHOR_DB_URL` and redeploy. Every screen goes back to "Not anchored", the daily step does nothing, and nothing else changes. The primary table `audit_anchor_receipts` (migration 0112) can stay: it is display bookkeeping only. The second database can be deleted at the provider.

## Order of release

Apply migration 0112 before the build (additive, safe with the old build). Set the variable after the build is live, then press "Verify now" once.
