import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire("<repo>/web/package.json");
const { chromium } = require("@playwright/test");
export const BASE = "http://localhost:3000";
const ROLE = { admin: "admin", manager: "demo", member: "uat-a-member" };
export async function open(role, w = 390, h = 844) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const cookies = JSON.parse(readFileSync(`session-${ROLE[role]}.json`, "utf8")).map((c) => ({ ...c, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
  await ctx.addCookies(cookies); await ctx.routeWebSocket(/hmr/, (ws) => { const srv = ws.connectToServer(); const t0 = Date.now(); srv.onMessage((m) => { const str = typeof m === 'string' ? m : ''; if (str.includes('"restart"') || str.includes('serverComponentChanges') || str.includes('"reload"') || str.includes('"building"')) return; ws.send(m); }); ws.onMessage((m) => srv.send(m)); });
  const page = await ctx.newPage();
  const shot = (n) => page.screenshot({ path: `screens/ta-${n}.png`, fullPage: false });
  const text = async () => (await page.locator("body").innerText()).replace(/\n{2,}/g, "\n");
  return { browser, ctx, page, shot, text };
}
export const api = (page, method, url, body) => page.evaluate(async ([m, u, b]) => { const r = await fetch(u, { method: m, headers: { "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined }); let t = await r.text(); return { status: r.status, body: t.slice(0, 800) }; }, [method, url, body]);
