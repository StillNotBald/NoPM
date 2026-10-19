import { call, rec } from "./h.mjs";
const g = await call("admin","GET","/api/integrations/github/connector");
rec("t9-get",{status:g.status,connector:!!g.json?.data?.connector,rules:g.json?.data?.rules,targets:g.json?.data?.rule_targets});
if(!g.json?.data?.connector){const c=await call("admin","POST","/api/integrations/github/connector",{});rec("t9-create",{status:c.status,text:c.text.slice(0,300)});}
const p=await call("admin","PATCH","/api/integrations/github/connector",{rules:{deploy_success:"completed"}});
rec("t9-patch-completed",{status:p.status,body:p.text});
const q=await call("admin","GET","/api/integrations/github/connector");rec("t9-after",{rules:q.json?.data?.rules});
// T10
const P="bc20f19b-264a-4675-a30f-6a71c487b664";
const pr=await call("manager","PATCH",`/api/projects/${P}`,{code:""});
rec("t10-api-clear-code",{status:pr.status,body:pr.text.slice(0,300)});
