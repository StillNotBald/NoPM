-- 0121 — Supabase Security Advisor follow-up (security check 2026-11-07).
--
-- The advisor flagged three SECURITY DEFINER functions as executable by anon:
--
-- 1. nopm_audit_chain() is the BEFORE INSERT trigger on audit_log that links
--    each row into the hash chain (0104). It returns `trigger`, so PostgREST
--    never exposes it and a direct call fails, but the default PUBLIC grant
--    still lets anon and authenticated hold EXECUTE. Postgres checks EXECUTE
--    on a trigger function only at CREATE TRIGGER time, not when the trigger
--    fires, so revoking it changes nothing for inserts. Revoke it, matching
--    nopm_audit_canonical / nopm_audit_row_hash in 0104.
--
-- 2. nopm_current_workspace() and nopm_current_role() are deliberately left
--    as they are. They are the RLS scope helpers (0001, 0003, 0087): every
--    table policy calls them as the querying role, so that role needs
--    EXECUTE. For anon, auth.uid() is null and both return null, so they
--    leak nothing. Revoking anon would turn empty RLS results into
--    "permission denied for function" errors. Accepted advisor warning.

revoke execute on function nopm_audit_chain() from public, anon, authenticated;
