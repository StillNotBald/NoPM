import { call, rec, sql } from "./h.mjs";
const base = {name:"UAT035 api "+Date.now()};
let r = await call("manager","POST","/api/projects",{...base,target_date:null});
rec("035-api-null", {status:r.status, text:r.text});
r = await call("manager","POST","/api/projects",{name:"UAT035 api2 "+Date.now()});
rec("035-api-omit", {status:r.status});
// 036 pending approvals
r = await call("admin","GET","/api/approvals?status=pending"); rec("036-approvals-api",{status:r.status,text:r.text.slice(0,400)});
console.log(sql("select id,tier,status from deletion_requests order by created_at desc limit 5").slice(0,500));
// 037
r = await call("manager","GET","/api/change-requests?limit=100");
const crs = r.json?.data ?? []; console.log(crs.length, JSON.stringify(crs.slice(0,2)).slice(0,500));
