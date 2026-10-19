import { call, rec, sql } from "./h.mjs";
const id = sql("select e.id from expenses e where e.workspace_id='3c8968e0-9577-40db-bc92-39750736abd1' and e.amount>=50000 and e.id not in (select target_id from deletion_requests where target_type='expense') order by amount limit 1");
console.log("expense", id, sql(`select amount from expenses where id='${id}'`));
const r = await call("manager","DELETE","/api/expenses/"+id,{reason:"UAT-036 retest high-risk"});
rec("036-create-hr",{status:r.status,text:r.text.slice(0,300)});
