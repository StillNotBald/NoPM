import { require, BASE, cookiesOf } from "./h.mjs";
const { chromium } = require("@playwright/test");
export async function open(role, w = 390, h = 844) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  await ctx.addCookies(cookiesOf(role).map((c) => ({ ...c, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" })));
  await ctx.routeWebSocket(/hmr/, (ws) => { const srv = ws.connectToServer(); srv.onMessage((m) => { const s = typeof m === "string" ? m : ""; if (s.includes('"restart"') || s.includes("serverComponentChanges") || s.includes('"reload"') || s.includes('"building"')) return; ws.send(m); }); ws.onMessage((m) => srv.send(m)); });
  const page = await ctx.newPage();
  const shot = (n) => page.screenshot({ path: `screens/${n}.png` });
  const text = async () => (await page.locator("body").innerText()).replace(/\n{2,}/g, "\n");
  return { browser, page, shot, text };
}
export { BASE };
