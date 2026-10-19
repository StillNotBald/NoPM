import { cookieHeader, BASE } from "./h.mjs";
for (const w of ["admin","manager","member"]) {
  const r = await fetch(`${BASE}/api/export?entity=members&format=csv`,{headers:{cookie:cookieHeader(w)}});
  const t = await r.text(); const lines=t.replace(/^﻿/,"").split("\n");
  console.log(w,r.status,"|",lines[0],"|",lines.slice(1,4).join(" // ").slice(0,300));
}
