import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Static guard for the chat-channel allow-lists inside SQL functions (review round 1, I-1).
 *
 * Many audited RPCs validate `p_channel` / `v_channel` against a literal list that names 'lark'. The
 * Telegram migration (0120) rewrites the stored definition of every such function. This test reads all
 * migrations in order, keeps the LATEST definition of every function, and requires that each one which
 * lists 'lark' either already lists 'telegram' or is covered by the 0120 rewrite. A function created
 * in a later migration with an old-style list fails here instead of failing at approval time.
 */
const dir = join(__dirname, "..", "..", "..", "..", "supabase", "migrations");
const TELEGRAM_MIGRATION = "20261103000120_telegram_connector.sql";
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

// JS twin of the regexp_replace in the migration (Postgres ARE and JS agree on this subset).
const LIST = /channel not in \((?![^)]*telegram)([^)]*'lark'[^)]*)\)/g;
const LARK_LIST_WITHOUT_TELEGRAM = /channel not in \((?![^)]*telegram)[^)]*'lark'[^)]*\)/;

function stripComments(sql: string): string {
  return sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
}

type Def = { name: string; file: string; body: string };

function latestDefinitions(): Def[] {
  const latest = new Map<string, Def>();
  for (const file of files) {
    const sql = stripComments(readFileSync(join(dir, file), "utf8"));
    const parts = sql.split(/create\s+or\s+replace\s+function\s+/i).slice(1);
    for (const part of parts) {
      const sig = part.slice(0, part.search(/\breturns\b/i) >>> 0 || 80);
      const name = sig.trim().replace(/\s+/g, " ");
      latest.set(name, { name, file, body: part });
    }
  }
  return [...latest.values()];
}

describe("telegram channel allow-lists in SQL functions", () => {
  const defs = latestDefinitions();
  const channelFns = defs.filter((d) => /channel not in \(/.test(d.body) && /'lark'/.test(d.body));

  it("finds the channel-checking functions (the scan is not vacuous)", () => {
    expect(channelFns.length).toBeGreaterThan(20);
    const names = channelFns.map((d) => d.name);
    expect(names.some((n) => n.startsWith("nopm_commit_task_deletion"))).toBe(true);
    expect(names.some((n) => n.startsWith("nopm_decide_change_request"))).toBe(true);
    expect(names.some((n) => n.startsWith("nopm_audit_insert"))).toBe(true);
  });

  it("no function created after the telegram migration may omit 'telegram' from its list", () => {
    const late = channelFns.filter((d) => d.file > TELEGRAM_MIGRATION && LARK_LIST_WITHOUT_TELEGRAM.test(d.body));
    expect(late.map((d) => `${d.file}: ${d.name}`)).toEqual([]);
  });

  it("every older function's latest definition allows telegram once the 0120 rewrite is applied", () => {
    const missing: string[] = [];
    for (const d of channelFns.filter((x) => x.file <= TELEGRAM_MIGRATION)) {
      const rewritten = d.body.replace(LIST, "channel not in ($1, 'telegram')");
      // every channel list in the body must now name telegram
      const lists = rewritten.match(/channel not in \([^)]*\)/g) ?? [];
      if (lists.some((l) => /'lark'/.test(l) && !/'telegram'/.test(l))) missing.push(`${d.file}: ${d.name}`);
    }
    expect(missing).toEqual([]);
  });

  it("the rewrite keeps every channel it found (nothing is dropped)", () => {
    const sample = "if p_channel is not null and p_channel not in ('ui', 'api', 'lark') then";
    expect(sample.replace(LIST, "channel not in ($1, 'telegram')")).toBe(
      "if p_channel is not null and p_channel not in ('ui', 'api', 'lark', 'telegram') then",
    );
    const github = "v_channel not in ('ui', 'lark', 'github')";
    expect(github.replace(LIST, "channel not in ($1, 'telegram')")).toBe("v_channel not in ('ui', 'lark', 'github', 'telegram')");
    const already = "p_channel not in ('ui', 'lark', 'telegram')";
    expect(already.replace(LIST, "channel not in ($1, 'telegram')")).toBe(already);
  });

  it("the migration rewrites by pattern and ends with a raising post-condition", () => {
    const sql = readFileSync(join(dir, TELEGRAM_MIGRATION), "utf8");
    expect(sql).toContain("regexp_replace(");
    expect(sql).toContain("channel not in \\((?![^)]*telegram)([^)]*''lark''[^)]*)\\)");
    expect(sql).toMatch(/raise exception 'telegram channel missing from allow-list of:%'/);
    // the post-condition block comes after the rewrite block
    expect(sql.indexOf("raise exception 'telegram channel missing")).toBeGreaterThan(sql.indexOf("regexp_replace("));
  });
});
