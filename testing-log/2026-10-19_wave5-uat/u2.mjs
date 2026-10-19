import { cookieHeader, BASE, require } from "./h.mjs";
import { writeFileSync } from "node:fs";
for (const f of ["csv","pdf"]) {
  const r = await fetch(`${BASE}/api/export?entity=audit_pack&format=${f}`,{headers:{cookie:cookieHeader("admin")}});
  const b = Buffer.from(await r.arrayBuffer()); writeFileSync(`audit-pack.${f}`,b);
  console.log(f,r.status,r.headers.get("content-type"),b.length);
  if (f==="csv") console.log(b.toString("utf8").split("\n").slice(0,12).join("\n"));
}
