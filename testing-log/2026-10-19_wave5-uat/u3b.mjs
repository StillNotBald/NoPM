import { call, rec, sql } from "./h.mjs";
const T = Date.now();
let r = await call("manager","GET","/api/projects?limit=3"); const pid = (r.json?.data??[])[0]?.id; rec("pid",{pid, n:r.json?.data?.length});
const mk = async (path, body, key) => { const x = await call("manager","POST",path,body); rec("create-"+key,{status:x.status,id:x.json?.data?.id ?? x.json?.id,text:x.status>=300?x.text:""}); return x.json?.data?.id ?? x.json?.id; };
const spr = await mk("/api/sprints",{name:"W5UAT sprint "+T, start_date:"2026-11-01", end_date:"2026-11-14", project_id:pid},"sprint");
const res2 = "6d47393d-4325-49a5-ad6b-d3b0e18a706e";
const al = await mk("/api/allocations",{member_id:res2, project_id:pid, allocation_pct:10, window_start:"2026-11-01T00:00:00Z", window_end:"2026-11-10T00:00:00Z"},"allocation");
rec("ids2",{pid,spr,al});
