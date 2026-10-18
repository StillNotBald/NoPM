import { call, rec, sql } from "./h.mjs";
const T=Date.now(); const pid="21271166-3cce-4d9b-99d4-59d6417008c3";
let r = await call("manager","POST",`/api/projects/${pid}/tasks`,{name:"W5UAT alloc task "+T}); rec("U4-task",{status:r.status,text:r.status>=300?r.text:"",id:r.json?.data?.id});
const tid=r.json?.data?.id;
const res="6d47393d-4325-49a5-ad6b-d3b0e18a706e";
r = await call("manager","POST","/api/allocations",{member_id:"f17e2326-c952-4b5f-93fb-e40ec56e93c1",task_id:tid,project_id:pid,allocation_pct:5,window_start:"2026-11-01T00:00:00Z",window_end:"2026-11-05T00:00:00Z"}); rec("U4-alloc",{status:r.status,text:r.status>=300?r.text:"",id:r.json?.data?.id});
console.log(sql(`select count(*) from allocations where task_id='${tid}'`));
r = await call("manager","DELETE","/api/tasks/"+tid,{reason:"PR-01 regression"}); rec("U4-req",{status:r.status,text:r.text.slice(0,150)});
const rid=r.json?.data?.id;
r = await call("admin","POST",`/api/deletion-requests/${rid}/approve`,{}); rec("U4-approve",{status:r.status,text:r.text.slice(0,300)});
console.log(sql(`select (select count(*) from tasks where id='${tid}') t,(select count(*) from allocations where task_id='${tid}') a`));
// resource w/ allocation approve (res2) as priya
r = await call("priya","POST","/api/deletion-requests/767fdcf6-c72d-4bde-bdc5-bfe8374d9d1b/approve",{}); rec("U3-res2-approve",{status:r.status,text:r.text.slice(0,300)});
console.log(sql(`select (select count(*) from resource_members where id='${res}') r,(select count(*) from allocations where id='d8e2989f-bb4d-44f4-b07e-3ce6bdce473b') a`));
console.log(sql("select after from audit_log where action='resource.delete' order by created_at desc limit 1").slice(0,400));
