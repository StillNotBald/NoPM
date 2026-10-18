import { call, rec } from "./h.mjs";
let g = await call("admin","GET","/api/workspace-settings"); const pol = g.json.data.approval_policy;
let r = await call("admin","PATCH","/api/workspace-settings",{stale_days:3,emergency_retro_hours:48}); rec("U8-patch-with-valid",{status:r.status,retro:r.text.includes("retro"),text:r.text.slice(0,200)});
r = await call("admin","PATCH","/api/workspace-settings",{approval_policy:{...pol,emergency_retro_hours:48}}); rec("U8-patch-in-policy",{status:r.status,retro:r.text.includes("retro"),text:r.text.slice(0,200)});
r = await call("admin","PATCH","/api/workspace-settings",{approval_policy:{...pol,tiers:{...pol.tiers,emergency:{...pol.tiers.emergency,emergency_retro_hours:48}}}}); rec("U8-patch-in-tier",{status:r.status,text:r.text.slice(0,200)});
g = await call("admin","GET","/api/workspace-settings"); rec("U8-final",{retro:g.text.includes("retro"),same:JSON.stringify(g.json.data.approval_policy)===JSON.stringify(pol)});
