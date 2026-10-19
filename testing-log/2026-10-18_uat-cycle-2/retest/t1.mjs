import { call, rec, sql } from "./h.mjs";
const PROJ = "ed3d04cd-18bd-4ad3-8848-07b876dbd907"; // locked ERP-EMEA
const mk = async (name, scopes) => { const r = await call("admin", "POST", "/api/tokens", { name, scopes }); return { status: r.status, id: r.json?.data?.id, token: r.json?.data?.token ?? r.json?.data?.plaintext, keys: Object.keys(r.json?.data ?? {}), err: r.json?.error }; };
const body = (t) => ({ title: `T1 retest emergency ${t}`, category: "scope", priority: "high", is_emergency: true, description: "retest" });
const before = sql("select count(*) from change_requests where title like 'T1 retest%'");
const a = await mk("retest-c2-t1a change:*", ["change:*"]);
rec("t1a-token", { status: a.status, id: a.id, keys: a.keys, err: a.err });
const ra = await call(a.token, "POST", `/api/projects/${PROJ}/change-requests`, body("wild"));
rec("t1a-raise", { status: ra.status, body: ra.text });
const mid = sql("select count(*) from change_requests where title like 'T1 retest%'");
const b = await mk("retest-c2-t1b decide+write", ["change:write", "change:decide", "change:read"]);
rec("t1b-token", { status: b.status, id: b.id, err: b.err });
const rb = await call(b.token, "POST", `/api/projects/${PROJ}/change-requests`, body("decide"));
rec("t1b-raise", { status: rb.status, body: rb.text });
rec("t1-counts", { before, afterWildcard: mid, afterDecide: sql("select count(*) from change_requests where title like 'T1 retest%'") });
