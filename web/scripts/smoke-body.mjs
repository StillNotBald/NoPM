// Stronger rehearsal: mint a session, fetch each page, and inspect the BODY —
// streamed pages return 200 even when a render error is captured by the error
// boundary, so status alone is insufficient. FAIL if the error-boundary text
// appears; PASS otherwise (with a marker that real content rendered).
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(path.join(here, "..", ".env.local"), "utf8")
    .split(/\r?\n/).map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]),
);
const BASE = process.env.BASE || "http://localhost:3100";
const EMAIL = process.env.ADMIN_EMAIL || env.ADMIN_EMAIL || "admin@stillnotbald.com";
const ref = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });

const gl = await admin.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
if (gl.error) { console.error("generateLink failed:", gl.error.message); process.exit(1); }
let v = await anon.auth.verifyOtp({ type: "email", token_hash: gl.data.properties.hashed_token });
if (v.error) v = await anon.auth.verifyOtp({ type: "magiclink", token_hash: gl.data.properties.hashed_token });
if (v.error || !v.data.session) { console.error("verifyOtp failed:", v.error?.message); process.exit(1); }
const val = "base64-" + Buffer.from(JSON.stringify(v.data.session)).toString("base64url");
const name = `sb-${ref}-auth-token`;
const cookie = (val.length <= 3180 ? [[name, val]]
  : Array.from({ length: Math.ceil(val.length / 3180) }, (_, n) => [`${name}.${n}`, val.slice(n * 3180, n * 3180 + 3180)])
).map(([k, vv]) => `${k}=${vv}`).join("; ");

const proj = (await admin.from("projects").select("id").order("created_at").limit(1).maybeSingle()).data;
const pages = [
  "/dashboard", "/my-work", "/my-tasks", "/portfolio", "/review", "/projects",
  ...(proj ? [`/projects/${proj.id}`, `/risks?risk=`] : []),
  "/documents", "/change-control", "/decisions", "/risks", "/issues", "/clashes",
  "/budget", "/resources", "/approvals", "/trust", "/tokens", "/settings", "/case-study",
];
const ERR = /ran into an unexpected error|Something went wrong/i;

let pass = 0, fail = 0;
console.log(`Body smoke as ${EMAIL} -> ${BASE}\n`);
for (const p of pages) {
  try {
    const r = await fetch(BASE + p, { headers: { Cookie: cookie }, redirect: "manual" });
    const body = await r.text();
    const errored = ERR.test(body);
    if (r.status === 200 && !errored) { pass++; console.log("PASS", p.padEnd(34), "200", body.length + "b"); }
    else { fail++; console.log("FAIL", p.padEnd(34), r.status, errored ? "(error-boundary in body)" : (r.headers.get("location") || "")); }
  } catch (e) { fail++; console.log("FAIL", p.padEnd(34), e.message); }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
