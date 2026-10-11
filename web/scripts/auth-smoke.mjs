// Authenticated end-to-end smoke / "rehearsal": mint a real admin session
// server-side (no password typed — Supabase admin generate_link + verifyOtp),
// build the @supabase/ssr cookie, and fetch the live console pages AS the
// logged-in admin to prove they render (catches server-component render errors
// that an unauthenticated probe would miss). Optionally checks key UX markers.
//   Usage:  node scripts/auth-smoke.mjs            (defaults to the live site)
//           BASE=http://localhost:3000 node scripts/auth-smoke.mjs
import { createClient } from "@supabase/supabase-js";
import { loadEnv } from "./lib/env.mjs";

// Env precedence: process.env (CI secrets) over web/.env.local (local dev).
const env = loadEnv();
const BASE = process.env.BASE || "https://stillnotbald.com";
const EMAIL = process.env.ADMIN_EMAIL || env.ADMIN_EMAIL || "admin@stillnotbald.com";
const ref = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });

const gl = await admin.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
if (gl.error) { console.error("generateLink failed:", gl.error.message); process.exit(1); }
let v = await anon.auth.verifyOtp({ type: "email", token_hash: gl.data.properties.hashed_token });
if (v.error) v = await anon.auth.verifyOtp({ type: "magiclink", token_hash: gl.data.properties.hashed_token });
if (v.error || !v.data.session) { console.error("verifyOtp failed:", v.error?.message); process.exit(1); }

// @supabase/ssr cookie: "base64-" + base64url(JSON(session)), chunked at 3180.
const val = "base64-" + Buffer.from(JSON.stringify(v.data.session)).toString("base64url");
const name = `sb-${ref}-auth-token`;
const cookie = (val.length <= 3180
  ? [[name, val]]
  : Array.from({ length: Math.ceil(val.length / 3180) }, (_, n) => [`${name}.${n}`, val.slice(n * 3180, n * 3180 + 3180)])
).map(([k, vv]) => `${k}=${vv}`).join("; ");

// Resolve one real project id so we also walk the richest page (Charter / Board /
// Gantt / Activity / Risks / Issues tabs all live on the project detail page).
const proj = (await admin.from("projects").select("id").order("created_at").limit(1).maybeSingle()).data;

const pages = [
  "/dashboard", "/my-work", "/my-tasks", "/tasks", "/sprints", "/mainline", "/portfolio", "/review", "/projects",
  ...(proj ? [`/projects/${proj.id}`] : []),
  "/documents", "/change-control", "/decisions", "/risks", "/issues", "/clashes",
  "/budget", "/resources", "/timesheets", "/approvals", "/baselines", "/trust", "/tokens", "/case-study",
];

let pass = 0, fail = 0;
const maskedEmail = EMAIL.replace(/^(.{2}).*(@.*)$/, "$1***$2");
console.log(`Authenticated smoke as ${maskedEmail} → ${BASE}\n`);
for (const p of pages) {
  try {
    const r = await fetch(BASE + p, { headers: { Cookie: cookie }, redirect: "manual" });
    if (r.status === 200) { pass++; console.log("PASS", p.padEnd(16), "200"); }
    else { fail++; console.log("FAIL", p.padEnd(16), r.status, r.headers.get("location") || ""); }
  } catch (e) { fail++; console.log("FAIL", p.padEnd(16), e.message); }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
