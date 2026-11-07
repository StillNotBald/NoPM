/**
 * Cloudflare host cron mapping (ADR 0021): each fired expression reaches the
 * right route with the bearer secret, an unknown one is a logged no-op, and the
 * secret never reaches a log line.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CRON_ROUTES, resolveCronRoute, runScheduled } from "./cloudflare-cron";

const SECRET = "s3cr3t-value-that-must-never-be-logged-0123456789";
const root = resolve(__dirname, "../../..");

function logger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}
function allLogged(l: ReturnType<typeof logger>): string {
  return JSON.stringify([l.log.mock.calls, l.warn.mock.calls, l.error.mock.calls]);
}

describe("cron expression to route", () => {
  it("maps each expression to its route", () => {
    expect(resolveCronRoute("7 1 * * *")).toBe("/api/integrations/cron");
    expect(resolveCronRoute("37 17 * * *")).toBe("/api/cron/snapshots");
  });

  it("returns null for anything else, including prototype keys", () => {
    expect(resolveCronRoute("* * * * *")).toBeNull();
    expect(resolveCronRoute("")).toBeNull();
    expect(resolveCronRoute("constructor")).toBeNull();
    expect(resolveCronRoute("__proto__")).toBeNull();
  });

  it("matches vercel.json crons exactly (same expression, same path)", () => {
    const vercel = JSON.parse(readFileSync(resolve(root, "vercel.json"), "utf8")) as { crons: { path: string; schedule: string }[] };
    const fromVercel = Object.fromEntries(vercel.crons.map((c) => [c.schedule, c.path]));
    expect(CRON_ROUTES).toEqual(fromVercel);
  });

  it("matches wrangler.jsonc triggers.crons exactly", () => {
    const text = readFileSync(resolve(root, "wrangler.jsonc"), "utf8")
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    const wrangler = JSON.parse(text) as { triggers: { crons: string[] } };
    expect([...wrangler.triggers.crons].sort()).toEqual(Object.keys(CRON_ROUTES).sort());
  });
});

describe("runScheduled", () => {
  it.each(Object.entries(CRON_ROUTES))("%s calls %s with the bearer secret", async (expression, path) => {
    const seen: Request[] = [];
    const log = logger();
    const result = await runScheduled(
      expression,
      { CRON_SECRET: SECRET, NEXT_PUBLIC_APP_URL: "https://app.example.test/some/path" },
      async (req) => {
        seen.push(req);
        return new Response("{}", { status: 200 });
      },
      log,
    );
    expect(result).toEqual({ ran: true, path, status: 200 });
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("GET");
    expect(new URL(seen[0].url).pathname).toBe(path);
    expect(new URL(seen[0].url).origin).toBe("https://app.example.test");
    expect(seen[0].headers.get("authorization")).toBe(`Bearer ${SECRET}`);
    expect(allLogged(log)).not.toContain(SECRET);
  });

  it("an unknown expression is a logged no-op: nothing is dispatched", async () => {
    const dispatch = vi.fn();
    const log = logger();
    const result = await runScheduled("*/5 * * * *", { CRON_SECRET: SECRET }, dispatch, log);
    expect(result).toEqual({ ran: false, reason: "unknown-expression" });
    expect(dispatch).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(allLogged(log)).not.toContain(SECRET);
  });

  it("a missing secret is logged and no call is made", async () => {
    const dispatch = vi.fn();
    const log = logger();
    const result = await runScheduled("7 1 * * *", { CRON_SECRET: "  " }, dispatch, log);
    expect(result).toEqual({ ran: false, reason: "no-secret", path: "/api/integrations/cron" });
    expect(dispatch).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it("a non-2xx response is logged as an error with the status only", async () => {
    const log = logger();
    const result = await runScheduled("37 17 * * *", { CRON_SECRET: SECRET }, async () => new Response("body " + SECRET, { status: 401 }), log);
    expect(result).toEqual({ ran: true, path: "/api/cron/snapshots", status: 401 });
    expect(log.error).toHaveBeenCalledWith("[cron] /api/cron/snapshots -> 401");
    expect(allLogged(log)).not.toContain(SECRET);
  });

  it("a thrown dispatch never escapes and never logs the message (it could carry the secret)", async () => {
    const log = logger();
    const result = await runScheduled(
      "7 1 * * *",
      { CRON_SECRET: SECRET },
      async () => {
        throw new Error(`boom ${SECRET}`);
      },
      log,
    );
    expect(result).toEqual({ ran: false, reason: "error", path: "/api/integrations/cron" });
    expect(allLogged(log)).not.toContain(SECRET);
  });

  it("falls back to a placeholder origin when the app URL is missing or malformed", async () => {
    const origins: string[] = [];
    const dispatch = async (req: Request) => {
      origins.push(new URL(req.url).origin);
      return new Response("", { status: 200 });
    };
    await runScheduled("7 1 * * *", { CRON_SECRET: SECRET }, dispatch, logger());
    await runScheduled("7 1 * * *", { CRON_SECRET: SECRET, NEXT_PUBLIC_APP_URL: "not a url" }, dispatch, logger());
    expect(origins).toEqual(["https://nopm-web.invalid", "https://nopm-web.invalid"]);
  });
});
