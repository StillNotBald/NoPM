// NoPM local-DB probe — milestone calendar feed (ICS), end to end, LOCAL app only.
//
//   cd web && node scripts/local-db/probe-calendar.mjs
//
// A manager mints a feed, a calendar app fetches the secret URL, the owner
// revokes it. Proves, against the real routes + migration 0047:
//   - the subscription URL is returned once; only sha-256(token) is stored; the
//     audit row never contains the raw token
//   - GET /api/calendar/<token>.ics -> 200, text/calendar, private caching, and
//     exactly one VEVENT per DATED milestone of THIS workspace (undated and
//     other-workspace milestones are absent), each with the project name
//     resolved from the projects(name) embed, correct all-day dates, RFC 5545
//     escaping and <= 75-octet physical lines
//   - a project-scoped feed carries only that project's milestones
//   - unknown / malformed tokens are indistinguishable 404s
//   - revoke -> the same URL answers 404; double revoke 422; a teammate cannot
//     revoke someone else's feed but an admin can; a read-only PAT cannot mint
//
// Exit codes: 0 all PASS · 1 at least one FAIL · 2 guard refused · 3 stack/app down.
import "./guard.mjs";
import { needAnonKey } from "./guard.mjs";
import { createHash, randomBytes } from "node:crypto";
import { call, requireApp, sessionCookie } from "./app-client.mjs";
import { createReport, expect, expectEqual } from "./report.mjs";
import { connect, createFixtures, mintToken, must } from "./fixtures.mjs";

needAnonKey();
const { db, pgc, close } = await connect();
await requireApp();
const report = createReport("calendar feed (ICS) — local app");
const fx = await createFixtures({ db });
const cookies = { a: await sessionCookie(fx.a), b: await sessionCookie(fx.b), admin: await sessionCookie(fx.admin) };
const tag = fx.tag;
console.log(`[fixtures] workspace=${fx.workspaceId}`);

// ── data: 3 dated + 1 undated milestone here, 1 dated milestone elsewhere ──
const P1 = fx.project; // already has fx.milestone (dated 2026-12-01)
const P2 = await must(
  db.from("projects").insert({ workspace_id: fx.workspaceId, code: `P2-${tag.slice(-4).toUpperCase()}`, name: `Second project ${tag}` }).select("id, name").single(),
  "second project",
);
const M1 = fx.milestone; // 2026-12-01, P1
const M2 = await must(
  db.from("milestones").insert({ workspace_id: fx.workspaceId, project_id: P1.id, name: "Go-live, phase 2; sign-off", target_date: "2027-01-15" }).select("id, name").single(),
  "milestone M2 (needs escaping)",
);
const M4 = await must(
  db.from("milestones").insert({ workspace_id: fx.workspaceId, project_id: P2.id, name: `Beta ${tag}`, target_date: "2027-02-03" }).select("id, name").single(),
  "milestone M4",
);
const undated = await must(
  db.from("milestones").insert({ workspace_id: fx.workspaceId, project_id: P1.id, name: `Undated ${tag}`, target_date: null }).select("id, name").single(),
  "undated milestone",
);
const otherWs = await must(db.from("workspaces").insert({ name: `Other ${tag}`, slug: `other-${tag}` }).select("id").single(), "other workspace");
const otherProject = await must(
  db.from("projects").insert({ workspace_id: otherWs.id, code: "OTH", name: `OtherProject ${tag}` }).select("id").single(),
  "other project",
);
const otherMilestone = await must(
  db.from("milestones").insert({ workspace_id: otherWs.id, project_id: otherProject.id, name: `OtherMilestone ${tag}`, target_date: "2026-12-24" }).select("id, name").single(),
  "other milestone",
);

// ── ICS helpers (independent of the app's serialiser) ─────────────────────
const unfold = (text) => text.replace(/\r\n[ \t]/g, "");
const esc = (v) => v.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
function events(text) {
  const out = [];
  let cur = null;
  for (const line of unfold(text).split("\r\n")) {
    if (line === "BEGIN:VEVENT") cur = {};
    else if (line === "END:VEVENT") {
      out.push(cur);
      cur = null;
    } else if (cur) {
      const i = line.indexOf(":");
      cur[line.slice(0, i)] = line.slice(i + 1);
    }
  }
  return out;
}
const nextDay = (ymd) => new Date(Date.parse(`${ymd}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10).replaceAll("-", "");

async function mint(cookieOrToken, body) {
  const caller = typeof cookieOrToken === "string" && cookieOrToken.includes("=") ? { cookie: cookieOrToken } : { token: cookieOrToken };
  const r = await call("POST", "/api/calendar-feeds", { ...caller, body });
  expectEqual(r.status, 201, `mint feed (body ${r.text.slice(0, 200)})`);
  const url = new URL(r.json.data.url);
  const raw = url.pathname.split("/").pop().replace(/\.ics$/, "");
  return { id: r.json.data.id, path: url.pathname, raw, data: r.json.data };
}

// ── 1. mint ───────────────────────────────────────────────────────────────
let feed = null;
await report.check("CAL-1", "manager A mints a feed: URL returned once, only the hash stored, audit row free of the token", async () => {
  feed = await mint(cookies.a, { name: `Probe feed, "all" ${tag}` });
  expect(/^\/api\/calendar\/npc_[A-Za-z0-9_-]{43}\.ics$/.test(feed.path), `feed path ${feed.path}`);
  expect(!("token_hash" in feed.data), "the create response must not expose token_hash");
  const row = await pgc.query("select token_hash, created_by, project_id, revoked_at from calendar_feeds where id = $1", [feed.id]);
  expectEqual(row.rows[0].token_hash, createHash("sha256").update(feed.raw).digest("hex"), "token_hash must be sha256(raw token)");
  expectEqual([row.rows[0].created_by, row.rows[0].project_id, row.rows[0].revoked_at], [fx.a.id, null, null], "feed row");
  const audit = await pgc.query("select action, channel, actor_id, after::text as after from audit_log where workspace_id = $1 and target_id = $2", [fx.workspaceId, feed.id]);
  expectEqual(audit.rows.map((x) => x.action), ["calendar_feed.create"], "exactly one audit row for the mint");
  expect(!audit.rows[0].after.includes(feed.raw) && !audit.rows[0].after.includes(feed.raw.slice(4)), "the audit row must never contain the raw token");
  expectEqual([audit.rows[0].channel, audit.rows[0].actor_id], ["ui", fx.a.id], "audit provenance");
});
if (!feed) {
  report.fail("CAL-abort", "remaining checks need the feed from CAL-1", "feed was not minted; see CAL-1");
  report.finish();
  await close();
  process.exit(1);
}

// ── 2. fetch ──────────────────────────────────────────────────────────────
let first = null;
await report.check("CAL-2", "GET .ics -> 200 text/calendar, private cache, no referrer; one VEVENT per dated milestone of THIS workspace", async () => {
  first = await call("GET", feed.path);
  expectEqual(first.status, 200, `fetch (body ${first.text.slice(0, 160)})`);
  expect(/^text\/calendar;\s*charset=utf-8/i.test(first.headers.get("content-type") ?? ""), `content-type: ${first.headers.get("content-type")}`);
  expect(/private/.test(first.headers.get("cache-control") ?? ""), `cache-control must be private: ${first.headers.get("cache-control")}`);
  expectEqual(first.headers.get("referrer-policy"), "no-referrer", "referrer-policy");
  expect(first.text.startsWith("BEGIN:VCALENDAR\r\n") && first.text.endsWith("END:VCALENDAR\r\n"), "calendar must be CRLF-delimited and well-framed");
  const ev = events(first.text);
  expectEqual(ev.length, 3, `VEVENT count (dated milestones in this workspace only): ${JSON.stringify(ev.map((e) => e.SUMMARY))}`);
  const text = unfold(first.text);
  expect(!text.includes(undated.name), "an undated milestone must not produce an event");
  expect(!text.includes(otherMilestone.name) && !text.includes(otherProject.id), "another workspace's milestone leaked into the feed");
  expect(!first.text.includes(feed.raw), "the feed body must not echo its own token");
  expect(text.includes(`X-WR-CALNAME:${esc(`Probe feed, "all" ${tag}`)}`), "X-WR-CALNAME must be the feed name, escaped");
});

await report.check("CAL-3", "each event: stable UID, all-day dates (DTEND = next day), project name resolved via the embed, escaping", async () => {
  expect(first, "fetch result missing (see CAL-2)");
  const by = new Map(events(first.text).map((e) => [e.UID.split("@")[0], e]));
  const want = [
    [M1, P1, "20261201"],
    [M2, P1, "20270115"],
    [M4, P2, "20270203"],
  ];
  for (const [m, p, ymd] of want) {
    const e = by.get(`milestone-${m.id}`);
    expect(e, `no VEVENT for milestone ${m.name}`);
    expectEqual(e["DTSTART;VALUE=DATE"], ymd, `DTSTART for ${m.name}`);
    expectEqual(e["DTEND;VALUE=DATE"], nextDay(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6)}`), `DTEND for ${m.name}`);
    expectEqual(e.SUMMARY, `${esc(p.name)}: ${esc(m.name)}`, `SUMMARY for ${m.name} (project name must be resolved and text escaped)`);
    expect(e.DESCRIPTION.startsWith(`Project: ${esc(p.name)}\\n`), `DESCRIPTION must name the project: ${e.DESCRIPTION}`);
    expect(/^\d{8}T\d{6}Z$/.test(e.DTSTAMP) && /^\d+$/.test(e.SEQUENCE), `DTSTAMP/SEQUENCE: ${e.DTSTAMP} ${e.SEQUENCE}`);
    expect(e.URL.endsWith(`/projects/${p.id}`), `URL deep link: ${e.URL}`);
    expectEqual(e.TRANSP, "TRANSPARENT", "all-day milestones must not block time");
  }
});

await report.check("CAL-4", "RFC 5545 line length: every physical line <= 75 octets; folded lines unfold to the same text", async () => {
  expect(first, "fetch result missing (see CAL-2)");
  for (const line of first.text.split("\r\n")) {
    expect(Buffer.byteLength(line, "utf8") <= 75, `physical line of ${Buffer.byteLength(line, "utf8")} octets: ${line.slice(0, 60)}`);
  }
  // A long milestone name forces folding; unfolding must restore it exactly.
  const longName = `Long milestone ${"x".repeat(120)} ${tag}`;
  await must(db.from("milestones").insert({ workspace_id: fx.workspaceId, project_id: P1.id, name: longName, target_date: "2027-03-01" }), "long milestone");
  const r = await call("GET", feed.path);
  expectEqual(r.status, 200, "refetch");
  for (const line of r.text.split("\r\n")) expect(Buffer.byteLength(line, "utf8") <= 75, "a folded line exceeded 75 octets");
  expect(unfold(r.text).includes(esc(longName)), "the long name must survive folding intact");
  expectEqual(events(r.text).length, 4, "the new dated milestone must now appear");
});

await report.check("CAL-5", "the feed is deterministic (same bytes on refetch) and last_fetched_at is recorded", async () => {
  const a = await call("GET", feed.path);
  const b = await call("GET", feed.path);
  expectEqual(a.text === b.text, true, "two fetches of an unchanged workspace must be byte-identical");
  let seen = null;
  for (let i = 0; i < 40 && !seen; i++) {
    seen = (await pgc.query("select last_fetched_at from calendar_feeds where id = $1", [feed.id])).rows[0].last_fetched_at;
    if (!seen) await new Promise((r) => setTimeout(r, 100));
  }
  expect(seen, "last_fetched_at was never written (after() hook)");
  const audit = await pgc.query("select count(*)::int as n from audit_log where workspace_id = $1 and target_id = $2", [fx.workspaceId, feed.id]);
  expectEqual(audit.rows[0].n, 1, "fetching must not write audit rows (only the mint did)");
  const list = await call("GET", "/api/calendar-feeds", { cookie: cookies.a });
  expectEqual(list.status, 200, "list own feeds");
  expect(list.json.data.some((f) => f.id === feed.id) && !JSON.stringify(list.json).includes("token_hash"), "list must show the feed and never token_hash");
  const others = await call("GET", "/api/calendar-feeds", { cookie: cookies.b });
  expect(!others.json.data.some((f) => f.id === feed.id), "a teammate's list must not include A's feed");
});

// ── 3. scope + validation ─────────────────────────────────────────────────
await report.check("CAL-6", "project-scoped feed carries only that project's milestones; a foreign project id is refused", async () => {
  const scoped = await mint(cookies.a, { name: `P2 only ${tag}`, project_id: P2.id });
  const r = await call("GET", scoped.path);
  expectEqual(r.status, 200, "fetch scoped feed");
  const ev = events(r.text);
  expectEqual(ev.length, 1, `scoped feed events: ${JSON.stringify(ev.map((e) => e.SUMMARY))}`);
  expectEqual(ev[0].UID.split("@")[0], `milestone-${M4.id}`, "the only event must be P2's milestone");
  const foreign = await call("POST", "/api/calendar-feeds", { cookie: cookies.a, body: { name: "x", project_id: otherProject.id } });
  expectEqual(foreign.status, 422, `a project from another workspace must be refused (body ${foreign.text.slice(0, 160)})`);
  const bad = await call("POST", "/api/calendar-feeds", { cookie: cookies.a, body: { name: "" } });
  expectEqual(bad.status, 422, "empty name must fail validation");
});

await report.check("CAL-7", "unknown, malformed and wrong-length tokens are indistinguishable 404s", async () => {
  const guesses = [
    `/api/calendar/npc_${randomBytes(32).toString("base64url")}.ics`,
    `/api/calendar/npc_${randomBytes(32).toString("base64url")}`,
    "/api/calendar/not-a-token.ics",
    `/api/calendar/npm_${randomBytes(32).toString("base64url")}.ics`, // a PAT-shaped string is not a feed token
    `/api/calendar/${feed.raw.slice(0, -1)}${feed.raw.endsWith("A") ? "B" : "A"}.ics`, // exactly one character off a real token
  ];
  const bodies = new Set();
  for (const g of guesses) {
    const r = await call("GET", g);
    expectEqual(r.status, 404, `GET ${g.slice(0, 40)}…`);
    bodies.add(r.text);
  }
  expectEqual(bodies.size, 1, "every refusal must have the same body (no token oracle)");
});

await report.check("CAL-8", "who may mint: read-only PAT 403, ownerless PAT 403, viewer-role user 403", async () => {
  const readOnly = await mintToken(db, { workspaceId: fx.workspaceId, name: "probe read-only", createdBy: fx.a.id, scopes: ["milestone:read"] });
  expectEqual((await call("POST", "/api/calendar-feeds", { token: readOnly.raw, body: { name: "x" } })).status, 403, "milestone:read PAT");
  expectEqual((await call("POST", "/api/calendar-feeds", { token: fx.tokens.orphan.raw, body: { name: "x" } })).status, 403, "ownerless PAT");
  await pgc.query("update profiles set role = 'viewer' where id = $1", [fx.b.id]);
  try {
    expectEqual((await call("POST", "/api/calendar-feeds", { cookie: cookies.b, body: { name: "x" } })).status, 403, "viewer session");
  } finally {
    await pgc.query("update profiles set role = 'manager' where id = $1", [fx.b.id]);
  }
});

// ── 4. revoke ─────────────────────────────────────────────────────────────
await report.check("CAL-9", "revoke: teammate 403, owner 200 (one audit row), same URL then 404, second revoke 422", async () => {
  const teammate = await call("DELETE", `/api/calendar-feeds/${feed.id}`, { cookie: cookies.b });
  expectEqual(teammate.status, 403, `a non-admin teammate must not revoke A's feed (body ${teammate.text.slice(0, 160)})`);
  expectEqual((await call("GET", feed.path)).status, 200, "the feed must still work after a refused revoke");

  const mine = await call("DELETE", `/api/calendar-feeds/${feed.id}`, { cookie: cookies.a });
  expectEqual(mine.status, 200, `owner revokes (body ${mine.text.slice(0, 160)})`);
  expect(mine.json.data.revoked_at, "response must carry revoked_at");

  const gone = await call("GET", feed.path);
  expectEqual(gone.status, 404, "a revoked feed must 404 at once");
  expect(!gone.text.includes("BEGIN:VCALENDAR"), "a revoked feed must not serve any calendar data");

  expectEqual((await call("DELETE", `/api/calendar-feeds/${feed.id}`, { cookie: cookies.a })).status, 422, "second revoke");
  const audit = await pgc.query("select action from audit_log where workspace_id = $1 and target_id = $2 order by created_at", [fx.workspaceId, feed.id]);
  expectEqual(audit.rows.map((x) => x.action), ["calendar_feed.create", "calendar_feed.revoke"], "audit trail of the feed");
  const row = await pgc.query("select revoked_at from calendar_feeds where id = $1", [feed.id]);
  expect(row.rows[0].revoked_at, "revocation is soft: the row stays with revoked_at set");
  const list = await call("GET", "/api/calendar-feeds", { cookie: cookies.a });
  expect(!list.json.data.some((f) => f.id === feed.id), "a revoked feed must leave the active list");
});

await report.check("CAL-10", "an admin can revoke someone else's feed; the feed then 404s", async () => {
  const f = await mint(cookies.b, { name: `B's feed ${tag}` });
  expectEqual((await call("GET", f.path)).status, 200, "B's feed works");
  const r = await call("DELETE", `/api/calendar-feeds/${f.id}`, { cookie: cookies.admin });
  expectEqual(r.status, 200, `admin revokes (body ${r.text.slice(0, 160)})`);
  expectEqual((await call("GET", f.path)).status, 404, "admin-revoked feed must 404");
});

const allPassed = report.finish();
await close();
process.exit(allPassed ? 0 : 1);
