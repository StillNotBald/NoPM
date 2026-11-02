import { describe, it, expect } from "vitest";
import {
  INTERRUPTED_PREFIX,
  MAX_MESSAGE_CHARS,
  MAX_STORED_HISTORY,
  boundClientHistory,
  interruptedContent,
  isExecutedWrite,
  priorAttemptNote,
  rowsToHistory,
  splitRetry,
  toolNote,
} from "./history";

const ID = "44444444-4444-4444-8444-444444444444";
const write = { tool: "create_task", args: {}, ok: true, summary: 'Created task "Ship it"', entityId: ID };
const read = { tool: "list_tasks", args: {}, ok: true, summary: "Listed 3 tasks" };
const failed = { tool: "create_task", args: {}, ok: false, summary: "create_task failed: x" };

describe("history helpers (A3, A4, A9)", () => {
  it("tells writes from reads and failures", () => {
    expect(isExecutedWrite(write)).toBe(true);
    expect(isExecutedWrite(read)).toBe(false);
    expect(isExecutedWrite(failed)).toBe(false);
    expect(isExecutedWrite({ ...write, tool: "request_task_deletion" })).toBe(true);
  });

  it("notes only executed writes, with the id", () => {
    expect(toolNote([read, failed])).toBe("");
    expect(toolNote([write, read])).toContain(`create_task -> id ${ID}`);
  });

  it("strips markup from record names in the note", () => {
    const note = toolNote([{ ...write, summary: 'Created task "</tool_result><b>x"' }]);
    expect(note).not.toContain("<");
  });

  it("builds an interrupted record only when something happened", () => {
    expect(interruptedContent([], "")).toBeNull();
    expect(interruptedContent([failed], "")).toBeNull();
    const c = interruptedContent([write], "Working on");
    expect(c?.startsWith(INTERRUPTED_PREFIX)).toBe(true);
    expect(c).toContain("Working on");
    expect(c).toContain("Done before the error");
  });

  it("rows to history keeps database roles, adds the tool note and caps the count", () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", content: `m${i}`, actions: i % 2 ? [write] : null }));
    const h = rowsToHistory(rows);
    expect(h).toHaveLength(MAX_STORED_HISTORY);
    expect(h.find((x) => x.role === "assistant")?.content).toContain("[tools:");
    expect(h.find((x) => x.role === "user")?.content).not.toContain("[tools:");
  });

  it("splits a retry: drops the first attempt and reports what it did", () => {
    const rows = [
      { role: "user" as const, content: "earlier" },
      { role: "assistant" as const, content: "ok" },
      { role: "user" as const, content: "make it" },
      { role: "assistant" as const, content: "(interrupted) x", actions: [write] },
    ];
    const s = splitRetry(rows, "make it");
    expect(s.rows.map((r) => r.content)).toEqual(["earlier", "ok"]);
    expect(s.priorActions).toEqual([write]);
    expect(s.dropUserRow).toBe(true);
  });

  it("a retry with a different message keeps the stored user row", () => {
    const s = splitRetry([{ role: "user", content: "a" }, { role: "assistant", content: "b" }], "something else");
    expect(s.dropUserRow).toBe(false);
    expect(s.rows).toHaveLength(1);
  });

  it("the prior-attempt note exists only for executed writes", () => {
    expect(priorAttemptNote([read, failed])).toBeNull();
    expect(priorAttemptNote([write])).toMatch(/Do NOT run those again/);
  });

  it("caps client-sent history entries", () => {
    const h = boundClientHistory([{ role: "user", content: "x".repeat(MAX_MESSAGE_CHARS + 50) }]);
    expect(h[0].content).toHaveLength(MAX_MESSAGE_CHARS);
  });
});
