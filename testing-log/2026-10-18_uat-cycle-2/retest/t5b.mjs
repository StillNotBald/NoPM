import { call, rec, sql } from "./h.mjs";
const raw = () => sql("select approval_policy->'emergency_retro_hours' from workspaces where id='3c8968e0-9577-40db-bc92-39750736abd1'");
rec("t5b-raw-before", raw());
const p = await call("admin", "PATCH", "/api/workspace-settings", { approval_policy: { emergency_retro_hours: 96 } });
rec("t5b-patch96", { status: p.status, retro: p.json?.data?.approval_policy?.emergency_retro_hours });
const g = await call("admin", "GET", "/api/workspace-settings");
rec("t5b-get", { retro: g.json?.data?.approval_policy?.emergency_retro_hours, thr: g.json?.data?.approval_policy?.currency_threshold });
rec("t5b-raw-after", raw());
