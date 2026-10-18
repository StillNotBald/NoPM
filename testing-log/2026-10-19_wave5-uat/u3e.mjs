import { call, rec, sql } from "./h.mjs";
const T=Date.now();
console.log(sql("update profiles set role='admin' where email='uat-a-member@example.com' returning role"));
let r = await call("manager","POST","/api/programs",{name:"W5UAT prog3 "+T}); const pid=r.json?.data?.id;
r = await call("manager","DELETE","/api/programs/"+pid,{reason:"two-admin 403 check"}); const rid=r.json?.data?.id; rec("U3-p3-req",{status:r.status,tier:r.json?.data?.tier});
r = await call("priya","POST",`/api/deletion-requests/${rid}/approve`,{}); rec("U3-priya-403-twoadmins",{status:r.status,text:r.text.slice(0,300)});
r = await call("admin","POST",`/api/deletion-requests/${rid}/approve`,{}); rec("U3-admin-approve",{status:r.status,text:r.text.slice(0,300)});
console.log(sql(`select count(*) from programs where id='${pid}'`));
console.log(sql("update profiles set role='member' where email='uat-a-member@example.com' returning role"));
// prog2 (admin approve) + remaining requests
r = await call("admin","POST","/api/deletion-requests/df642a8f-7a22-4841-b373-f5648ef5c288/approve",{}); rec("U3-admin-prog2",{status:r.status,text:r.text.slice(0,200)});
