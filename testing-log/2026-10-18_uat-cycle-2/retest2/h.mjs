import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
export const require = createRequire("<repo>/web/package.json");
export const BASE = "http://localhost:3000";
const FILES = { admin: "admin", manager: "demo", member: "uat-a-member", priya: "priya.nair", daniel: "daniel.okoro" };
export const cookiesOf = (r) => JSON.parse(readFileSync(`session-${FILES[r]}.json`, "utf8"));
export const cookieHeader = (r) => cookiesOf(r).map((c) => `${c.name}=${c.value}`).join("; ");
export async function call(who, method, url, body, extra = {}) {
  const headers = { "content-type": "application/json", ...(who.startsWith("npm_") ? { authorization: `Bearer ${who}` } : { cookie: cookieHeader(who) }), ...extra };
  const r = await fetch(BASE + url, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: "manual" });
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text: text.slice(0, 600) };
}
export const sh = (cmd) => require("node:child_process").execSync(cmd, { encoding: "utf8" }).trim();
export const sql = (q) => sh(`docker exec supabase_db_web psql -U postgres -d postgres -Atc "${q.replace(/"/g, '\\"')}"`);
export const results = existsSync("results.json") ? JSON.parse(readFileSync("results.json", "utf8")) : {};
export const rec = (k, v) => { results[k] = v; writeFileSync("results.json", JSON.stringify(results, null, 1)); console.log(k, JSON.stringify(v).slice(0, 700)); };
