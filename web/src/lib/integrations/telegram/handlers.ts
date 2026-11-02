/**
 * Telegram inbound handling - transport-agnostic (ADR 0020).
 *
 * Takes an ALREADY-AUTHENTICATED update (the webhook route checked the secret
 * token) and the connector it belongs to. Pipeline:
 *
 *   private chat? -> dedupe (update_id) -> connector on? -> identity -> command
 *   -> open pending step -> preview -> confirm (compare-and-swap) -> REST API
 *   with a per-action scoped token.
 *
 * Governance contract:
 *   - This module never writes the database except through `PendingStore` (chat
 *     state, which is not a governed record). Every NoPM write is ONE call to a
 *     documented REST route made with a short-lived token for the linked human,
 *     so it produces exactly one audit row, the route's own, on channel
 *     `telegram`.
 *   - Deletes are requests only (maker-checker). The only decision a chat can
 *     make is an Approve or Reject tap in /4, and the requester is refused first.
 *   - Everything reaches the outside world through `TelegramDeps`, so the file
 *     is unit-testable with no Supabase and no network. ./wiring.ts binds it.
 *   - It never throws to the platform and never logs message text, codes or
 *     tokens: ids and reasons only.
 */

import type { ConsumeLinkInput, LinkedProfile, LinkOutcome } from "@/lib/integrations/identity";
import { ALREADY_LINKED_MESSAGE } from "@/lib/integrations/identity";
import type { ConnectorRow } from "@/lib/integrations/types";
import { defaultAskAssistant, type AskAssistant } from "./assistant-seam";
import { canUse, parseInput, toRole, type MenuN, type Role } from "./commands";
import {
  COPY,
  approvalCard,
  choice,
  esc,
  helpCard,
  linkPrompt,
  note,
  preview,
  projectCards,
  taskList,
  type Rendered,
} from "./render";

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

export type LogLevel = "info" | "warn" | "error";

export type PendingKind = "seen" | "ask" | "preview" | "pick" | "approval";
export type PendingStatus = "open" | "claimed" | "done" | "cancelled" | "failed";

export type PendingRow = {
  id: string;
  workspace_id: string;
  connector_id: string;
  chat_id: string;
  kind: PendingKind;
  payload: Record<string, unknown>;
  version: number;
  status: PendingStatus;
  profile_id: string | null;
  expires_at: string;
};

/** Durable chat state. `advance` is a compare-and-swap on (version, status = open). */
export type PendingStore = {
  /** True the first time a key is seen for the connector, false for a redelivery. */
  dedupe(connector: ConnectorRow, chatId: string, key: string): Promise<boolean>;
  create(connector: ConnectorRow, chatId: string, profileId: string, kind: PendingKind, payload: Record<string, unknown>, ttlMs: number): Promise<PendingRow>;
  get(connectorId: string, id: string): Promise<PendingRow | null>;
  /** The newest open ask / preview / pick row of a chat for this person. */
  latestOpen(connectorId: string, chatId: string, profileId: string): Promise<PendingRow | null>;
  /** Swap the row to the patch if nobody else has since. Null when the swap was lost. */
  advance(
    row: PendingRow,
    patch: { kind?: PendingKind; payload?: Record<string, unknown>; status?: PendingStatus; ttlMs?: number },
  ): Promise<PendingRow | null>;
  settle(id: string, status: "done" | "failed" | "cancelled"): Promise<void>;
  cancelOpen(connectorId: string, chatId: string, profileId?: string): Promise<void>;
};

export type ApiRequest = {
  connector: ConnectorRow;
  profile: LinkedProfile;
  scopes: string[];
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
};
export type ApiResult = { status: number; body: unknown };

export type TelegramDeps = {
  now(): Date;
  log(level: LogLevel, message: string, meta?: Record<string, unknown>): void;
  store: PendingStore;
  lookupIdentity(connector: ConnectorRow, tenant: string, userId: string): Promise<LinkedProfile | null>;
  consumeLinkCode(input: ConsumeLinkInput): Promise<LinkOutcome>;
  /** The per-action REST call (mint token, call route, revoke token). Never throws; a failure is a status. */
  api(req: ApiRequest): Promise<ApiResult>;
  /** False when the module that owns this scope is switched off (NOPM_MODULES). */
  scopeEnabled(scope: string): boolean;
  /** False when the integrations module is switched off. */
  integrationsEnabled(): boolean;
  /** Optional per-user budget; false = over budget. */
  rateAllowed?(key: string): Promise<boolean>;
  send(chatId: string, msg: Rendered): Promise<{ messageId: number | null }>;
  edit(chatId: string, messageId: number, msg: Rendered): Promise<void>;
  answer(callbackQueryId: string, text?: string): Promise<void>;
  /** Register the per-chat command scope for a role (called after linking). */
  setChatMenu(chatId: string, role: Role): Promise<void>;
  askAssistant?: AskAssistant;
};

export type TelegramContext = {
  connector: ConnectorRow;
  /** Keep work running after the HTTP response (Next `after`). Absent: awaited inline (tests). */
  background?: (work: Promise<unknown>) => void;
};

export type TelegramHttpResult = { status: number; body: unknown };

export const ASK_TTL_MS = 2 * 60 * 1000;
export const STEP_TTL_MS = 10 * 60 * 1000;
export const MAX_TEXT = 255;
const PICK_LIMIT = 8;
const STATUS_ACTIONS = [
  { value: "backlog", label: "Backlog" },
  { value: "unstarted", label: "Not started" },
  { value: "started", label: "In progress" },
  { value: "completed", label: "Done" },
  { value: "canceled", label: "Canceled" },
] as const;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const errMsg = (e: unknown) => (e instanceof Error ? e.message.slice(0, 200) : "unknown error");

function dataList(body: unknown): Rec[] {
  const d = isRec(body) ? body.data : null;
  return Array.isArray(d) ? d.filter(isRec) : [];
}

function apiMessage(body: unknown): string {
  return isRec(body) && typeof body.error === "string" ? body.error.slice(0, 200) : "";
}

type Ctx = { ctx: TelegramContext; deps: TelegramDeps };

/** Refusal text for a failed REST call. */
function refusal(res: ApiResult): string {
  switch (res.status) {
    case 401:
      return COPY.tokenFailed;
    case 403:
      return apiMessage(res.body) || COPY.noAccess;
    case 404:
      return "That item no longer exists, or you cannot access it.";
    case 422:
      return apiMessage(res.body) || "NoPM would not accept that.";
    case 429:
      return COPY.slowDown;
    default:
      return COPY.tryAgain;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Dispatch one authenticated update. Always answers 200 at once; the work runs
 * in the background when the host provides one.
 */
export async function handleTelegramUpdate(ctx: TelegramContext, update: unknown, deps: TelegramDeps): Promise<TelegramHttpResult> {
  const work = processUpdate({ ctx, deps }, update).catch((err) => {
    deps.log("error", "telegram update failed", { connectorId: ctx.connector.id, error: errMsg(err) });
  });
  if (ctx.background) ctx.background(work);
  else await work;
  return { status: 200, body: {} };
}

async function processUpdate(c: Ctx, update: unknown): Promise<void> {
  if (!isRec(update) || typeof update.update_id !== "number") return;
  const updateId = update.update_id;
  if (isRec(update.callback_query)) return processCallback(c, updateId, update.callback_query);
  if (isRec(update.message)) return processMessage(c, updateId, update.message);
}

type Who = { chatId: string; userId: string; username: string | null };

function whoOf(from: unknown, chat: unknown): Who | null {
  if (!isRec(from) || !isRec(chat)) return null;
  if (from.is_bot === true) return null; // no bot loops
  if (chat.type !== "private") return null; // private chats only: group chatter gets no reply
  if (typeof from.id !== "number" || typeof chat.id !== "number") return null;
  // The @username (letters, digits, underscore) is shown back to the member on their own settings card; nothing else is kept.
  const username = typeof from.username === "string" && /^[A-Za-z0-9_]{3,32}$/.test(from.username) ? `@${from.username}` : null;
  return { chatId: String(chat.id), userId: String(from.id), username };
}

/** Connector/module gate shared by messages and taps. Returns a refusal text, or null when open. */
function gate(c: Ctx): string | null {
  if (c.ctx.connector.status !== "active") return COPY.turnedOff;
  if (!c.deps.integrationsEnabled()) return COPY.moduleOff;
  return null;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

async function processMessage(c: Ctx, updateId: number, message: Rec): Promise<void> {
  const { deps, ctx } = c;
  const who = whoOf(message.from, message.chat);
  if (!who) return;
  if (!(await deps.store.dedupe(ctx.connector, who.chatId, `u:${updateId}`))) return;

  const closed = gate(c);
  if (closed) {
    await deps.send(who.chatId, note(closed));
    return;
  }
  if (deps.rateAllowed && !(await deps.rateAllowed(`telegram:${ctx.connector.id}:${who.userId}`))) {
    await deps.send(who.chatId, note(COPY.slowDown));
    return;
  }

  const input = parseInput(typeof message.text === "string" ? message.text : "");

  // Linking needs no identity.
  if (input.kind === "start" || input.kind === "link") {
    const code = input.code;
    if (!code) {
      await deps.send(who.chatId, linkPrompt());
      return;
    }
    return doLink(c, who, code, updateId);
  }

  const profile = await deps.lookupIdentity(ctx.connector, ctx.connector.id, who.userId);
  if (!profile) {
    await deps.send(who.chatId, linkPrompt());
    return;
  }
  const role = toRole(profile.role);

  switch (input.kind) {
    case "help":
      await deps.store.cancelOpen(ctx.connector.id, who.chatId, profile.profileId);
      await deps.send(who.chatId, helpCard(role, input.all));
      return;
    case "cancel": {
      const open = await deps.store.latestOpen(ctx.connector.id, who.chatId, profile.profileId);
      await deps.store.cancelOpen(ctx.connector.id, who.chatId, profile.profileId);
      await deps.send(who.chatId, note(open ? COPY.cancelled : COPY.nothingToCancel));
      return;
    }
    case "menu":
      // Any new command ends a step that is waiting for an answer.
      await deps.store.cancelOpen(ctx.connector.id, who.chatId, profile.profileId);
      return runMenu(c, who, profile, role, input.n, input.arg);
    case "text":
      return continueOrAsk(c, who, profile, role, input.text);
  }
}

async function doLink(c: Ctx, who: Who, code: string, updateId: number): Promise<void> {
  const { deps, ctx } = c;
  const res = await deps.consumeLinkCode({
    connector: ctx.connector,
    rawCode: code,
    externalTenant: ctx.connector.id,
    externalUserId: who.userId,
    displayName: who.username,
    externalEventId: `tg:${updateId}`,
  });
  switch (res.status) {
    case "linked": {
      if (res.alreadyLinked) {
        await deps.send(who.chatId, note(COPY.alreadyLinked));
        return;
      }
      await deps.send(who.chatId, { text: `Linked. You are now connected as <b>${esc(res.profileLabel, 80)}</b>. Send /0 for the menu.` });
      const profile = await deps.lookupIdentity(ctx.connector, ctx.connector.id, who.userId);
      if (profile) await deps.setChatMenu(who.chatId, toRole(profile.role)).catch((e) => deps.log("warn", "set chat menu failed", { connectorId: ctx.connector.id, error: errMsg(e) }));
      return;
    }
    case "invalid_code":
      return void (await deps.send(who.chatId, note("That code is not valid. Create a new one in NoPM (Integrations, then Link my account).")));
    case "already_used":
      return void (await deps.send(who.chatId, note("That code was already used. Create a new one in NoPM.")));
    case "expired":
      return void (await deps.send(who.chatId, note("That code has expired (codes last 10 minutes). Create a new one in NoPM.")));
    case "rate_limited":
      return void (await deps.send(who.chatId, note("Too many wrong tries. Linking is paused for this Telegram account for a few minutes.")));
    case "conflict":
      return void (await deps.send(
        who.chatId,
        note(res.message === ALREADY_LINKED_MESSAGE ? "This NoPM account is already linked to another Telegram account. Unlink it in NoPM (Integrations) first, then send a new code." : res.message),
      ));
    case "forbidden":
      return void (await deps.send(who.chatId, note(res.message)));
    case "paused":
      return void (await deps.send(who.chatId, note(COPY.turnedOff)));
    case "error":
      deps.log("warn", "identity link failed", { connectorId: ctx.connector.id });
      return void (await deps.send(who.chatId, note(COPY.tryAgain)));
  }
}

// ---------------------------------------------------------------------------
// Menu commands
// ---------------------------------------------------------------------------

async function runMenu(c: Ctx, who: Who, profile: LinkedProfile, role: Role, n: MenuN, arg: string): Promise<void> {
  const { deps } = c;
  if (!canUse(role, n)) {
    await deps.send(who.chatId, note(n === "4" ? "Nothing to decide: approval requests go to workspace admins and managers." : COPY.noAccess));
    return;
  }
  switch (n) {
    case "1":
      return myWork(c, who, profile);
    case "2":
      return startAdd(c, who, profile);
    case "3":
      return startUpdate(c, who, profile, arg);
    case "4":
      return showApprovals(c, who, profile);
    case "5":
      return projectStatus(c, who, profile, arg);
    case "6":
      return digest(c, who, profile, role, arg);
  }
}

async function read(c: Ctx, profile: LinkedProfile, scope: string, path: string): Promise<ApiResult | { disabled: true }> {
  if (!c.deps.scopeEnabled(scope)) return { disabled: true };
  return c.deps.api({ connector: c.ctx.connector, profile, scopes: [scope], method: "GET", path });
}

async function readOrExplain(c: Ctx, who: Who, profile: LinkedProfile, scope: string, path: string): Promise<Rec[] | null> {
  const res = await read(c, profile, scope, path);
  if ("disabled" in res) {
    await c.deps.send(who.chatId, note(COPY.moduleOff));
    return null;
  }
  if (res.status < 200 || res.status >= 300) {
    await c.deps.send(who.chatId, note(refusal(res)));
    return null;
  }
  return dataList(res.body);
}

async function myWork(c: Ctx, who: Who, profile: LinkedProfile): Promise<void> {
  const rows = await readOrExplain(c, who, profile, "task:read", `/api/tasks?assignee_id=${encodeURIComponent(profile.profileId)}&sort=due_date:asc&limit=30`);
  if (!rows) return;
  const today = c.deps.now().toISOString().slice(0, 10);
  const open = rows
    .filter((t) => t.status_type !== "completed" && t.status_type !== "canceled")
    .slice(0, PICK_LIMIT)
    .map((t) => ({ name: str(t.name), due_date: str(t.due_date) || null, overdue: !!str(t.due_date) && str(t.due_date).slice(0, 10) < today }));
  await c.deps.send(who.chatId, taskList(open));
}

async function projectStatus(c: Ctx, who: Who, profile: LinkedProfile, arg: string): Promise<void> {
  const rows = await readOrExplain(c, who, profile, "project:read", "/api/projects?limit=50");
  if (!rows) return;
  let list = rows;
  if (arg) {
    const q = arg.toLowerCase();
    list = rows.filter((p) => str(p.name).toLowerCase().includes(q));
    // A project the person cannot see is indistinguishable from one that does not exist.
    if (list.length === 0) return void (await c.deps.send(who.chatId, note(COPY.noProject)));
  }
  await c.deps.send(who.chatId, projectCards(list.slice(0, PICK_LIMIT).map((p) => ({ name: str(p.name), health: str(p.health) || null, status: str(p.status) || null }))));
}

async function digest(c: Ctx, who: Who, profile: LinkedProfile, role: Role, arg: string): Promise<void> {
  if (/^(on|off)$/i.test(arg)) {
    return void (await c.deps.send(who.chatId, note("Digest subscriptions are not available in this version. /6 sends one now.")));
  }
  const projects = await readOrExplain(c, who, profile, "project:read", "/api/projects?limit=50");
  if (!projects) return;
  const byHealth = new Map<string, number>();
  for (const p of projects) byHealth.set(str(p.health) || "no health set", (byHealth.get(str(p.health) || "no health set") ?? 0) + 1);
  const lines = [`<b>Digest</b>`, `${projects.length} project${projects.length === 1 ? "" : "s"}: ${[...byHealth].map(([h, n]) => `${n} ${esc(h)}`).join(", ") || "none"}`];
  if (role === "admin" || role === "manager") {
    const pend = await read(c, profile, "task:read", "/api/deletion-requests?status=pending&limit=1");
    if (!("disabled" in pend) && pend.status === 200 && isRec(pend.body) && typeof pend.body.total === "number") {
      lines.push(`${pend.body.total} deletion request${pend.body.total === 1 ? "" : "s"} waiting. /4 to decide.`);
    }
  }
  await c.deps.send(who.chatId, { text: lines.join("\n") });
}

// ---------------------------------------------------------------------------
// /2 Add
// ---------------------------------------------------------------------------

const ADD_KINDS = [
  { value: "t", label: "Task", noun: "task", scope: "task:write" },
  { value: "i", label: "Issue", noun: "issue", scope: "issue:write" },
  { value: "r", label: "Risk", noun: "risk", scope: "risk:write" },
] as const;

async function startAdd(c: Ctx, who: Who, profile: LinkedProfile): Promise<void> {
  const row = await c.deps.store.create(c.ctx.connector, who.chatId, profile.profileId, "pick", { flow: "add", step: "type" }, STEP_TTL_MS);
  await c.deps.send(who.chatId, choice("What do you want to add?", row.id, "a", ADD_KINDS.map((k) => ({ label: k.label, value: k.value }))));
}

async function startUpdate(c: Ctx, who: Who, profile: LinkedProfile, arg: string): Promise<void> {
  if (arg) return searchTasks(c, who, profile, arg, null);
  await c.deps.store.create(c.ctx.connector, who.chatId, profile.profileId, "ask", { flow: "update", step: "search" }, ASK_TTL_MS);
  await c.deps.send(who.chatId, note("Type a few words of the task name. Send cancel to stop."));
}

async function searchTasks(c: Ctx, who: Who, profile: LinkedProfile, query: string, ask: PendingRow | null): Promise<void> {
  const q = query.slice(0, 80);
  const rows = await readOrExplain(c, who, profile, "task:read", `/api/tasks?q=${encodeURIComponent(q)}&limit=${PICK_LIMIT}`);
  if (!rows) return void (ask && (await c.deps.store.settle(ask.id, "failed")));
  const found = rows.slice(0, PICK_LIMIT).map((t) => ({ id: str(t.id), name: str(t.name) })).filter((t) => t.id);
  if (found.length === 0) {
    if (ask) await c.deps.store.settle(ask.id, "done");
    return void (await c.deps.send(who.chatId, note("No matching task. Send /3 to try again.")));
  }
  const payload = { flow: "update", step: "task", candidates: found };
  const row = ask
    ? await c.deps.store.advance(ask, { kind: "pick", payload, ttlMs: STEP_TTL_MS })
    : await c.deps.store.create(c.ctx.connector, who.chatId, profile.profileId, "pick", payload, STEP_TTL_MS);
  if (!row) return;
  await c.deps.send(who.chatId, choice("Which task?", row.id, "k", found.map((t, i) => ({ label: t.name || "(untitled)", value: i }))));
}

// ---------------------------------------------------------------------------
// Free text: continue an open ask, otherwise hand to the assistant seam
// ---------------------------------------------------------------------------

async function continueOrAsk(c: Ctx, who: Who, profile: LinkedProfile, role: Role, text: string): Promise<void> {
  const { deps, ctx } = c;
  const open = await deps.store.latestOpen(ctx.connector.id, who.chatId, profile.profileId);
  if (open && open.kind === "ask") {
    if (isExpired(open, deps)) {
      await deps.store.advance(open, { status: "cancelled" });
      return void (await deps.send(who.chatId, note(COPY.expired)));
    }
    const flow = str(open.payload.flow);
    const step = str(open.payload.step);
    if (flow === "add" && step === "text") return addText(c, who, profile, open, text);
    if (flow === "update" && step === "search") return searchTasks(c, who, profile, text, open);
  }
  if (!text) return void (await deps.send(who.chatId, helpCard(role, false)));
  const ask = deps.askAssistant ?? defaultAskAssistant;
  const reply = await ask({ workspaceId: ctx.connector.workspace_id, profileId: profile.profileId, role, label: profile.label, connectorId: ctx.connector.id }, text).catch((e) => {
    deps.log("warn", "assistant seam failed", { connectorId: ctx.connector.id, error: errMsg(e) });
    return { text: COPY.tryAgain };
  });
  await deps.send(who.chatId, note(reply.text));
}

function isExpired(row: PendingRow, deps: TelegramDeps): boolean {
  return new Date(row.expires_at).getTime() <= deps.now().getTime();
}

async function addText(c: Ctx, who: Who, profile: LinkedProfile, ask: PendingRow, text: string): Promise<void> {
  if (!text || text.length > MAX_TEXT) return void (await c.deps.send(who.chatId, note(`Send one line of up to ${MAX_TEXT} characters.`)));
  const kind = ADD_KINDS.find((k) => k.value === ask.payload.kind);
  if (!kind) return;
  const payload = { ...ask.payload, step: "confirm", text };
  const row = await c.deps.store.advance(ask, { kind: "preview", payload, ttlMs: STEP_TTL_MS });
  if (!row) return;
  await c.deps.send(who.chatId, preview([`Add ${kind.noun}: ${esc(text, 200)}`, `Project: ${esc(str(ask.payload.projectName), 80)}`], row.id));
}

// ---------------------------------------------------------------------------
// /4 Approvals
// ---------------------------------------------------------------------------

async function showApprovals(c: Ctx, who: Who, profile: LinkedProfile): Promise<void> {
  const rows = await readOrExplain(c, who, profile, "task:read", `/api/deletion-requests?status=pending&limit=${PICK_LIMIT}`);
  if (!rows) return;
  if (rows.length === 0) return void (await c.deps.send(who.chatId, note("Nothing is waiting for a decision.")));
  for (const r of rows) {
    const requester = str(r.requested_principal_id) || str(r.requested_by_id);
    const own = requester === profile.profileId;
    const targetType = str(r.target_type) || "task";
    const row = await c.deps.store.create(
      c.ctx.connector,
      who.chatId,
      profile.profileId,
      "approval",
      { requestId: str(r.id), targetType, requester },
      STEP_TTL_MS,
    );
    await c.deps.send(who.chatId, approvalCard({ title: `Delete ${targetType}`, requestedBy: str(r.requested_by_label) || "someone", reason: str(r.reason) || null }, row.id, own));
  }
}

// ---------------------------------------------------------------------------
// Taps
// ---------------------------------------------------------------------------

const CALLBACK_RE = /^(a|p|k|s|y|n|ap|rj):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?::([A-Za-z0-9_-]{1,12}))?$/;

async function processCallback(c: Ctx, updateId: number, q: Rec): Promise<void> {
  const { deps, ctx } = c;
  const queryId = str(q.id);
  const msg = isRec(q.message) ? q.message : {};
  const who = whoOf(q.from, msg.chat);
  if (!who || !queryId) return;
  if (!(await deps.store.dedupe(ctx.connector, who.chatId, `u:${updateId}`))) return;
  const messageId = typeof msg.message_id === "number" ? msg.message_id : null;
  const done = (text?: string) => deps.answer(queryId, text);

  const closed = gate(c);
  if (closed) return done(closed);

  const m = CALLBACK_RE.exec(str(q.data));
  if (!m) return done();
  const [, verb, id, x] = m;

  const profile = await deps.lookupIdentity(ctx.connector, ctx.connector.id, who.userId);
  if (!profile) return done("Link your account first.");
  const role = toRole(profile.role);

  const row = await deps.store.get(ctx.connector.id, id);
  // A row that is not this person's, in this chat, is treated as if it did not exist.
  if (!row || row.chat_id !== who.chatId || row.profile_id !== profile.profileId) return done();
  // A second tap on a finished or claimed step is silently ignored (compare-and-swap below also guards the race).
  if (row.status !== "open") return done();
  const edit = async (r: Rendered) => {
    if (messageId !== null) await deps.edit(who.chatId, messageId, r);
    else await deps.send(who.chatId, r);
  };
  if (isExpired(row, deps)) {
    await deps.store.advance(row, { status: "cancelled" });
    await done();
    return edit(note(COPY.expired));
  }

  const t: Tap = { c, who, profile, role, row, x: x ?? "", edit, done };
  switch (verb) {
    case "n":
      await deps.store.advance(row, { status: "cancelled" });
      await done();
      return edit(note(COPY.cancelled));
    case "a":
      return tapAddType(t);
    case "p":
      return tapProject(t);
    case "k":
      return tapTask(t);
    case "s":
      return tapAction(t);
    case "y":
      return tapConfirm(t);
    case "ap":
    case "rj":
      return tapDecision(t, verb === "ap");
  }
}

type Tap = {
  c: Ctx;
  who: Who;
  profile: LinkedProfile;
  role: Role;
  row: PendingRow;
  x: string;
  edit(r: Rendered): Promise<void>;
  done(text?: string): Promise<void>;
};

async function tapAddType(t: Tap): Promise<void> {
  const { c, row } = t;
  if (row.payload.flow !== "add" || row.payload.step !== "type") return t.done();
  const kind = ADD_KINDS.find((k) => k.value === t.x);
  if (!kind || !canUse(t.role, "2")) return t.done(COPY.noAccess);
  if (!c.deps.scopeEnabled(kind.scope)) {
    await t.done();
    return t.edit(note(COPY.moduleOff));
  }
  const res = await c.deps.api({ connector: c.ctx.connector, profile: t.profile, scopes: ["project:read"], method: "GET", path: "/api/projects?limit=50" });
  const projects = res.status === 200 ? dataList(res.body).map((p) => ({ id: str(p.id), name: str(p.name) })).filter((p) => p.id) : [];
  if (res.status !== 200) {
    await c.deps.store.advance(row, { status: "failed" });
    await t.done();
    return t.edit(note(refusal(res)));
  }
  if (projects.length === 0) {
    await c.deps.store.advance(row, { status: "done" });
    await t.done();
    return t.edit(note("You do not have access to any project yet."));
  }
  const base = { flow: "add", kind: kind.value };
  if (projects.length === 1) {
    const next = await c.deps.store.advance(row, { kind: "ask", payload: { ...base, step: "text", projectId: projects[0].id, projectName: projects[0].name }, ttlMs: ASK_TTL_MS });
    await t.done();
    if (next) await t.edit(note(`Send one line for the new ${kind.noun}. Send cancel to stop.`));
    return;
  }
  const list = projects.slice(0, PICK_LIMIT);
  const next = await c.deps.store.advance(row, { payload: { ...base, step: "project", candidates: list }, ttlMs: STEP_TTL_MS });
  await t.done();
  if (next) await t.edit(choice("Which project?", next.id, "p", list.map((p, i) => ({ label: p.name || "(untitled)", value: i }))));
}

async function tapProject(t: Tap): Promise<void> {
  const { c, row } = t;
  if (row.payload.flow !== "add" || row.payload.step !== "project") return t.done();
  const list = Array.isArray(row.payload.candidates) ? (row.payload.candidates as { id: string; name: string }[]) : [];
  const pick = list[Number(t.x)];
  if (!pick) return t.done();
  const kind = ADD_KINDS.find((k) => k.value === row.payload.kind);
  const next = await c.deps.store.advance(row, {
    kind: "ask",
    payload: { flow: "add", kind: row.payload.kind, step: "text", projectId: pick.id, projectName: pick.name },
    ttlMs: ASK_TTL_MS,
  });
  await t.done();
  if (next) await t.edit(note(`Send one line for the new ${kind?.noun ?? "item"}. Send cancel to stop.`));
}

async function tapTask(t: Tap): Promise<void> {
  const { c, row } = t;
  if (row.payload.flow !== "update" || row.payload.step !== "task") return t.done();
  const list = Array.isArray(row.payload.candidates) ? (row.payload.candidates as { id: string; name: string }[]) : [];
  const pick = list[Number(t.x)];
  if (!pick) return t.done();
  const next = await c.deps.store.advance(row, { payload: { flow: "update", step: "action", taskId: pick.id, taskName: pick.name }, ttlMs: STEP_TTL_MS });
  await t.done();
  if (!next) return;
  await t.edit(
    choice(`${pick.name}: what now?`, next.id, "s", [
      ...STATUS_ACTIONS.map((s, i) => ({ label: `Set to ${s.label}`, value: i })),
      { label: "Request deletion", value: "d" },
    ]),
  );
}

async function tapAction(t: Tap): Promise<void> {
  const { c, row } = t;
  if (row.payload.flow !== "update" || row.payload.step !== "action") return t.done();
  const name = str(row.payload.taskName);
  let payload: Rec;
  let line: string;
  if (t.x === "d") {
    payload = { ...row.payload, step: "confirm", op: "delete" };
    line = `Request deletion of task: ${esc(name, 120)}. Another approver must approve it before anything is removed.`;
  } else {
    const s = STATUS_ACTIONS[Number(t.x)];
    if (!s) return t.done();
    payload = { ...row.payload, step: "confirm", op: "status", status: s.value };
    line = `Set task ${esc(name, 120)} to ${s.label}`;
  }
  const next = await c.deps.store.advance(row, { kind: "preview", payload, ttlMs: STEP_TTL_MS });
  await t.done();
  if (next) await t.edit(preview([line], next.id));
}

type Write = { scope: string; req: Omit<ApiRequest, "connector" | "profile" | "scopes">; ok: string };

function writeFor(row: PendingRow): Write | null {
  const p = row.payload;
  if (p.flow === "add" && p.step === "confirm") {
    const text = str(p.text);
    const pid = encodeURIComponent(str(p.projectId));
    switch (p.kind) {
      case "t":
        return { scope: "task:write", req: { method: "POST", path: `/api/projects/${pid}/tasks`, body: { name: text } }, ok: "Task added." };
      case "i":
        return { scope: "issue:write", req: { method: "POST", path: `/api/projects/${pid}/issues`, body: { title: text, priority: "medium" } }, ok: "Issue added." };
      case "r":
        return { scope: "risk:write", req: { method: "POST", path: `/api/projects/${pid}/risks`, body: { title: text, severity: "medium", likelihood: "medium" } }, ok: "Risk added." };
    }
    return null;
  }
  if (p.flow === "update" && p.step === "confirm") {
    const id = encodeURIComponent(str(p.taskId));
    if (p.op === "delete") {
      return { scope: "task:delete:request", req: { method: "DELETE", path: `/api/tasks/${id}`, body: { reason: "Requested from Telegram" } }, ok: "Deletion requested. An approver has to decide it." };
    }
    if (p.op === "status") return { scope: "task:write", req: { method: "PATCH", path: `/api/tasks/${id}`, body: { status_type: str(p.status) } }, ok: "Task updated." };
  }
  return null;
}

async function tapConfirm(t: Tap): Promise<void> {
  const { c, row } = t;
  const w = writeFor(row);
  if (!w || row.kind !== "preview") return t.done();
  if (!canUse(t.role, "2")) {
    await t.done();
    return t.edit(note(COPY.noAccess));
  }
  if (!c.deps.scopeEnabled(w.scope)) {
    await c.deps.store.advance(row, { status: "failed" });
    await t.done();
    return t.edit(note(COPY.moduleOff));
  }
  // Claim the confirm. Of two taps (a double tap, a retry) exactly one wins; the loser does nothing.
  const claimed = await c.deps.store.advance(row, { status: "claimed" });
  if (!claimed) return t.done();
  await t.done();
  const res = await c.deps.api({ connector: c.ctx.connector, profile: t.profile, scopes: [w.scope], ...w.req });
  const good = res.status >= 200 && res.status < 300;
  await c.deps.store.settle(row.id, good ? "done" : "failed");
  await t.edit(note(good ? w.ok : refusal(res)));
}

async function tapDecision(t: Tap, approve: boolean): Promise<void> {
  const { c, row } = t;
  if (row.kind !== "approval") return t.done();
  if (t.role !== "admin" && t.role !== "manager") {
    await t.done();
    return t.edit(note(COPY.noAccess));
  }
  const requestId = str(row.payload.requestId);
  const targetType = str(row.payload.targetType) || "task";
  // Maker-checker: the requester never decides their own request. Checked BEFORE the claim,
  // so the refusal leaves the request pending (and the card tappable by nobody but a different person).
  if (str(row.payload.requester) === t.profile.profileId) {
    await t.done(COPY.selfApproval);
    return;
  }
  const scope = `${targetType}:delete:approve`;
  if (!c.deps.scopeEnabled(scope)) {
    await t.done();
    return t.edit(note(COPY.moduleOff));
  }
  const claimed = await c.deps.store.advance(row, { status: "claimed" });
  if (!claimed) return t.done();
  await t.done();
  const res = await c.deps.api({
    connector: c.ctx.connector,
    profile: t.profile,
    scopes: [scope],
    method: "POST",
    path: `/api/deletion-requests/${encodeURIComponent(requestId)}/${approve ? "approve" : "reject"}`,
    body: approve ? {} : { reason: "Rejected from Telegram" },
  });
  const good = res.status >= 200 && res.status < 300;
  await c.deps.store.settle(row.id, good ? "done" : "failed");
  // The server repeats the four-eyes check; if it refuses, the request is still pending.
  await t.edit(note(good ? (approve ? "Approved. Recorded in NoPM." : "Rejected. Recorded in NoPM.") : refusal(res)));
}
