// NoPM local-DB probe — Lark card callback end to end, against the LOCAL app.
//
// A fake but correctly signed + AES-256-CBC-encrypted `card.action.trigger`
// callback is POSTed to /api/integrations/lark/<connector>/card, exactly as the
// platform would deliver a button click. The REAL Lark network is never called:
//   - nothing here talks to a Lark host; the connector holds fake credentials;
//   - requests are seeded straight into the database (no emit => no outbound
//     card send), and the seeded delivery row is 'superseded', so deciding a
//     request enqueues no card patch either (the final check N0 asserts that no
//     delivery was ever 'sent');
//   - belt and braces: start the app with HTTPS_PROXY pointed at a dead port
//     (README) so even a bug cannot reach a real Lark host.
//
//   cd web && node scripts/local-db/probe-lark.mjs
//
// Exit codes: 0 all PASS · 1 at least one FAIL · 2 guard refused · 3 stack/app down.
import "./guard.mjs";
import { assertLocalUrl, needAnonKey } from "./guard.mjs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { call, requireApp, sessionCookie } from "./app-client.mjs";
import { buildWebhookRequest, cardActionEnvelope, encryptBody, relayHeaders, signHeaders } from "./lark-wire.mjs";
import { startFakeLark } from "./fake-lark.mjs";
import { createReport, expect, expectEqual } from "./report.mjs";
import { connect, createFixtures, hashToken, makeUser, must, newTaskDeletionRequest } from "./fixtures.mjs";

needAnonKey();
const { db, pgc, close } = await connect();
await requireApp();
const report = createReport("Lark card callback — local app, fake signed callbacks");
const fx = await createFixtures({ db });
const adminCookie = await sessionCookie(fx.admin);
const tag = fx.tag;
console.log(`[fixtures] workspace=${fx.workspaceId}`);

// fake-lark: the loopback stand-in for the Lark open API (used by the LK-EM* checks). If it is not
// already running (node scripts/local-db/fake-lark.mjs) it is started in-process on the same port; the
// app must have been started with NOPM_LARK_API_BASE_OVERRIDE pointing at it either way.
const FAKE_PORT = Number(process.env.FAKE_LARK_PORT ?? 18080);
const fakeUrl = assertLocalUrl("fake-lark", `http://127.0.0.1:${FAKE_PORT}`).origin;
let fakeServer = null;
const fakeAlive = await fetch(`${fakeUrl}/__health`, { signal: AbortSignal.timeout(1500) })
  .then(async (r) => (await r.json()).ok === true)
  .catch(() => false);
if (!fakeAlive) {
  fakeServer = await startFakeLark({ port: FAKE_PORT });
  console.log(`[fake-lark] started in-process on ${fakeServer.baseUrl}`);
} else {
  console.log(`[fake-lark] using the running instance at ${fakeUrl}`);
}

// ── identities the fake Lark tenant uses ──────────────────────────────────
const APP_ID = `cli_probe_${tag}`;
const TENANT = `tenant_probe_${tag}`;
const OPEN_A = `ou_probe_a_${tag}`; // the requester (manager A)
const OPEN_B = `ou_probe_b_${tag}`; // the checker (manager B)
const OPEN_ADMIN = `ou_probe_admin_${tag}`; // the second approver (workspace admin)
const SECRETS = {
  appSecret: `app-secret-${randomBytes(9).toString("hex")}`,
  verificationToken: `vt_${randomBytes(9).toString("hex")}`,
  encryptKey: `ek_${randomBytes(9).toString("hex")}`,
};

// ── the wire contract this probe assumes (one place to adjust) ────────────
const CARD_PATH = (connectorId) => `/api/integrations/lark/${connectorId}/card`;
const EVENTS_PATH = (connectorId) => `/api/integrations/lark/${connectorId}/events`;
const RELAY_PATH = (connectorId) => `/api/integrations/lark/${connectorId}/relay`;
const ACTION_TOKEN_PREFIX = "npa_"; // src/lib/integrations/deliveries.ts; hash = sha256 hex, as for PATs
const HOUR = 3_600_000;

// ── 1. connect the app through the real admin API ────────────────────────
let connector = null; // { id, relaySecret }
await report.check("LK0", "admin creates a Lark connector via the API; response carries no secret value", async () => {
  const r = await call("POST", "/api/integrations/connectors", {
    cookie: adminCookie,
    body: {
      name: `probe lark ${tag}`,
      region: "lark",
      app_id: APP_ID,
      app_secret: SECRETS.appSecret,
      verification_token: SECRETS.verificationToken,
      encrypt_key: SECRETS.encryptKey,
      mode: "webhook",
      approvals: { enabled: true },
      digest: { enabled: false, weekday: 1 },
    },
  });
  expectEqual(r.status, 201, `create connector (body ${r.text.slice(0, 240)})`);
  const data = r.json.data;
  expect(data?.id && data.relay_secret, "response must include the connector id and the one-time relay secret");
  for (const [name, value] of Object.entries(SECRETS)) {
    expect(!r.text.includes(value), `response leaked ${name}`);
  }
  connector = { id: data.id, relaySecret: data.relay_secret };

  const list = await call("GET", "/api/integrations/connectors", { cookie: adminCookie });
  expectEqual(list.status, 200, "list connectors");
  expect(!/secret_enc|relay_secret_hash/.test(list.text), "list leaked a secret column");
  for (const [name, value] of Object.entries(SECRETS)) expect(!list.text.includes(value), `list leaked ${name}`);

  const row = await pgc.query("select secret_enc, relay_secret_hash, status, config from integration_connectors where id = $1", [connector.id]);
  expectEqual(row.rows[0].status, "active", "connector must be active");
  for (const [name, value] of Object.entries(SECRETS)) expect(!row.rows[0].secret_enc.includes(value), `${name} stored in plaintext`);
  expect(row.rows[0].relay_secret_hash !== connector.relaySecret, "relay secret stored in the clear");
  expectEqual(row.rows[0].relay_secret_hash, createHash("sha256").update(connector.relaySecret).digest("hex"), "relay_secret_hash must be sha256(raw)");
});

if (!connector) {
  report.fail("LK-abort", "remaining Lark checks need the connector from LK0", "connector was not created; see LK0");
  report.finish();
  await close();
  process.exit(1);
}

// ── 2. link the fake Lark users (service-role rows, as the task specifies) ─
await must(
  db.from("external_identities").insert([
    { workspace_id: fx.workspaceId, connector_id: connector.id, provider: "lark", external_tenant: TENANT, external_user_id: OPEN_A, display_name: "Probe A", profile_id: fx.a.id },
    { workspace_id: fx.workspaceId, connector_id: connector.id, provider: "lark", external_tenant: TENANT, external_user_id: OPEN_B, display_name: "Probe B", profile_id: fx.b.id },
    { workspace_id: fx.workspaceId, connector_id: connector.id, provider: "lark", external_tenant: TENANT, external_user_id: OPEN_ADMIN, display_name: "Probe admin", profile_id: fx.admin.id },
  ]),
  "external_identities",
);

// ── helpers ───────────────────────────────────────────────────────────────
let eventSeq = 0;
const newEventId = (label) => `evt_probe_${tag}_${label}_${++eventSeq}`;

/** Seed an approval request raised by A (service role: no emit => no outbound send). */
async function seedRequest(kind) {
  if (kind === "task_deletion") {
    const { task, request } = await newTaskDeletionRequest(db, fx, fx.actors.aToken); // A's agent token raises it
    return { kind, id: request.id, targetIds: [request.id, task.id], taskId: task.id };
  }
  if (kind === "change_request") {
    const row = await must(
      db
        .from("change_requests")
        .insert({
          workspace_id: fx.workspaceId,
          project_id: fx.project.id,
          title: `probe change ${randomBytes(3).toString("hex")}`,
          status: "raised",
          requested_by: fx.a.id,
          requested_by_type: "user",
          requested_by_id: fx.a.id,
          requested_by_label: fx.a.label,
          requested_principal_id: fx.a.id,
        })
        .select("id")
        .single(),
      "change_request",
    );
    return { kind, id: row.id, targetIds: [row.id] };
  }
  throw new Error(`unknown kind ${kind}`);
}

/**
 * Seed the card's action token (documented hashing: sha256 hex of the raw
 * token, 7-day TTL, recipient- and approval-bound) behind a SUPERSEDED
 * delivery so nothing is ever sent for it.
 */
async function seedActionToken(req, recipient, { expiresInMs = 7 * 24 * HOUR } = {}) {
  const delivery = await must(
    db
      .from("integration_deliveries")
      .insert({
        workspace_id: fx.workspaceId,
        connector_id: connector.id,
        kind: "approval_card",
        approval_kind: req.kind,
        approval_id: req.id,
        recipient_profile_id: recipient.id,
        external_target: recipient === fx.b ? OPEN_B : OPEN_A,
        status: "superseded",
        last_error: "probe: seeded, never sent",
      })
      .select("id")
      .single(),
    "delivery",
  );
  const raw = `${ACTION_TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
  await must(
    db.from("action_tokens").insert({
      workspace_id: fx.workspaceId,
      delivery_id: delivery.id,
      recipient_profile_id: recipient.id,
      approval_kind: req.kind,
      approval_id: req.id,
      token_hash: hashToken(raw),
      expires_at: new Date(Date.now() + expiresInMs).toISOString(),
    }),
    "action_token",
  );
  return raw;
}

/** POST a signed + encrypted card click. Returns the app's response plus what was sent. */
async function click({ openId, token, action = "approve", eventId, reason, verificationToken = SECRETS.verificationToken, tamper, timestamp, tenantKey = TENANT, path = CARD_PATH(connector.id) }) {
  const envelope = cardActionEnvelope({
    eventId,
    verificationToken,
    appId: APP_ID,
    tenantKey,
    openId,
    actionToken: token,
    action,
    formValue: reason === undefined ? undefined : { reason },
  });
  const { rawBody, headers } = buildWebhookRequest(envelope, { encryptKey: SECRETS.encryptKey, timestamp, tamper });
  const res = await call("POST", path, { raw: rawBody, headers });
  return { ...res, rawBody, sentHeaders: headers, eventId };
}

const toastOf = (r) => r.json?.toast ?? null;
const expectToast = (r, wantSuccess, what) => {
  expectEqual(r.status, 200, `${what}: HTTP status (body ${r.text.slice(0, 240)})`);
  const t = toastOf(r);
  expect(t && typeof t.content === "string" && t.content.length > 0, `${what}: response must carry a toast {type, content}: ${r.text.slice(0, 200)}`);
  if (wantSuccess) expectEqual(t.type, "success", `${what}: toast type`);
  else expect(t.type !== "success", `${what}: a refused click must not show a success toast (${JSON.stringify(t)})`);
};

async function inboundRow(eventId) {
  const r = await pgc.query(
    "select action, approval_kind, approval_id, principal_id, outcome from inbound_actions where connector_id = $1 and external_event_id = $2",
    [connector.id, eventId],
  );
  return r.rows;
}
async function auditByEvent(eventId) {
  const r = await pgc.query(
    `select action, channel, actor_type, actor_id, via_connector_id, external_event_id, external_actor_ref
       from audit_log where workspace_id = $1 and external_event_id = $2 order by created_at`,
    [fx.workspaceId, eventId],
  );
  return r.rows;
}
/** Audit rows about this request's targets. Seeding is direct SQL (no audit), so every row here comes from the click. */
async function auditForTargets(req) {
  const r = await pgc.query("select action, channel from audit_log where workspace_id = $1 and target_id = any($2::uuid[]) order by created_at", [fx.workspaceId, req.targetIds]);
  return r.rows;
}
async function approvalStatus(req) {
  if (req.kind === "task_deletion") {
    const r = await pgc.query("select status from deletion_requests where id = $1", [req.id]);
    const t = await pgc.query("select 1 from tasks where id = $1", [req.taskId]);
    return `${r.rows[0].status}${t.rowCount ? "" : "+task_deleted"}`;
  }
  const r = await pgc.query("select status from change_requests where id = $1", [req.id]);
  return r.rows[0].status;
}
const PENDING = { task_deletion: "pending", change_request: "raised" };
const DECIDED = { task_deletion: "committed+task_deleted", change_request: "approved" };

// ── 2b. the URL handshake an admin does first in the Lark console ─────────
await report.check("LK-E1", "events URL handshake: url_verification echoes the challenge (plain and encrypted); wrong token 401", async () => {
  const challenge = `challenge-${randomBytes(6).toString("hex")}`;
  const body = { challenge, token: SECRETS.verificationToken, type: "url_verification" };
  const plain = await call("POST", EVENTS_PATH(connector.id), { body });
  expectEqual([plain.status, plain.json?.challenge], [200, challenge], `plain handshake (body ${plain.text.slice(0, 160)})`);
  const rawBody = encryptBody(JSON.stringify(body), SECRETS.encryptKey);
  const enc = await call("POST", EVENTS_PATH(connector.id), { raw: rawBody, headers: signHeaders({ rawBody, encryptKey: SECRETS.encryptKey }) });
  expectEqual([enc.status, enc.json?.challenge], [200, challenge], `encrypted handshake (body ${enc.text.slice(0, 160)})`);
  const bad = await call("POST", EVENTS_PATH(connector.id), { body: { ...body, token: "vt_not_the_one" } });
  expectEqual(bad.status, 401, "handshake with a wrong verification token must be refused");
  expect(!bad.text.includes(challenge), "a refused handshake must not echo the challenge");
});

// ── 3. per approval kind: approve, replay, self-click, wrong recipient ─────
for (const kind of ["change_request", "task_deletion"]) {
  const k = kind === "change_request" ? "CR" : "TD";

  const main = await seedRequest(kind);
  const mainToken = await seedActionToken(main, fx.b);
  const approveEvent = newEventId(`${k}-approve`);
  let first = null;

  await report.check(`LK-${k}1`, `[${kind}] B clicks Approve -> 200 success toast, request ${DECIDED[kind]}, one inbound ledger row`, async () => {
    first = await click({ openId: OPEN_B, token: mainToken, eventId: approveEvent });
    expectToast(first, true, "approve click");
    expectEqual(await approvalStatus(main), DECIDED[kind], "approval state");
    const ledger = await inboundRow(approveEvent);
    expectEqual(ledger.length, 1, "inbound_actions rows for the event");
    expectEqual([ledger[0].outcome?.status, ledger[0].principal_id, ledger[0].approval_kind, ledger[0].approval_id], ["decided", fx.b.id, kind, main.id], "ledger row");
    const tok = await pgc.query("select used_at from action_tokens where token_hash = $1", [hashToken(mainToken)]);
    expect(tok.rows[0].used_at, "the action token must be consumed (single use)");
  });

  await report.check(`LK-${k}2`, `[${kind}] audit: rows written by the click carry channel 'lark', the verified human and the platform event`, async () => {
    const rows = await auditByEvent(approveEvent);
    expect(rows.length >= 1, `no audit row carries external_event_id=${approveEvent} (the click's provenance is lost)`);
    expect(rows.every((r) => r.channel === "lark"), `channels: ${JSON.stringify(rows.map((r) => r.channel))}`);
    expect(rows.every((r) => r.actor_id === fx.b.id && r.actor_type === "user"), "actor must be the linked human (B), not a token");
    expect(rows.every((r) => r.via_connector_id === connector.id), "via_connector_id must name the connector");
    expect(rows.every((r) => r.external_actor_ref === `lark:${TENANT}:${OPEN_B}`), `external_actor_ref: ${JSON.stringify(rows.map((r) => r.external_actor_ref))}`);
    return `${rows.length} audit row(s): ${rows.map((r) => r.action).join(", ")}`;
  });

  await report.check(`LK-${k}3`, `[${kind}] every audit row for the decision has channel 'lark' (none stamped 'ui'/'api')`, async () => {
    const rows = await auditForTargets(main);
    expect(rows.length >= 1, "no decision audit rows found for the request");
    expect(rows.every((r) => r.channel === "lark"), `channels: ${JSON.stringify(rows)}`);
    return rows.map((r) => r.action).join(", ");
  });

  await report.check(`LK-${k}4`, `[${kind}] replay of the same callback -> same response, no second mutation or audit row`, async () => {
    const auditBefore = (await auditForTargets(main)).length;
    const again = await call("POST", CARD_PATH(connector.id), { raw: first.rawBody, headers: first.sentHeaders });
    expectEqual(again.status, 200, `replay (body ${again.text.slice(0, 200)})`);
    // The replacement card embeds a render timestamp, so compare the toast (the outcome), not the whole card.
    expectEqual(again.json?.toast, first.json?.toast, "replay must return the stored outcome");
    // A platform RETRY is a fresh delivery: new nonce + signature, same event id.
    const retryReq = buildWebhookRequest(
      cardActionEnvelope({ eventId: approveEvent, verificationToken: SECRETS.verificationToken, appId: APP_ID, tenantKey: TENANT, openId: OPEN_B, actionToken: mainToken, action: "approve" }),
      { encryptKey: SECRETS.encryptKey },
    );
    const retry = await call("POST", CARD_PATH(connector.id), { raw: retryReq.rawBody, headers: retryReq.headers });
    expectEqual(retry.status, 200, "retry with a fresh signature");
    expectEqual((await auditForTargets(main)).length, auditBefore, "a replay must not write audit rows");
    expectEqual((await inboundRow(approveEvent)).length, 1, "still exactly one ledger row");
    expectEqual(await approvalStatus(main), DECIDED[kind], "approval state unchanged");
  });

  await report.check(`LK-${k}5`, `[${kind}] a NEW click event on the used token -> already decided, no mutation`, async () => {
    const auditBefore = (await auditForTargets(main)).length;
    const r = await click({ openId: OPEN_B, token: mainToken, eventId: newEventId(`${k}-reuse`) });
    expectToast(r, false, "token reuse");
    expectEqual((await inboundRow(r.eventId))[0].outcome?.status, "already_decided", "outcome");
    expectEqual((await auditForTargets(main)).length, auditBefore, "no audit rows");
  });

  // requester clicks their own card (a spoofed / mis-addressed token): four-eyes by HUMAN
  const own = await seedRequest(kind);
  const ownToken = await seedActionToken(own, fx.a);
  await report.check(`LK-${k}6`, `[${kind}] requester A clicks Approve on their own request -> self_approval toast, nothing committed`, async () => {
    const r = await click({ openId: OPEN_A, token: ownToken, eventId: newEventId(`${k}-self`) });
    expectToast(r, false, "requester self click");
    expectEqual((await inboundRow(r.eventId))[0].outcome?.status, "self_approval", "ledger outcome");
    expectEqual(await approvalStatus(own), PENDING[kind], "the request must stay undecided");
    expectEqual((await auditForTargets(own)).length, 0, "a refused click must write no audit row about the request");
  });

  const wrong = await seedRequest(kind);
  const wrongToken = await seedActionToken(wrong, fx.b);
  await report.check(`LK-${k}7`, `[${kind}] A clicks the card that was sent to B -> not_recipient, B's token stays usable`, async () => {
    const r = await click({ openId: OPEN_A, token: wrongToken, eventId: newEventId(`${k}-wrongrecipient`) });
    expectToast(r, false, "wrong recipient");
    expectEqual((await inboundRow(r.eventId))[0].outcome?.status, "not_recipient", "ledger outcome");
    expectEqual(await approvalStatus(wrong), PENDING[kind], "the request must stay undecided");
    expectEqual((await auditForTargets(wrong)).length, 0, "no audit row about the request");
    const tok = await pgc.query("select used_at from action_tokens where token_hash = $1", [hashToken(wrongToken)]);
    expectEqual(tok.rows[0].used_at, null, "a refused click must not burn the legitimate recipient's token");
  });

  const rej = await seedRequest(kind);
  const rejToken = await seedActionToken(rej, fx.b);
  await report.check(`LK-${k}8`, `[${kind}] Reject needs a reason: blank -> not decided; with reason -> rejected`, async () => {
    const blank = await click({ openId: OPEN_B, token: rejToken, action: "reject", eventId: newEventId(`${k}-rej-blank`), reason: "   " });
    expectToast(blank, false, "reject without reason");
    expectEqual(await approvalStatus(rej), PENDING[kind], "still undecided after a blank reject");
    const withReason = await click({ openId: OPEN_B, token: rejToken, action: "reject", eventId: newEventId(`${k}-rej`), reason: "probe: not needed" });
    expectToast(withReason, true, "reject with reason");
    const after = await approvalStatus(rej);
    expectEqual(after, "rejected", "request must be rejected");
  });
}

// ── 4. cross-channel supersession (no network involved) ───────────────────
await report.check("LK-X1", "decided in the console first: B's later card click is 'already decided', no second mutation", async () => {
  const req = await seedRequest("change_request");
  const token = await seedActionToken(req, fx.b);
  // B decides through the REST API with their PAT (a different channel).
  const decided = await call("POST", `/api/change-requests/${req.id}/decision`, {
    token: fx.tokens.b.raw,
    body: { decision: "approve", rationale: "probe: decided in the console" },
  });
  expectEqual(decided.status, 200, `REST decision (body ${decided.text.slice(0, 200)})`);
  // The hub kills open action tokens in an after() hook; give it a moment.
  let used = null;
  for (let i = 0; i < 40 && !used; i++) {
    used = (await pgc.query("select used_at from action_tokens where token_hash = $1", [hashToken(token)])).rows[0].used_at;
    if (!used) await new Promise((r) => setTimeout(r, 100));
  }
  expect(used, "the open action token was not invalidated when the request was decided elsewhere");
  const auditBefore = (await auditForTargets(req)).length;
  expectEqual(auditBefore, 1, "the REST decision wrote exactly one audit row");
  const r = await click({ openId: OPEN_B, token, eventId: newEventId("xchannel") });
  expectToast(r, false, "late click");
  expectEqual((await inboundRow(r.eventId))[0].outcome?.status, "already_decided", "ledger outcome");
  expectEqual((await auditForTargets(req)).length, auditBefore, "no extra audit row");
});

// ── 5. authenticity: nothing unauthenticated reaches the pipeline ─────────
const victim = await seedRequest("change_request");
const victimToken = await seedActionToken(victim, fx.b);
const assertVictimUntouched = async (what) => {
  expectEqual(await approvalStatus(victim), PENDING.change_request, `${what}: the request must be untouched`);
  const tok = await pgc.query("select used_at from action_tokens where token_hash = $1", [hashToken(victimToken)]);
  expectEqual(tok.rows[0].used_at, null, `${what}: the token must be unused`);
};

await report.check("LK-S1", "bad signature (one nibble flipped) -> 401, no ledger row", async () => {
  const r = await click({ openId: OPEN_B, token: victimToken, eventId: newEventId("badsig"), tamper: "signature" });
  expectEqual(r.status, 401, `body ${r.text.slice(0, 160)}`);
  expectEqual((await inboundRow(r.eventId)).length, 0, "an unauthenticated request must not create a ledger row");
  await assertVictimUntouched("bad signature");
});

await report.check("LK-S2", "ciphertext altered after signing -> 401", async () => {
  const r = await click({ openId: OPEN_B, token: victimToken, eventId: newEventId("badbody"), tamper: "body" });
  expectEqual(r.status, 401, `body ${r.text.slice(0, 160)}`);
  await assertVictimUntouched("altered body");
});

await report.check("LK-S3", "validly signed but 10 minutes old (replay window) -> 401", async () => {
  const stale = String(Math.floor(Date.now() / 1000) - 600);
  const r = await click({ openId: OPEN_B, token: victimToken, eventId: newEventId("stale"), timestamp: stale });
  expectEqual(r.status, 401, `body ${r.text.slice(0, 160)}`);
  await assertVictimUntouched("stale timestamp");
});

await report.check("LK-S4", "validly signed + encrypted but wrong verification token -> 401", async () => {
  const r = await click({ openId: OPEN_B, token: victimToken, eventId: newEventId("badtoken"), verificationToken: "vt_not_the_one" });
  expectEqual(r.status, 401, `body ${r.text.slice(0, 160)}`);
  await assertVictimUntouched("wrong verification token");
});

await report.check("LK-S5", "plaintext, unsigned body (encrypt key is configured) -> 401", async () => {
  const eventId = newEventId("plain");
  const envelope = cardActionEnvelope({ eventId, verificationToken: SECRETS.verificationToken, appId: APP_ID, tenantKey: TENANT, openId: OPEN_B, actionToken: victimToken, action: "approve" });
  const r = await call("POST", CARD_PATH(connector.id), { body: envelope });
  expectEqual(r.status, 401, `body ${r.text.slice(0, 160)}`);
  await assertVictimUntouched("unsigned plaintext");
});

await report.check("LK-S6", "a signature made with a different connector's secrets is refused (wrong key) -> 401", async () => {
  const eventId = newEventId("wrongkey");
  const envelope = cardActionEnvelope({ eventId, verificationToken: SECRETS.verificationToken, appId: APP_ID, tenantKey: TENANT, openId: OPEN_B, actionToken: victimToken, action: "approve" });
  const otherKey = `ek_${randomBytes(9).toString("hex")}`;
  const rawBody = encryptBody(JSON.stringify(envelope), otherKey);
  const r = await call("POST", CARD_PATH(connector.id), { raw: rawBody, headers: signHeaders({ rawBody, encryptKey: otherKey }) });
  expectEqual(r.status, 401, `body ${r.text.slice(0, 160)}`);
  await assertVictimUntouched("wrong encrypt key");
});

// Since the Lark red-team hardening (R2 F7b) an unknown, paused or revoked
// connector answers exactly like a failed signature check — the same 401 and
// the same body — so a caller can't learn which connector ids exist.
await report.check("LK-S7", "unknown connector id -> same 401 as a bad signature (no oracle for which ids exist)", async () => {
  const r = await click({ openId: OPEN_B, token: victimToken, eventId: newEventId("noconn"), path: CARD_PATH(randomUUID()) });
  expectEqual(r.status, 401, `body ${r.text.slice(0, 160)}`);
  expectEqual(r.text.trim(), '{"error":"Invalid request"}', "body must match the bad-signature response");
});

// ── 6. identity + token guards (valid signature, so these reach the pipeline) ─
await report.check("LK-I1", "unlinked platform user with a real token -> 'unlinked', token not burned", async () => {
  const r = await click({ openId: `ou_stranger_${tag}`, token: victimToken, eventId: newEventId("unlinked") });
  expectToast(r, false, "unlinked user");
  expectEqual((await inboundRow(r.eventId))[0].outcome?.status, "unlinked", "ledger outcome");
  await assertVictimUntouched("unlinked user");
});

await report.check("LK-I2", "revoked link -> 'unlinked' (an unlinked person stops being able to approve)", async () => {
  const req = await seedRequest("change_request");
  const token = await seedActionToken(req, fx.b);
  await pgc.query("update external_identities set revoked_at = now() where connector_id = $1 and external_user_id = $2 and revoked_at is null", [connector.id, OPEN_B]);
  try {
    const r = await click({ openId: OPEN_B, token, eventId: newEventId("revoked") });
    expectToast(r, false, "revoked link");
    expectEqual((await inboundRow(r.eventId))[0].outcome?.status, "unlinked", "ledger outcome");
    expectEqual(await approvalStatus(req), PENDING.change_request, "request must be untouched");
  } finally {
    await pgc.query("update external_identities set revoked_at = null where connector_id = $1 and external_user_id = $2", [connector.id, OPEN_B]);
  }
});

await report.check("LK-I3", "expired action token -> 'expired', request untouched", async () => {
  const req = await seedRequest("change_request");
  const token = await seedActionToken(req, fx.b, { expiresInMs: -60_000 });
  const r = await click({ openId: OPEN_B, token, eventId: newEventId("expired") });
  expectToast(r, false, "expired token");
  expectEqual((await inboundRow(r.eventId))[0].outcome?.status, "expired", "ledger outcome");
  expectEqual(await approvalStatus(req), PENDING.change_request, "request must be untouched");
});

await report.check("LK-I4", "token that never existed -> refused, request untouched", async () => {
  const r = await click({ openId: OPEN_B, token: `${ACTION_TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`, eventId: newEventId("faketoken") });
  expectToast(r, false, "unknown token");
  await assertVictimUntouched("unknown token");
});

await report.check("LK-I5", "a viewer-role human cannot approve from chat, even with a valid token", async () => {
  const req = await seedRequest("change_request");
  const token = await seedActionToken(req, fx.b);
  await pgc.query("update profiles set role = 'viewer' where id = $1", [fx.b.id]);
  try {
    const r = await click({ openId: OPEN_B, token, eventId: newEventId("viewer") });
    expectToast(r, false, "demoted approver");
    expectEqual(await approvalStatus(req), PENDING.change_request, "request must be untouched");
  } finally {
    await pgc.query("update profiles set role = 'manager' where id = $1", [fx.b.id]);
  }
});

// ── 6b. tenant pin: a connector is bound to ONE platform tenant ───────────
// The first successful identity link pins the connector to that tenant; events from any other tenant are
// then refused. Identity rows are inserted directly here, so the pin is set by hand to emulate that first link.
await report.check("LK-T1", "tenant pin: a click from ANOTHER Lark tenant is refused while pinned (even for a linked user with a valid token); the pinned tenant still works; unpinning lifts it", async () => {
  const OTHER_TENANT = `tenant_other_${tag}`;
  const OPEN_C = `ou_probe_c_${tag}`;
  const userC = await makeUser(db, { workspaceId: fx.workspaceId, tag, label: "mgrC", role: "manager" });
  await must(
    db.from("external_identities").insert({ workspace_id: fx.workspaceId, connector_id: connector.id, provider: "lark", external_tenant: OTHER_TENANT, external_user_id: OPEN_C, display_name: "Probe C", profile_id: userC.id }),
    "identity in the other tenant",
  );
  const reqC = await seedRequest("change_request");
  const tokenC = await seedActionToken(reqC, { id: userC.id });
  const reqB = await seedRequest("change_request");
  const tokenB = await seedActionToken(reqB, fx.b);
  const tokenUnused = async (raw) => (await pgc.query("select used_at from action_tokens where token_hash = $1", [hashToken(raw)])).rows[0].used_at === null;

  await pgc.query("update integration_connectors set tenant_key = $2 where id = $1", [connector.id, TENANT]);
  try {
    const foreign = await click({ openId: OPEN_C, token: tokenC, eventId: newEventId("pin-foreign"), tenantKey: OTHER_TENANT });
    expect(!(foreign.status === 200 && toastOf(foreign)?.type === "success"), `a foreign-tenant click was approved while the connector is pinned: ${foreign.text.slice(0, 200)}`);
    expect(foreign.status !== 500, `foreign-tenant click produced a 500: ${foreign.text.slice(0, 160)}`);
    expectEqual(await approvalStatus(reqC), PENDING.change_request, "the foreign-tenant click must not decide anything");
    expect(await tokenUnused(tokenC), "a refused foreign-tenant click must not burn the token");
    expectEqual((await auditForTargets(reqC)).length, 0, "no audit row about the request");

    const home = await click({ openId: OPEN_B, token: tokenB, eventId: newEventId("pin-home") });
    expectToast(home, true, "pinned tenant");
    expectEqual(await approvalStatus(reqB), DECIDED.change_request, "the pinned tenant must still be able to approve");
  } finally {
    await pgc.query("update integration_connectors set tenant_key = null where id = $1", [connector.id]);
  }
  const unpinned = await click({ openId: OPEN_C, token: tokenC, eventId: newEventId("pin-lifted"), tenantKey: OTHER_TENANT });
  expectToast(unpinned, true, "the same click once the pin is cleared (proves the pin was the only barrier)");
});
// Whatever LK-T1 concluded, C must not stay an active approver: the LK-EM* checks expect cards for exactly B and admin.
await pgc.query("update external_identities set revoked_at = now() where connector_id = $1 and external_user_id = $2 and revoked_at is null", [connector.id, `ou_probe_c_${tag}`]);
await pgc.query("update integration_connectors set tenant_key = null where id = $1", [connector.id]);

// ── 7. kill switch ───────────────────────────────────────────────────────
await report.check("LK-K1", "paused connector refuses clicks in both directions of the pipeline; resumes when re-activated", async () => {
  const req = await seedRequest("change_request");
  const token = await seedActionToken(req, fx.b);
  await pgc.query("update integration_connectors set status = 'paused' where id = $1", [connector.id]);
  try {
    const r = await click({ openId: OPEN_B, token, eventId: newEventId("paused") });
    expect(r.status !== 500, `paused connector produced a 500: ${r.text.slice(0, 160)}`);
    expect(!(r.status === 200 && toastOf(r)?.type === "success"), "a paused connector must never approve");
    expectEqual(await approvalStatus(req), PENDING.change_request, "request must be untouched while paused");
  } finally {
    await pgc.query("update integration_connectors set status = 'active' where id = $1", [connector.id]);
  }
  const after = await click({ openId: OPEN_B, token, eventId: newEventId("resumed") });
  expectToast(after, true, "click after re-activation");
});

// ── 8. self-host relay transport: same pipeline, different front door ─────
await report.check("LK-R1", "relay (long_connection): HMAC-signed card click approves; bad HMAC 401; webhook-mode connector 403", async () => {
  const req = await seedRequest("change_request");
  const token = await seedActionToken(req, fx.b);
  const envelope = cardActionEnvelope({ eventId: newEventId("relay"), verificationToken: SECRETS.verificationToken, appId: APP_ID, tenantKey: TENANT, openId: OPEN_B, actionToken: token, action: "approve" });
  const rawBody = JSON.stringify({ type: "card", payload: envelope });

  // Webhook-mode connector: the relay front door must be closed (after authenticating the caller).
  const closed = await call("POST", RELAY_PATH(connector.id), { raw: rawBody, headers: relayHeaders(connector.relaySecret, rawBody) });
  expectEqual(closed.status, 403, `relay on a webhook-mode connector (body ${closed.text.slice(0, 160)})`);

  await pgc.query(`update integration_connectors set config = jsonb_set(config, '{mode}', '"long_connection"') where id = $1`, [connector.id]);
  try {
    const badHeaders = relayHeaders(`${connector.relaySecret}x`, rawBody);
    const bad = await call("POST", RELAY_PATH(connector.id), { raw: rawBody, headers: badHeaders });
    expectEqual(bad.status, 401, `relay with the wrong secret (body ${bad.text.slice(0, 160)})`);
    expectEqual(await approvalStatus(req), PENDING.change_request, "bad HMAC must not decide anything");

    const good = await call("POST", RELAY_PATH(connector.id), { raw: rawBody, headers: relayHeaders(connector.relaySecret, rawBody) });
    expectToast(good, true, "relayed approve");
    expectEqual(await approvalStatus(req), DECIDED.change_request, "relayed click must approve");
    const rows = await auditByEvent(envelope.header.event_id);
    expect(rows.length >= 1 && rows.every((r) => r.channel === "lark" && r.via_connector_id === connector.id), `relay audit provenance: ${JSON.stringify(rows)}`);

    const stale = await call("POST", RELAY_PATH(connector.id), { raw: rawBody, headers: relayHeaders(connector.relaySecret, rawBody, String(Math.floor(Date.now() / 1000) - 900)) });
    expectEqual(stale.status, 401, "stale relay timestamp");
  } finally {
    await pgc.query(`update integration_connectors set config = jsonb_set(config, '{mode}', '"webhook"') where id = $1`, [connector.id]);
  }
});

// ── 8b. the REAL emit path, against fake-lark (no real Lark host) ──────────
// Requests are raised through the real API, so emitApprovalRequested queues
// cards, the delivery drain sends them with the official SDK to fake-lark
// (NOPM_LARK_API_BASE_OVERRIDE), and the card's action token is read back from
// the captured card JSON — the only place a raw token ever exists.
const waitFor = async (fn, { timeoutMs = 10_000, intervalMs = 150 } = {}) => {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
};
const fakeGet = async (p) => (await (await fetch(`${fakeUrl}${p}`)).json()).data;
const cardText = (card) => JSON.stringify(card);
/** The raw action token a card's Approve button carries (card JSON 2.0: behaviors[].value.t). */
function approveTokenOf(node) {
  if (!node || typeof node !== "object") return null;
  for (const b of Array.isArray(node.behaviors) ? node.behaviors : []) {
    if (b?.value?.a === "approve" && typeof b.value.t === "string") return b.value.t;
  }
  for (const child of Object.values(node)) {
    const found = approveTokenOf(child);
    if (found) return found;
  }
  return null;
}
const hasInteractive = (card) => /"behaviors"|"tag":"button"|"tag":"form"|"tag":"input"/.test(cardText(card));

let fakeReady = false;
await report.check("LK-EM0", `the app talks to fake-lark (${fakeUrl}): connector test reaches the fake bot endpoint`, async () => {
  await fetch(`${fakeUrl}/__reset`, { method: "POST" });
  const r = await call("POST", `/api/integrations/connectors/${connector.id}/test`, { cookie: adminCookie });
  expectEqual(r.status, 200, `connector test (body ${r.text.slice(0, 200)})`);
  const calls = await fakeGet("/__calls");
  expect(
    r.json?.data?.ok === true && r.json.data.bot_name === "Fake NoPM Bot" && calls.token >= 1 && calls.botInfo >= 1,
    `the app is NOT using fake-lark. Start it with NOPM_LARK_API_BASE_OVERRIDE=${fakeUrl} (response: ${r.text.slice(0, 160)}; fake saw ${JSON.stringify(calls)})`,
  );
  fakeReady = true;
});

/** Raise a governed request through the REAL API as A. Returns what the checks need. */
async function raiseViaApi(kind, via, label) {
  const needle = `emit-${tag}-${label}`;
  if (kind === "change_request") {
    const caller = via === "pat" ? { token: fx.tokens.a.raw } : { cookie: await cookieA() };
    const r = await call("POST", `/api/projects/${fx.project.id}/change-requests`, { ...caller, body: { title: `probe ${needle}`, description: "probe" } });
    expectEqual(r.status, 201, `raise change request (body ${r.text.slice(0, 200)})`);
    return { kind, id: r.json.data.id, targetIds: [r.json.data.id], needle };
  }
  const task = await must(
    db.from("tasks").insert({ workspace_id: fx.workspaceId, project_id: fx.project.id, name: `probe ${needle}` }).select("id").single(),
    "task",
  );
  const caller = via === "pat" ? { token: fx.tokens.a.raw } : { cookie: await cookieA() };
  const r = await call("DELETE", `/api/tasks/${task.id}`, { ...caller, body: { reason: `probe ${needle}` } });
  expectEqual(r.status, 202, `raise task deletion (body ${r.text.slice(0, 200)})`);
  return { kind, id: r.json.data.id, taskId: task.id, targetIds: [r.json.data.id, task.id], needle };
}
let cachedCookieA = null;
const cookieA = async () => (cachedCookieA ??= await sessionCookie(fx.a));

/** Wait for the two approval cards (B and admin), then make sure nobody else got one. */
async function collectCards(req) {
  const both = await waitFor(async () => {
    const sent = await fakeGet("/__sent");
    const mine = sent.filter((m) => cardText(m.card).includes(req.needle));
    return new Set(mine.map((m) => m.receive_id)).size >= 2 ? mine : null;
  });
  expect(both, `fewer than two cards reached fake-lark for ${req.needle} within 10 s (fake saw ${JSON.stringify(await fakeGet("/__calls"))})`);
  await new Promise((r) => setTimeout(r, 800)); // a stray third card would land by now
  const sent = (await fakeGet("/__sent")).filter((m) => cardText(m.card).includes(req.needle));
  const byReceiver = new Map(sent.map((m) => [m.receive_id, m]));
  return { sent, byReceiver, cardB: byReceiver.get(OPEN_B), cardAdmin: byReceiver.get(OPEN_ADMIN), cardA: byReceiver.get(OPEN_A) };
}

const emitted = {}; // kind -> { req, cards }
for (const kind of ["change_request", "task_deletion"]) {
  const k = kind === "change_request" ? "CR" : "TD";

  await report.check(`LK-EM1-${k}`, `[${kind}] raised via the real API: B and admin each get ONE approval card on fake-lark; requester A gets none`, async () => {
    expect(fakeReady, "blocked by LK-EM0");
    const req = await raiseViaApi(kind, kind === "task_deletion" ? "pat" : "session", `${k}-main`);
    const cards = await collectCards(req);
    emitted[kind] = { req, cards };
    expectEqual(cards.sent.length, 2, `cards for this request: ${JSON.stringify(cards.sent.map((m) => m.receive_id))}`);
    expect(cards.cardB && cards.cardAdmin, "B and admin must each have a card");
    expect(!cards.cardA, "the requester must NOT receive a card for their own request (even when raised by their agent token)");
    for (const m of cards.sent) {
      expectEqual(m.receive_id_type, "open_id", "cards are DMs to the verified open_id");
      const text = cardText(m.card);
      expect(/approval needed/i.test(m.card.header?.title?.content ?? ""), `header: ${m.card.header?.title?.content}`);
      expect(text.includes('"reason"') && text.includes('"approve"') && text.includes('"reject"'), "card needs Approve, Reject and a reason input");
      for (const [name, value] of Object.entries(SECRETS)) expect(!text.includes(value), `card leaked ${name}`);
      expect(!text.includes(connector.relaySecret) && !text.includes(fx.tokens.a.raw) && !text.includes(fx.tokens.b.raw), "card leaked a credential");
    }
    const tokenB = approveTokenOf(cards.cardB.card);
    const tokenAdmin = approveTokenOf(cards.cardAdmin.card);
    expect(/^npa_[A-Za-z0-9_-]{20,}$/.test(tokenB ?? "") && /^npa_[A-Za-z0-9_-]{20,}$/.test(tokenAdmin ?? ""), `action tokens: ${tokenB} / ${tokenAdmin}`);
    expect(tokenB !== tokenAdmin, "each recipient must get a distinct action token");
    cards.tokenB = tokenB;
    cards.tokenAdmin = tokenAdmin;
    expectEqual((await fakeGet("/__violations")).length, 0, `fake-lark found card problems: ${JSON.stringify(await fakeGet("/__violations"))}`);
    expectEqual((await fakeGet("/__unsupported")).length, 0, "the app called an endpoint fake-lark does not implement");
  });

  await report.check(`LK-EM2-${k}`, `[${kind}] bookkeeping: 2 deliveries 'sent' with the fake's message ids; tokens stored hashed, unused, recipient-bound; payload holds no token`, async () => {
    const e = emitted[kind];
    expect(e?.cards?.tokenB, "no emitted cards (see LK-EM1)");
    const rows = (
      await pgc.query(
        `select id, kind, status, attempts, recipient_profile_id, external_target, external_message_id, payload::text as payload
           from integration_deliveries where workspace_id = $1 and approval_id = $2 and kind = 'approval_card' order by created_at`,
        [fx.workspaceId, e.req.id],
      )
    ).rows;
    expectEqual(rows.length, 2, "approval_card deliveries");
    expectEqual(rows.map((r) => r.recipient_profile_id).sort(), [fx.b.id, fx.admin.id].sort(), "recipients are B and admin only");
    expect(rows.every((r) => r.status === "sent" && r.attempts === 1), `statuses/attempts: ${JSON.stringify(rows.map((r) => [r.status, r.attempts]))}`);
    const fakeIds = new Set(e.cards.sent.map((m) => m.message_id));
    expect(rows.every((r) => fakeIds.has(r.external_message_id)), "external_message_id must be the id fake-lark returned");
    expect(rows.every((r) => !r.payload.includes("npa_") && !r.payload.includes(e.cards.tokenB) && !r.payload.includes(e.cards.tokenAdmin)), "delivery payload must never contain an action token");
    for (const [who, raw, profile] of [["B", e.cards.tokenB, fx.b.id], ["admin", e.cards.tokenAdmin, fx.admin.id]]) {
      const t = (await pgc.query("select recipient_profile_id, approval_kind, approval_id, used_at, expires_at from action_tokens where token_hash = $1", [hashToken(raw)])).rows;
      expectEqual(t.length, 1, `${who}: the stored token row for the captured card token (sha256 hex of the raw token)`);
      expectEqual([t[0].recipient_profile_id, t[0].approval_kind, t[0].approval_id, t[0].used_at], [profile, kind, e.req.id, null], `${who}: token binding`);
      const ttlDays = (new Date(t[0].expires_at).getTime() - Date.now()) / 86_400_000;
      expect(ttlDays > 6.5 && ttlDays <= 7.01, `${who}: TTL should be ~7 days, got ${ttlDays.toFixed(2)}`);
    }
    const noneForA = await pgc.query("select count(*)::int as n from integration_deliveries where workspace_id = $1 and approval_id = $2 and recipient_profile_id = $3", [fx.workspaceId, e.req.id, fx.a.id]);
    expectEqual(noneForA.rows[0].n, 0, "no delivery for the requester");
  });

  await report.check(`LK-EM3-${k}`, `[${kind}] B clicks Approve on the CAPTURED card token -> committed; every decision audit row is channel 'lark'`, async () => {
    const e = emitted[kind];
    expect(e?.cards?.tokenB, "no emitted cards (see LK-EM1)");
    const eventId = newEventId(`${k}-emit-approve`);
    const r = await click({ openId: OPEN_B, token: e.cards.tokenB, eventId });
    expectToast(r, true, "approve captured card");
    e.eventId = eventId;
    expectEqual(await approvalStatus(e.req), DECIDED[kind], "approval state");
    // Rows written when the request was RAISED (through the API, channel ui/api) are not part of the decision.
    const all = (await auditForTargets(e.req)).filter((x) => !/\.(create|delete_requested)$/.test(x.action));
    expect(all.length >= 1 && all.every((x) => x.channel === "lark"), `every decision audit row must be channel 'lark': ${JSON.stringify(all)}`);
    // The connector provenance on those rows is asserted separately in LK-EM6.
    if (kind === "change_request") expectEqual(all.filter((x) => x.action === "change_request.decide").length, 1, "exactly one decide audit row");
    return `${all.length} audit row(s): ${all.map((x) => x.action).join(", ")}`;
  });

  await report.check(`LK-EM4-${k}`, `[${kind}] the OTHER card (admin's) is patched in place to the decided state (no buttons, via Lark); each card patched once`, async () => {
    const e = emitted[kind];
    expect(e?.eventId, "no decision happened (see LK-EM3)");
    const adminId = e.cards.cardAdmin.message_id;
    const bId = e.cards.cardB.message_id;
    const patches = await waitFor(async () => {
      const all = await fakeGet("/__patched");
      return all.some((p) => p.message_id === adminId) ? all : null;
    });
    expect(patches, "fake-lark never received a patch for the admin's card within 10 s");
    await new Promise((r) => setTimeout(r, 600)); // let a (wrong) second patch show up
    const all = await fakeGet("/__patched");
    const forAdmin = all.filter((p) => p.message_id === adminId);
    const forB = all.filter((p) => p.message_id === bId);
    expectEqual(forAdmin.length, 1, "the admin's card must be patched exactly once");
    expect(forB.length <= 1, `B's own card patched ${forB.length} times`);
    const patched = forAdmin[0].card;
    const text = cardText(patched);
    expect(!hasInteractive(patched), "a decided card must have no buttons, form or input");
    expect(/approved|committed|deleted/i.test(patched.header?.title?.content ?? ""), `decided header: ${patched.header?.title?.content}`);
    expect(/Status:/.test(text) && /via Lark/.test(text), `decided card must say who/how: ${text.slice(0, 300)}`);
    expect(!text.includes(e.cards.tokenAdmin) && !text.includes(e.cards.tokenB), "a patched card must not carry action tokens");
    const upd = await pgc.query(
      "select kind, status, parent_delivery_id from integration_deliveries where workspace_id = $1 and approval_id = $2 and kind = 'decision_update'",
      [fx.workspaceId, e.req.id],
    );
    expect(upd.rowCount >= 1 && upd.rows.every((x) => x.status === "sent"), `decision_update deliveries: ${JSON.stringify(upd.rows)}`);
    const tokens = await pgc.query("select count(*)::int as n from action_tokens where workspace_id = $1 and approval_id = $2 and used_at is null", [fx.workspaceId, e.req.id]);
    expectEqual(tokens.rows[0].n, 0, "every open token of the decided request must be dead");
    return `patched cards: admin x${forAdmin.length}, B x${forB.length}`;
  });

  await report.check(`LK-EM5-${k}`, `[${kind}] admin clicks their now-stale card -> already decided, no second mutation`, async () => {
    const e = emitted[kind];
    expect(e?.eventId, "no decision happened (see LK-EM3)");
    const before = (await auditForTargets(e.req)).length;
    const r = await click({ openId: OPEN_ADMIN, token: e.cards.tokenAdmin, eventId: newEventId(`${k}-emit-late`) });
    expectToast(r, false, "stale admin click");
    expectEqual((await inboundRow(r.eventId))[0].outcome?.status, "already_decided", "ledger outcome");
    expectEqual((await auditForTargets(e.req)).length, before, "no extra audit rows");
  });

  await report.check(`LK-EM6-${k}`, `[${kind}] provenance on EVERY audit row of the Lark decision (external_event_id, via_connector_id, external_actor_ref)`, async () => {
    const e = emitted[kind];
    expect(e?.eventId, "no decision happened (see LK-EM3)");
    const rows = (
      await pgc.query(
        `select action, actor_type, actor_id, via_connector_id, external_event_id, external_actor_ref from audit_log where workspace_id = $1 and target_id = any($2::uuid[]) and channel = 'lark'`,
        [fx.workspaceId, e.req.targetIds],
      )
    ).rows;
    expect(rows.length >= 1, "no lark-channel audit rows");
    const missing = rows.filter(
      (x) =>
        x.external_event_id !== e.eventId ||
        x.via_connector_id !== connector.id ||
        x.external_actor_ref !== `lark:${TENANT}:${OPEN_B}` ||
        x.actor_type !== "user" ||
        x.actor_id !== fx.b.id,
    );
    expect(missing.length === 0, `audit rows without full connector provenance (the linked human B, this event, this connector): ${JSON.stringify(missing)}`);
    return `${rows.length} lark audit row(s)`;
  });
}

await report.check("LK-EM7", "decided in the CONSOLE (admin session): both sent cards are patched once ('via the NoPM web app'), tokens die, a later Lark click is refused", async () => {
  expect(fakeReady, "blocked by LK-EM0");
  const req = await raiseViaApi("change_request", "session", "CR-console");
  const cards = await collectCards(req);
  const tokenB = approveTokenOf(cards.cardB.card);
  const decided = await call("POST", `/api/change-requests/${req.id}/decision`, { cookie: adminCookie, body: { decision: "approve", rationale: "probe: decided in the console" } });
  expectEqual(decided.status, 200, `console decision (body ${decided.text.slice(0, 200)})`);
  const ids = [cards.cardB.message_id, cards.cardAdmin.message_id];
  const done = await waitFor(async () => {
    const all = await fakeGet("/__patched");
    return ids.every((id) => all.some((p) => p.message_id === id)) ? all : null;
  });
  expect(done, "both cards should be patched when the request is decided from another channel");
  await new Promise((r) => setTimeout(r, 600));
  const all = await fakeGet("/__patched");
  for (const id of ids) expectEqual(all.filter((p) => p.message_id === id).length, 1, `card ${id} must be patched exactly once`);
  for (const p of all.filter((x) => ids.includes(x.message_id))) {
    expect(!hasInteractive(p.card) && /via the NoPM web app/.test(cardText(p.card)), `patched card should show the console channel: ${cardText(p.card).slice(0, 240)}`);
  }
  const before = (await auditForTargets(req)).length;
  const r = await click({ openId: OPEN_B, token: tokenB, eventId: newEventId("emit-console-late") });
  expectToast(r, false, "late Lark click after a console decision");
  expectEqual((await inboundRow(r.eventId))[0].outcome?.status, "already_decided", "ledger outcome");
  expectEqual((await auditForTargets(req)).length, before, "no second decision audit row");
});

await report.check("LK-EM8", "Reject with a reason from the captured card -> request rejected; both cards patched to 'rejected'", async () => {
  expect(fakeReady, "blocked by LK-EM0");
  const req = await raiseViaApi("change_request", "session", "CR-reject");
  const cards = await collectCards(req);
  const token = approveTokenOf(cards.cardB.card); // the same single-use token backs Reject; the verb travels separately
  const r = await click({ openId: OPEN_B, token, action: "reject", eventId: newEventId("emit-reject"), reason: "probe: not now" });
  expectToast(r, true, "reject captured card");
  expectEqual(await approvalStatus(req), "rejected", "approval state");
  const ids = [cards.cardB.message_id, cards.cardAdmin.message_id];
  const done = await waitFor(async () => {
    const all = await fakeGet("/__patched");
    return ids.every((id) => all.some((p) => p.message_id === id)) ? all : null;
  });
  expect(done, "both cards should be patched after a Lark rejection");
  const adminPatch = done.find((p) => p.message_id === cards.cardAdmin.message_id);
  expect(/rejected/i.test(adminPatch.card.header?.title?.content ?? "") && !hasInteractive(adminPatch.card), `rejected card: ${cardText(adminPatch.card).slice(0, 240)}`);
});

await report.check("LK-EM9", "fake-lark saw no malformed card and no unexpected endpoint during the whole probe", async () => {
  expect(fakeReady, "blocked by LK-EM0");
  expectEqual(await fakeGet("/__violations"), [], "card structure violations");
  expectEqual(await fakeGet("/__unsupported"), [], "unsupported endpoint calls");
  const calls = await fakeGet("/__calls");
  expect(calls.send >= 8 && calls.patch >= 6, `expected at least 8 sends and 6 patches over the EM checks, got ${JSON.stringify(calls)}`);
  return JSON.stringify(calls);
});

// ── 9. no real Lark call was ever made ────────────────────────────────────
await report.check("LK-N0", "every outbound send went to fake-lark (or nothing was sent); no real Lark host was reached; no delivery failed", async () => {
  await new Promise((r) => setTimeout(r, 1500)); // let any after() hook settle
  const sent = (await pgc.query("select kind, external_message_id from integration_deliveries where workspace_id = $1 and status = 'sent'", [fx.workspaceId])).rows;
  const failed = (await pgc.query("select kind, status, last_error from integration_deliveries where workspace_id = $1 and status in ('retry', 'dead')", [fx.workspaceId])).rows;
  expectEqual(failed, [], "a delivery failed (retry/dead) — the app could not reach fake-lark, or fake-lark refused the call");
  if (!fakeReady) {
    expectEqual(sent.length, 0, "a delivery reached 'sent' although fake-lark was not in use — something talked to a Lark host");
    return "fake-lark was not in use (LK-EM0 failed); no delivery was sent";
  }
  const known = new Set((await fakeGet("/__sent")).map((m) => m.message_id));
  const foreign = sent.filter((x) => !known.has(x.external_message_id));
  expectEqual(foreign, [], "'sent' deliveries whose message id fake-lark never issued — they went somewhere else");
  return `${sent.length} delivery row(s) sent, all to fake-lark`;
});

const allPassed = report.finish();
await fakeServer?.close();
await close();
process.exit(allPassed ? 0 : 1);
