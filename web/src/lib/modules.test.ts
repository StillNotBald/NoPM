import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import {
  KERNEL_IDS,
  MODULES,
  disabledModuleIds,
  disabledNavHrefs,
  enabledModules,
  filterLlmsText,
  filterOpenApi,
  filterScopes,
  filterTools,
  isPathDisabled,
  moduleForApiPath,
  moduleForPagePath,
  moduleForScope,
  moduleForTool,
  parseModules,
  validateModules,
} from "@/lib/modules";
import { SCOPES, isValidScope, scopeChoices } from "@/lib/auth/scopes";
import { ALL_NAV_ITEMS } from "@/lib/nav/nav-config";
import { specForTesting, GET as openapiGET } from "@/app/api/openapi.json/route";
import { textForTesting, GET as llmsGET } from "@/app/llms.txt/route";
import { MCP_TOOLS, TOOL_REGISTRY } from "../../mcp/tools.mjs";

const FIX = join(__dirname, "modules-fixtures");
const fixture = (n: string) => readFileSync(join(FIX, n), "utf8");
const SRC = join(__dirname, "..");

afterEach(() => {
  delete process.env.NOPM_MODULES;
});

/** Every `route.ts` folder under app/api, as an API path ("[id]" becomes "*"). */
function apiRoutePaths(): string[] {
  const root = join(SRC, "app", "api");
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, `${rel}/${name}`);
      else if (name === "route.ts") out.push(rel || "/");
    }
  };
  walk(root, "");
  return out.map((p) => p.replace(/\[[^\]]+\]/g, "*"));
}

function consolePageFolders(): string[] {
  const root = join(SRC, "app", "(console)");
  return readdirSync(root).filter((n) => statSync(join(root, n)).isDirectory());
}

const names = (xs: readonly { name: string }[]) => xs.map((x) => x.name);
const call = (url: string) => new NextRequest(url);

describe("registry shape: every surface belongs to a module", () => {
  it("module ids are unique and the kernel set is non-empty", () => {
    expect(new Set(MODULES.map((m) => m.id)).size).toBe(MODULES.length);
    expect(KERNEL_IDS.length).toBeGreaterThan(0);
  });

  it("every API route folder is owned by a module", () => {
    expect(apiRoutePaths().filter((p) => !moduleForApiPath(p))).toEqual([]);
  });

  it("every OpenAPI path is owned by a module", () => {
    expect(Object.keys(specForTesting.paths).filter((p) => !moduleForApiPath(p))).toEqual([]);
  });

  it("every llms.txt endpoint line is owned by a module", () => {
    const orphans = textForTesting
      .split("\n")
      .map((l) => /^(GET|POST|PUT|PATCH|DELETE)\s+(\/\S*)/.exec(l)?.[2]?.replace(/^\/api(?=\/|$)/, ""))
      .filter((p): p is string => !!p && !moduleForApiPath(p));
    expect(orphans).toEqual([]);
  });

  it("every console page folder is owned by exactly one module, except the 404 target", () => {
    const folders = consolePageFolders().filter((f) => f !== "module-disabled");
    expect(folders.filter((f) => !moduleForPagePath(`/${f}`))).toEqual([]);
    const claims = MODULES.flatMap((m) => m.pagePrefixes);
    expect(claims.length).toBe(new Set(claims).size);
    expect(claims.filter((c) => !folders.includes(c))).toEqual([]);
  });

  it("every nav href is owned by exactly one module", () => {
    const claimed = MODULES.flatMap((m) => m.navHrefs);
    expect(claimed.length).toBe(new Set(claimed).size);
    expect(ALL_NAV_ITEMS.map((i) => i.href).filter((h) => !claimed.includes(h))).toEqual([]);
    expect(claimed.filter((h) => !ALL_NAV_ITEMS.some((i) => i.href === h))).toEqual([]);
  });

  it("every scope resource and MCP tool is owned by exactly one module", () => {
    expect(SCOPES.filter((s) => !moduleForScope(s))).toEqual([]);
    const resources = MODULES.flatMap((m) => m.scopeResources);
    expect(resources.length).toBe(new Set(resources).size);
    const tools = MODULES.flatMap((m) => m.mcpTools);
    expect(tools.length).toBe(new Set(tools).size);
    expect(names(MCP_TOOLS).filter((t) => !moduleForTool(t))).toEqual([]);
    expect(tools.filter((t) => !names(MCP_TOOLS).includes(t))).toEqual([]);
  });

  it("every declared llms section exists in llms.txt", () => {
    for (const heading of MODULES.flatMap((m) => m.llmsSections)) {
      expect(textForTesting.split("\n")).toContain(heading);
    }
  });

  it("dependsOn names real modules and the full set is valid", () => {
    expect(validateModules(new Set(MODULES.map((m) => m.id)))).toEqual([]);
    for (const m of MODULES) for (const d of m.dependsOn) expect(MODULES.some((x) => x.id === d)).toBe(true);
  });
});

describe("all modules on is byte-identical to before the registry", () => {
  it("unset NOPM_MODULES enables every module", () => {
    expect(disabledModuleIds()).toEqual([]);
    expect(disabledNavHrefs()).toEqual([]);
  });

  it("OpenAPI document", async () => {
    const res = await openapiGET(call("http://x/api/openapi.json"), {});
    expect(JSON.stringify(await res.json(), null, 2)).toBe(fixture("openapi.all-on.json"));
  });

  it("llms.txt", async () => {
    const res = await llmsGET(call("http://x/llms.txt"), {});
    expect(await res.text()).toBe(fixture("llms.all-on.txt"));
  });

  it("MCP tool list, scopes and scope choices", () => {
    expect(JSON.stringify(names(filterTools(MCP_TOOLS)), null, 2)).toBe(fixture("mcp-tools.all-on.json"));
    expect(JSON.stringify(filterScopes(SCOPES), null, 2)).toBe(fixture("scopes.all-on.json"));
    expect(scopeChoices()).toEqual(scopeChoices(SCOPES));
    for (const s of SCOPES) expect(isValidScope(s)).toBe(true);
  });

  it("no path is blocked", () => {
    for (const p of apiRoutePaths()) expect(isPathDisabled(`/api${p}`)).toBe(false);
    for (const f of consolePageFolders()) expect(isPathDisabled(`/${f}`)).toBe(false);
  });
});

describe("NOPM_MODULES parsing and validation", () => {
  it("blank means all on", () => {
    expect(parseModules("  ").size).toBe(MODULES.length);
  });

  it("the kernel is always on, even when not named", () => {
    const set = parseModules("budget");
    for (const id of KERNEL_IDS) expect(set.has(id)).toBe(true);
    expect(set.has("budget")).toBe(true);
    expect(set.has("sprints")).toBe(false);
  });

  it("an unknown module id throws", () => {
    expect(() => parseModules("budget,nope")).toThrow(/unknown module/);
  });

  it("rejects an enabled module whose dependency is off", () => {
    expect(validateModules(parseModules("clashes"))).toEqual([
      'module "clashes" is enabled but its dependency "resources" is disabled',
    ]);
    expect(validateModules(parseModules("clashes,resources"))).toEqual([]);
  });

  it("rejects integrations when notifications is not enabled", () => {
    // The env parser always adds the kernel, so drive the validator with a raw set.
    expect(validateModules(new Set(["integrations"]))).toContain(
      'module "integrations" is enabled but its dependency "notifications" is disabled',
    );
  });

  it("an invalid environment fails loudly at first use", () => {
    process.env.NOPM_MODULES = "clashes";
    expect(() => enabledModules()).toThrow(/Invalid NOPM_MODULES/);
    process.env.NOPM_MODULES = "bogus";
    expect(() => enabledModules()).toThrow(/unknown module/);
  });
});

describe("minimal profile: kernel plus risks and issues", () => {
  const minimal = () => parseModules("risks_issues");

  it("hides budget on every surface", () => {
    const on = minimal();
    expect(isPathDisabled("/budget", on)).toBe(true);
    expect(isPathDisabled("/api/projects/abc/budget", on)).toBe(true);
    expect(isPathDisabled("/api/projects/abc/expenses", on)).toBe(true);
    expect(isPathDisabled("/api/expenses/abc", on)).toBe(true);
    expect(disabledNavHrefs(on)).toContain("/budget");
    expect(names(filterTools(MCP_TOOLS, on))).not.toContain("get_budget");
    const spec = filterOpenApi(specForTesting, on);
    expect(Object.keys(spec.paths).filter((p) => /budget|expenses/.test(p))).toEqual([]);
    expect(filterScopes(SCOPES, on).filter((s) => s.startsWith("budget:"))).toEqual([]);
  });

  it("keeps the kernel and the enabled module reachable", () => {
    const on = minimal();
    const apis = [
      "/api/projects", "/api/projects/x/lock", "/api/tasks/x", "/api/deletion-requests",
      "/api/audit", "/api/tokens", "/api/risks/x", "/api/projects/x/risks", "/api/health", "/api/mcp",
    ];
    for (const p of apis) expect(isPathDisabled(p, on), p).toBe(false);
    for (const p of ["/projects", "/tasks", "/my-work", "/approvals", "/tokens", "/risks"]) {
      expect(isPathDisabled(p, on), p).toBe(false);
    }
    expect(names(filterTools(MCP_TOOLS, on))).toEqual(
      expect.arrayContaining(["list_tasks", "create_task", "request_task_deletion", "query_audit", "list_risks"]),
    );
    expect(filterScopes(SCOPES, on)).toEqual(
      expect.arrayContaining(["task:write", "task:delete:approve", "audit:read", "risk:read"]),
    );
  });

  it("hides every other optional module's pages, tools and scopes", () => {
    const on = minimal();
    for (const m of MODULES) {
      if (m.kind !== "optional" || m.id === "risks_issues") continue;
      for (const pg of m.pagePrefixes) expect(isPathDisabled(`/${pg}`, on), `${m.id} page ${pg}`).toBe(true);
      for (const t of m.mcpTools) expect(names(filterTools(MCP_TOOLS, on))).not.toContain(t);
      for (const r of m.scopeResources) {
        expect(filterScopes(SCOPES, on).filter((s) => s.startsWith(`${r}:`))).toEqual([]);
      }
    }
    const owners = Object.keys(filterOpenApi(specForTesting, on).paths).map((p) => moduleForApiPath(p)!.id);
    for (const id of new Set(owners)) expect([...KERNEL_IDS, "risks_issues"]).toContain(id);
  });

  it("scope minting refuses a disabled module's scope and accepts the kernel's", () => {
    process.env.NOPM_MODULES = "risks_issues";
    expect(isValidScope("budget:read")).toBe(false);
    expect(isValidScope("budget:*")).toBe(false);
    expect(isValidScope("sprint:write")).toBe(false);
    expect(isValidScope("task:write")).toBe(true);
    expect(isValidScope("risk:*")).toBe(true);
    expect(scopeChoices().some((c) => c.startsWith("budget:"))).toBe(false);
  });

  it("the served OpenAPI document and llms.txt drop the module", async () => {
    process.env.NOPM_MODULES = "risks_issues";
    const spec = await (await openapiGET(call("http://x/api/openapi.json"), {})).json();
    expect(Object.keys(spec.paths)).not.toContain("/projects/{id}/budget");
    expect(Object.keys(spec.paths)).toContain("/tasks");
    // llms.txt bakes the tool count in at import time, so load a fresh copy under the env.
    vi.resetModules();
    const fresh = await import("@/app/llms.txt/route");
    const txt = await (await fresh.GET(call("http://x/llms.txt"), {})).text();
    expect(txt).not.toMatch(/^(GET|POST|PATCH|PUT|DELETE)\s+\/projects\/\{id\}\/budget/m);
    expect(txt).not.toContain("## Integrations (Lark / Feishu)");
    expect(txt).not.toContain("## Calendar feed");
    expect(txt).toContain("## Endpoint index");
    expect(txt).toContain("## MCP server");
    const count = filterTools(TOOL_REGISTRY).length;
    expect(txt).toContain(`It exposes ${count} governed tools`);
    expect(count).toBeLessThan(TOOL_REGISTRY.length);
  });

  it("filterLlmsText removes a whole section but nothing after it", () => {
    const text = [
      "## A", "x", "",
      "## Integrations (Lark / Feishu)", "GET /integrations/cron  y", "z", "",
      "## Calendar feed", "GET /calendar/{token}", "",
      "---", "", "keep",
    ].join("\n");
    const out = filterLlmsText(text, parseModules("risks_issues"));
    expect(out).toBe(["## A", "x", "", "---", "", "keep"].join("\n"));
  });
});
