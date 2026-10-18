import { createRequire } from "node:module";
const require = createRequire("<repo>/web/package.json");
const { chromium } = require("@playwright/test");
const b = await chromium.launch(); const ctx = await b.newContext(); const p = await ctx.newPage();
p.on("websocket", ws=>{ console.log("WS open", ws.url()); ws.on("framereceived", f=>console.log("  frame", String(f.payload).slice(0,160))); ws.on("close",()=>console.log("WS close")); });
p.on("console",m=>console.log("C:",m.type(),m.text().slice(0,200)));
p.on("load",()=>console.log("LOAD"));
await p.goto("http://localhost:3000/login", { waitUntil: "load" }); await p.waitForTimeout(12000);
await b.close();
