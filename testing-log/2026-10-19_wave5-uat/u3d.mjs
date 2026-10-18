import { call, rec, sql } from "./h.mjs";
const R={prog:"23e239a0-55f4-41f7-9b56-7c913a1ade78",prog2:"df642a8f-7a22-4841-b373-f5648ef5c288",res:"6a8d2f61-17b5-449b-90b3-68dda2e9bb0e",res2:"767fdcf6-c72d-4bde-bdc5-bfe8374d9d1b",al:"03d1adf8-5c5b-4463-8560-215d1ac6f0ec",cl:"1e6c6bf4-2fc9-4de5-92c9-cd69130730b7",spr:"10768d5f-f821-4e00-af11-72f2cc53cb54"};
const ap=(w,id,b={})=>call(w,"POST",`/api/deletion-requests/${id}/approve`,b);
let r = await ap("manager",R.prog); rec("U3-self-prog",{status:r.status,text:r.text.slice(0,250)});
r = await ap("priya",R.prog); rec("U3-priya-prog",{status:r.status,text:r.text.slice(0,300)});
r = await ap("admin",R.prog); rec("U3-admin-prog",{status:r.status,text:r.text.slice(0,300)});
console.log(sql(`select count(*) from programs where id='dc2e3a14-c295-489d-8083-f98a4c87df0f'`));
r = await ap("priya",R.cl); rec("U3-priya-clash",{status:r.status,text:r.text.slice(0,200)});
r = await ap("priya",R.res); rec("U3-priya-res",{status:r.status,text:r.text.slice(0,200)});
// direct sql
try { console.log(sql(`delete from programs where id='63188012-fb44-45ef-b846-58b3dc385aad'`)); } catch(e){ console.log("SQLERR", String(e.stderr||e.message).slice(0,300)); }
console.log(sql(`select count(*) from programs where id='63188012-fb44-45ef-b846-58b3dc385aad'`));
for (const [t,id] of [["sprints","83705242-e857-4d20-a432-1c4fa419b412"],["resource_members","6d47393d-4325-49a5-ad6b-d3b0e18a706e"],["allocations","d8e2989f-bb4d-44f4-b07e-3ce6bdce473b"]]) { try { console.log(t, sql(`delete from ${t} where id='${id}'`)); } catch(e){ console.log(t,"SQLERR", String(e.stderr||e.message).slice(0,200)); } }
