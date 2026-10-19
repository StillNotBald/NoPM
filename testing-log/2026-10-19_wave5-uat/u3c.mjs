import { call, rec, sql } from "./h.mjs";
const ids={prog:"dc2e3a14-c295-489d-8083-f98a4c87df0f",prog2:"63188012-fb44-45ef-b846-58b3dc385aad",spr:"83705242-e857-4d20-a432-1c4fa419b412",res:"31846240-fcb3-42aa-8089-6c62c84c9564",res2:"6d47393d-4325-49a5-ad6b-d3b0e18a706e",al:"d8e2989f-bb4d-44f4-b07e-3ce6bdce473b",cl:"e21572e2-c9bf-4b8c-be38-a3ab8a382552"};
let r = await call("manager","DELETE","/api/programs/"+ids.prog,{}); rec("U3-noreason",{status:r.status,text:r.text.slice(0,200)});
r = await call("uat-a-member".replace("uat-a-member","member"),"DELETE","/api/sprints/"+ids.spr,{reason:"member try"}); rec("U3-member",{status:r.status,text:r.text.slice(0,200)});
const route={prog:"programs",prog2:"programs",spr:"sprints",res:"resources",res2:"resources",al:"allocations",cl:"clashes"};
const out={};
for (const k of Object.keys(ids)) { r = await call("manager","DELETE",`/api/${route[k]}/${ids[k]}`,{reason:"W5 UAT "+k}); out[k]=r.json?.data?.id ?? r.json?.id; rec("U3-del-"+k,{status:r.status,text:r.text.slice(0,420)}); }
rec("U3-reqs",out);
console.log(sql("select id,target_type,tier,status,reason from deletion_requests order by created_at desc limit 7"));
