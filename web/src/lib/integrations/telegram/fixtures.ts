/**
 * Test fixtures for the Telegram connector: update-shaped payloads, an in-memory
 * `PendingStore` that really compare-and-swaps, and a fake `TelegramDeps` that
 * records every reply. Import from tests only; nothing in the app bundle
 * references this file. All ids are obvious placeholders.
 */

import { vi } from "vitest";
import type { LinkedProfile } from "@/lib/integrations/identity";
import type { ConnectorRow } from "@/lib/integrations/types";
import type { ApiRequest, ApiResult, PendingRow, PendingStore, TelegramDeps } from "./handlers";
import type { Rendered } from "./render";

export const FIXTURE_CONNECTOR_ID = "11111111-1111-4111-8111-111111111111";
export const FIXTURE_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
export const FIXTURE_USER_ID = 1001;
export const FIXTURE_CHAT_ID = 1001;
export const FIXTURE_BOT_TOKEN = "123456:EXAMPLE-token-value";
export const FIXTURE_WEBHOOK_SECRET = "secret_fixture_0123456789abcdef";
export const PROFILE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const OTHER_PROFILE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

export function fixtureConnector(over: Partial<ConnectorRow> = {}): ConnectorRow {
  return {
    id: FIXTURE_CONNECTOR_ID,
    workspace_id: FIXTURE_WORKSPACE_ID,
    kind: "telegram",
    name: "Telegram",
    status: "active",
    config: { region: "lark", appId: "example_bot", mode: "webhook", approvals: { enabled: true }, digest: { enabled: false, chatId: null, weekday: 1 } },
    secret_enc: "enc",
    relay_secret_hash: null,
    tenant_key: null,
    created_by: null,
    created_at: "2026-11-03T00:00:00.000Z",
    updated_at: "2026-11-03T00:00:00.000Z",
    revoked_at: null,
    ...over,
  };
}

export const profile = (over: Partial<LinkedProfile> = {}): LinkedProfile => ({ profileId: PROFILE_ID, role: "member", label: "Pat", ...over });

let nextUpdate = 1;
export const resetUpdateIds = () => {
  nextUpdate = 1;
};

export function messageUpdate(o: { text?: string; userId?: number; chatId?: number; chatType?: string; updateId?: number; isBot?: boolean } = {}) {
  return {
    update_id: o.updateId ?? nextUpdate++,
    message: {
      message_id: 500,
      from: { id: o.userId ?? FIXTURE_USER_ID, is_bot: o.isBot ?? false, first_name: "X" },
      chat: { id: o.chatId ?? FIXTURE_CHAT_ID, type: o.chatType ?? "private" },
      text: o.text ?? "",
    },
  };
}

export function callbackUpdate(o: { data: string; userId?: number; chatId?: number; updateId?: number; messageId?: number }) {
  return {
    update_id: o.updateId ?? nextUpdate++,
    callback_query: {
      id: `cbq-${o.updateId ?? nextUpdate}`,
      from: { id: o.userId ?? FIXTURE_USER_ID, is_bot: false },
      data: o.data,
      message: { message_id: o.messageId ?? 700, chat: { id: o.chatId ?? FIXTURE_CHAT_ID, type: "private" } },
    },
  };
}

/** In-memory store with a real compare-and-swap, like the table's (version, status) update. */
export function memoryStore(clock: { now: () => Date }) {
  const rows = new Map<string, PendingRow>();
  const seen = new Set<string>();
  let n = 0;
  const store: PendingStore = {
    async dedupe(c, _chat, key) {
      const k = `${c.id}:${key}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    },
    async create(c, chatId, profileId, kind, payload, ttlMs) {
      const id = `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
      const row: PendingRow = {
        id,
        workspace_id: c.workspace_id,
        connector_id: c.id,
        chat_id: chatId,
        kind,
        payload,
        version: 1,
        status: "open",
        profile_id: profileId,
        expires_at: new Date(clock.now().getTime() + ttlMs).toISOString(),
      };
      rows.set(id, row);
      return { ...row };
    },
    async get(connectorId, id) {
      const r = rows.get(id);
      return r && r.connector_id === connectorId ? { ...r } : null;
    },
    async latestOpen(connectorId, chatId, profileId) {
      const hits = [...rows.values()].filter(
        (r) => r.connector_id === connectorId && r.chat_id === chatId && r.profile_id === profileId && r.status === "open" && ["ask", "preview", "pick"].includes(r.kind),
      );
      const last = hits[hits.length - 1];
      return last ? { ...last } : null;
    },
    async advance(row, patch) {
      const cur = rows.get(row.id);
      if (!cur || cur.version !== row.version || cur.status !== "open") return null;
      const next: PendingRow = {
        ...cur,
        version: cur.version + 1,
        status: patch.status ?? "open",
        kind: patch.kind ?? cur.kind,
        payload: patch.payload ?? cur.payload,
        expires_at: patch.ttlMs ? new Date(clock.now().getTime() + patch.ttlMs).toISOString() : cur.expires_at,
      };
      rows.set(row.id, next);
      return { ...next };
    },
    async settle(id, status) {
      const cur = rows.get(id);
      if (cur) rows.set(id, { ...cur, status });
    },
    async cancelOpen(connectorId, chatId, profileId) {
      for (const [id, r] of rows) {
        if (r.connector_id === connectorId && r.chat_id === chatId && r.status === "open" && ["ask", "preview", "pick"].includes(r.kind) && (!profileId || r.profile_id === profileId)) {
          rows.set(id, { ...r, status: "cancelled" });
        }
      }
    },
  };
  return { store, rows };
}

export type Sent = { chatId: string; msg: Rendered };

export function fakeDeps(opts: Partial<TelegramDeps> & { identity?: LinkedProfile | null; clockStart?: Date } = {}) {
  const { identity: identityOpt, clockStart, ...over } = opts;
  const clock = { t: (clockStart ?? new Date("2026-11-03T10:00:00.000Z")).getTime(), now() { return new Date(this.t); } };
  const { store, rows } = memoryStore(clock);
  const sent: Sent[] = [];
  const edited: { chatId: string; messageId: number; msg: Rendered }[] = [];
  const answers: { id: string; text?: string }[] = [];
  const apiCalls: ApiRequest[] = [];
  const identity = "identity" in opts ? identityOpt : profile();

  const defaultApi = async (req: ApiRequest): Promise<ApiResult> => {
    if (req.method === "GET" && req.path.startsWith("/api/projects")) return { status: 200, body: { data: [{ id: "p1", name: "Alpha", health: "green", status: "active" }] } };
    if (req.method === "GET" && req.path.startsWith("/api/tasks")) {
      return { status: 200, body: { data: [{ id: "t1", name: "Write plan", due_date: "2026-11-01", status_type: "started" }, { id: "t2", name: "Done thing", status_type: "completed" }] } };
    }
    if (req.method === "GET" && req.path.startsWith("/api/deletion-requests")) {
      return { status: 200, body: { data: [{ id: "d1", target_type: "task", requested_by_label: "Sam", requested_principal_id: OTHER_PROFILE_ID, reason: "stale" }], total: 1 } };
    }
    return { status: 200, body: { data: {} } };
  };

  const api = vi.fn(async (req: ApiRequest) => {
    apiCalls.push(req);
    return (over.api ?? defaultApi)(req);
  });

  const deps = {
    now: () => clock.now(),
    log: vi.fn(),
    store,
    lookupIdentity: vi.fn(async () => identity ?? null),
    consumeLinkCode: vi.fn(async () => ({ status: "linked", profileLabel: "Pat", alreadyLinked: false }) as const),
    scopeEnabled: vi.fn(() => true),
    integrationsEnabled: vi.fn(() => true),
    send: vi.fn(async (chatId: string, msg: Rendered) => {
      sent.push({ chatId, msg });
      return { messageId: 800 + sent.length };
    }),
    edit: vi.fn(async (chatId: string, messageId: number, msg: Rendered) => {
      edited.push({ chatId, messageId, msg });
    }),
    answer: vi.fn(async (id: string, text?: string) => {
      answers.push({ id, text });
    }),
    setChatMenu: vi.fn(async () => {}),
    ...over,
    api,
  } as unknown as TelegramDeps;
  return { deps, sent, edited, answers, apiCalls, rows, clock, writes: () => apiCalls.filter((c) => c.method !== "GET") };
}

/** All callback_data strings offered by the most recent reply (or edit). */
export function buttons(msg: Rendered | undefined): { text: string; data: string }[] {
  return (msg?.keyboard ?? []).flat().map((b) => ({ text: b.text, data: b.callback_data ?? "" }));
}
export function tapData(msg: Rendered | undefined, label: RegExp | string): string {
  const hit = buttons(msg).find((b) => (typeof label === "string" ? b.text === label : label.test(b.text)));
  if (!hit) throw new Error(`no button ${String(label)} in ${JSON.stringify(buttons(msg))}`);
  return hit.data;
}
