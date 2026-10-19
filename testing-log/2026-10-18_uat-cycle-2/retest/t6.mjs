import { cookieHeader, BASE } from "./h.mjs";
import { writeFileSync } from "node:fs";
const r = await fetch(`${BASE}/api/export?entity=audit_pack&format=csv`, { headers: { cookie: cookieHeader("admin") } });
const t = await r.text(); writeFileSync("auditpack.csv", t);
console.log(r.status, t.length); 
