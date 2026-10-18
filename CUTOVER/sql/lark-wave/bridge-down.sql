-- NoPM · lark wave rollout · OPTIONAL BRIDGE, DOWN  (WRITES: removes two functions)
--
-- What it does: removes ONLY the two seven-argument deletion-commit functions that bridge-up.sql
-- re-created. Migration 0045's twelve-argument functions are never touched. The seven-argument
-- functions check actor ids only (no principal check), so they must not outlive the window.
-- When to run: right after the new build is promoted, if (and only if) bridge-up.sql was run.
-- Safe to run when they are already gone.

drop function if exists nopm_commit_task_deletion(uuid, uuid, text, uuid, text, text, text);
drop function if exists nopm_commit_project_deletion(uuid, uuid, text, uuid, text, text, text);
