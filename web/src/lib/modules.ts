/**
 * Module registry — Level 1 of NoPM modularity (ADR 0015).
 *
 * ONE typed list says which part of the product owns each nav item, page,
 * `/api/*` route, MCP tool, scope and `llms.txt` section. A deployment turns
 * optional modules off with `NOPM_MODULES`; every edge then reads this file:
 *
 *   - `proxy.ts`            404 for a disabled module's pages and `/api/*` routes
 *   - `nav-config.ts`       sidebar, bottom nav and command palette
 *   - `scopes.ts`           token minting refuses a disabled module's scopes
 *   - `api/mcp`, assistant  tool lists
 *   - `openapi.json`        paths of a disabled module are omitted
 *   - `llms.txt`            endpoint lines, sections and the tool count
 *
 * Unset `NOPM_MODULES` = every module on = byte-identical behaviour to before
 * this file existed. The database stays complete either way (no schema change):
 * a disabled module's tables simply stay empty.
 *
 * This file must stay pure (no node:*, no I/O): it is imported by the edge
 * proxy, server routes and client components alike.
 */

export type ModuleKind = "kernel" | "optional";

export type ModuleDef = {
  id: string;
  label: string;
  kind: ModuleKind;
  /** Module ids this one needs switched on (kernel ids are always satisfied by the env parser). */
  dependsOn: readonly string[];
  /** Sidebar / palette hrefs, e.g. "/budget". */
  navHrefs: readonly string[];
  /** First path segment of console pages, e.g. "budget". */
  pagePrefixes: readonly string[];
  /**
   * API path patterns WITHOUT the "/api" prefix. A pattern matches a path when its
   * segments are a prefix of the path's; "*" matches any one segment (also `{id}`
   * and `[id]`). The most specific (longest) match across all modules wins.
   */
  apiPrefixes: readonly string[];
  /** MCP tool names (web/mcp/tools.mjs). */
  mcpTools: readonly string[];
  /** Scope resources, i.e. the part before ":" in `resource:action`. */
  scopeResources: readonly string[];
  /** Exact `## Heading` lines of llms.txt sections that describe only this module. */
  llmsSections: readonly string[];
  /** Tables the module owns (informational; nothing enforces it). */
  tables: readonly string[];
};

const def = (
  d: Partial<ModuleDef> & Pick<ModuleDef, "id" | "label" | "kind">,
): ModuleDef => ({
  dependsOn: [],
  navHrefs: [],
  pagePrefixes: [],
  apiPrefixes: [],
  mcpTools: [],
  scopeResources: [],
  llmsSections: [],
  tables: [],
  ...d,
});

export const MODULES: readonly ModuleDef[] = [
  // ── Kernel: never switchable ───────────────────────────────────────────────
  def({
    id: "tenancy_auth",
    label: "Tenancy, auth and tokens",
    kind: "kernel",
    navHrefs: ["/tokens"],
    pagePrefixes: ["tokens", "settings", "start", "email-previews"],
    apiPrefixes: ["/health", "/auth", "/tokens", "/me", "/invites", "/openapi.json", "/mcp"],
    tables: ["workspaces", "profiles", "api_tokens", "user_mfa", "user_preferences", "idempotency_keys", "nopm_rate_counters", "nopm_ref_counters", "invites"],
  }),
  def({
    id: "audit",
    label: "Audit",
    kind: "kernel",
    apiPrefixes: ["/audit"],
    mcpTools: ["query_audit"],
    scopeResources: ["audit"],
    tables: ["audit_log"],
  }),
  def({
    id: "governance",
    label: "Four-eyes, governed deletion and locks",
    kind: "kernel",
    navHrefs: ["/approvals"],
    pagePrefixes: ["approvals"],
    apiPrefixes: ["/deletion-requests", "/projects/*/lock", "/projects/*/unlock"],
    tables: ["deletion_requests"],
  }),
  def({
    id: "notifications",
    label: "Notifications",
    kind: "kernel",
    apiPrefixes: ["/notifications"],
    scopeResources: ["notification"],
    tables: ["notifications"],
  }),
  def({
    id: "work",
    label: "Projects, tasks, milestones and members",
    kind: "kernel",
    navHrefs: ["/my-work", "/my-tasks", "/projects", "/tasks"],
    pagePrefixes: ["my-work", "my-tasks", "projects", "tasks"],
    apiPrefixes: ["/projects", "/programs", "/tasks", "/milestones", "/search"],
    mcpTools: [
      "list_projects", "get_project", "create_project", "update_project", "request_project_deletion",
      "list_milestones", "create_milestone", "update_milestone",
      "list_tasks", "get_task", "create_task", "update_task", "request_task_deletion",
      "search_workspace",
    ],
    scopeResources: ["project", "program", "milestone", "task"],
    tables: ["programs", "projects", "milestones", "tasks", "task_dependencies", "resource_members"],
  }),

  // ── Optional modules ───────────────────────────────────────────────────────
  def({
    id: "portfolio",
    label: "Dashboard and portfolio",
    kind: "optional",
    navHrefs: ["/dashboard", "/portfolio"],
    pagePrefixes: ["dashboard", "portfolio"],
    apiPrefixes: ["/metrics"],
  }),
  def({
    id: "mainline",
    label: "Mainline timeline",
    kind: "optional",
    navHrefs: ["/mainline"],
    pagePrefixes: ["mainline"],
    apiPrefixes: ["/timeline"],
  }),
  def({
    id: "sprints",
    label: "Sprints",
    kind: "optional",
    navHrefs: ["/sprints"],
    pagePrefixes: ["sprints"],
    apiPrefixes: ["/sprints"],
    scopeResources: ["sprint"],
    tables: ["sprints"],
  }),
  def({
    id: "risks_issues",
    label: "Risks and issues",
    kind: "optional",
    navHrefs: ["/risks", "/issues"],
    pagePrefixes: ["risks", "issues"],
    apiPrefixes: ["/risks", "/issues", "/projects/*/risks", "/projects/*/issues"],
    mcpTools: ["list_risks", "create_risk", "update_risk", "list_issues", "create_issue", "update_issue"],
    scopeResources: ["risk", "issue"],
    tables: ["risks", "issues"],
  }),
  def({
    id: "resources",
    label: "Resources and capacity",
    kind: "optional",
    navHrefs: ["/resources"],
    pagePrefixes: ["resources"],
    apiPrefixes: ["/resources"],
    mcpTools: ["list_resources"],
    scopeResources: ["resource"],
  }),
  def({
    id: "clashes",
    label: "Clashes and allocations",
    kind: "optional",
    dependsOn: ["resources"],
    navHrefs: ["/clashes"],
    pagePrefixes: ["clashes"],
    apiPrefixes: ["/clashes", "/allocations"],
    mcpTools: ["list_clashes"],
    scopeResources: ["clash"],
    tables: ["clashes", "allocations"],
  }),
  def({
    id: "budget",
    label: "Budget and expenses",
    kind: "optional",
    navHrefs: ["/budget"],
    pagePrefixes: ["budget"],
    apiPrefixes: ["/projects/*/budget", "/projects/*/expenses", "/expenses"],
    mcpTools: ["get_budget"],
    scopeResources: ["budget"],
    tables: ["project_budget", "expenses"],
  }),
  def({
    id: "reports",
    label: "Reports, decks and CSV export",
    kind: "optional",
    apiPrefixes: ["/reports", "/export"],
  }),
  def({
    id: "documents",
    label: "Documents",
    kind: "optional",
    navHrefs: ["/documents"],
    pagePrefixes: ["documents"],
    apiPrefixes: ["/documents"],
    mcpTools: ["create_document"],
    scopeResources: ["document"],
    tables: ["documents"],
  }),
  def({
    id: "decisions",
    label: "Decisions",
    kind: "optional",
    navHrefs: ["/decisions"],
    pagePrefixes: ["decisions"],
    apiPrefixes: ["/decisions", "/projects/*/decisions"],
    mcpTools: ["create_decision"],
    scopeResources: ["decision"],
    tables: ["decisions"],
  }),
  def({
    id: "change_control",
    label: "Change control",
    kind: "optional",
    navHrefs: ["/change-control"],
    pagePrefixes: ["change-control"],
    apiPrefixes: ["/change-requests", "/projects/*/change-requests"],
    mcpTools: ["create_change_request"],
    scopeResources: ["change"],
    tables: ["change_requests"],
  }),
  def({
    id: "baselines",
    label: "Baselines and rebaselines",
    kind: "optional",
    navHrefs: ["/baselines"],
    pagePrefixes: ["baselines"],
    apiPrefixes: ["/rebaselines", "/projects/*/rebaselines"],
    mcpTools: ["propose_rebaseline", "sign_off_rebaseline", "apply_rebaseline"],
    scopeResources: ["rebaseline"],
    tables: ["rebaselines", "rebaseline_signoffs"],
  }),
  def({
    id: "review",
    label: "Review inbox",
    kind: "optional",
    navHrefs: ["/review"],
    pagePrefixes: ["review"],
    apiPrefixes: ["/review"],
    mcpTools: ["list_pending_approvals"],
  }),
  def({
    id: "trust",
    label: "Trust centre",
    kind: "optional",
    navHrefs: ["/trust"],
    pagePrefixes: ["trust"],
  }),
  def({
    id: "assistant",
    label: "Assistant (bring your own key)",
    kind: "optional",
    apiPrefixes: ["/assistant"],
    scopeResources: ["assistant"],
    tables: ["assistant_credentials", "assistant_conversations", "assistant_messages", "assistant_usage"],
  }),
  def({
    id: "integrations",
    label: "Integration hub and Lark",
    kind: "optional",
    dependsOn: ["notifications"],
    navHrefs: ["/integrations"],
    pagePrefixes: ["integrations"],
    apiPrefixes: ["/integrations"],
    llmsSections: ["## Integrations (Lark / Feishu)"],
  }),
  def({
    id: "calendar",
    label: "Calendar feeds",
    kind: "optional",
    apiPrefixes: ["/calendar-feeds", "/calendar"],
    llmsSections: ["## Calendar feed"],
    tables: ["calendar_feeds"],
  }),
  def({
    id: "saved_views",
    label: "Saved views",
    kind: "optional",
    apiPrefixes: ["/saved-views"],
    scopeResources: ["saved_view"],
    tables: ["saved_views"],
  }),
];

export const MODULE_IDS: readonly string[] = MODULES.map((m) => m.id);
export const KERNEL_IDS: readonly string[] = MODULES.filter((m) => m.kind === "kernel").map((m) => m.id);

// ── Enabled set ──────────────────────────────────────────────────────────────

export type ModuleSet = ReadonlySet<string>;

/**
 * Parses a `NOPM_MODULES` value. Unset or blank = every module on. Otherwise the
 * comma list names the OPTIONAL modules to keep; the kernel is always added, so
 * naming it is harmless and omitting it cannot switch it off. Unknown ids throw.
 */
export function parseModules(raw: string | undefined | null, registry: readonly ModuleDef[] = MODULES): Set<string> {
  const all = new Set(registry.map((m) => m.id));
  if (raw === undefined || raw === null || raw.trim() === "") return all;
  const wanted = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = wanted.filter((id) => !all.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `NOPM_MODULES names unknown module(s): ${unknown.join(", ")}. Known: ${[...all].join(", ")}`,
    );
  }
  const set = new Set(wanted);
  for (const m of registry) if (m.kind === "kernel") set.add(m.id);
  return set;
}

/**
 * Startup validation: an enabled module must not depend on a module that is off.
 * Returns human-readable problems (empty = valid). Pure, so tests can drive it
 * with any set, including one that omits the kernel.
 */
export function validateModules(enabled: ModuleSet, registry: readonly ModuleDef[] = MODULES): string[] {
  const byId = new Map(registry.map((m) => [m.id, m]));
  const problems: string[] = [];
  for (const m of registry) {
    if (!enabled.has(m.id)) continue;
    for (const dep of m.dependsOn) {
      if (!byId.has(dep)) problems.push(`module "${m.id}" declares unknown dependency "${dep}"`);
      else if (!enabled.has(dep)) problems.push(`module "${m.id}" is enabled but its dependency "${dep}" is disabled`);
    }
  }
  return problems;
}

let cached: { raw: string | undefined; set: Set<string> } | null = null;

/** The deployment's enabled set (memoised per env value; throws on an invalid configuration). */
export function enabledModules(): ModuleSet {
  const raw = process.env.NOPM_MODULES;
  if (cached && cached.raw === raw) return cached.set;
  const set = parseModules(raw);
  const problems = validateModules(set);
  if (problems.length > 0) throw new Error(`Invalid NOPM_MODULES: ${problems.join("; ")}`);
  cached = { raw, set };
  return set;
}

export function isModuleEnabled(id: string, enabled: ModuleSet = enabledModules()): boolean {
  return enabled.has(id);
}

export function disabledModuleIds(enabled: ModuleSet = enabledModules()): string[] {
  return MODULES.filter((m) => !enabled.has(m.id)).map((m) => m.id);
}

// ── Ownership lookups ────────────────────────────────────────────────────────

const OPEN_PARAM = /^(\{[^}]*\}|\[[^\]]*\]|\*)$/;

function segs(p: string): string[] {
  return p.split("/").filter(Boolean);
}

/** Specificity of a pattern against a path (number of matched segments), or -1. */
function matchLength(pattern: string, path: string): number {
  const ps = segs(pattern);
  const xs = segs(path);
  if (ps.length > xs.length) return -1;
  for (let i = 0; i < ps.length; i++) {
    if (OPEN_PARAM.test(ps[i])) continue;
    if (ps[i] !== xs[i]) return -1;
  }
  return ps.length;
}

/** Module that owns an API path (given WITHOUT "/api"), or null when nothing claims it. */
export function moduleForApiPath(path: string, registry: readonly ModuleDef[] = MODULES): ModuleDef | null {
  let best: ModuleDef | null = null;
  let bestLen = 0;
  for (const m of registry) {
    for (const pat of m.apiPrefixes) {
      const len = matchLength(pat, path);
      if (len > bestLen) {
        best = m;
        bestLen = len;
      }
    }
  }
  return best;
}

/** Module that owns a console page path such as "/budget/abc" (first segment), or null. */
export function moduleForPagePath(path: string, registry: readonly ModuleDef[] = MODULES): ModuleDef | null {
  const first = segs(path)[0];
  if (!first) return null;
  return registry.find((m) => m.pagePrefixes.includes(first)) ?? null;
}

export function moduleForScope(scope: string, registry: readonly ModuleDef[] = MODULES): ModuleDef | null {
  const resource = scope.split(":")[0];
  return registry.find((m) => m.scopeResources.includes(resource)) ?? null;
}

export function moduleForTool(name: string, registry: readonly ModuleDef[] = MODULES): ModuleDef | null {
  return registry.find((m) => m.mcpTools.includes(name)) ?? null;
}

// ── Gates ────────────────────────────────────────────────────────────────────

/** True when a request path (with or without "/api") is blocked because its module is off. */
export function isPathDisabled(pathname: string, enabled: ModuleSet = enabledModules()): boolean {
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    const owner = moduleForApiPath(pathname.slice(4) || "/");
    return !!owner && !enabled.has(owner.id);
  }
  const owner = moduleForPagePath(pathname);
  return !!owner && !enabled.has(owner.id);
}

export function isScopeEnabled(scope: string, enabled: ModuleSet = enabledModules()): boolean {
  const owner = moduleForScope(scope);
  return !owner || enabled.has(owner.id);
}

/** Keeps the scopes of enabled modules; scopes no module claims pass through. */
export function filterScopes<T extends string>(scopes: readonly T[], enabled: ModuleSet = enabledModules()): T[] {
  return scopes.filter((s) => isScopeEnabled(s, enabled));
}

export function filterTools<T extends { name: string }>(tools: readonly T[], enabled: ModuleSet = enabledModules()): T[] {
  return tools.filter((t) => {
    const owner = moduleForTool(t.name);
    return !owner || enabled.has(owner.id);
  });
}

/** Nav hrefs of disabled modules (what the console layout hands to the client). */
export function disabledNavHrefs(enabled: ModuleSet = enabledModules()): string[] {
  return MODULES.filter((m) => !enabled.has(m.id)).flatMap((m) => [...m.navHrefs]);
}

type OpenApiLike = { paths: Record<string, unknown> } & Record<string, unknown>;

/** The OpenAPI document minus the paths of disabled modules. All-on returns the same object. */
export function filterOpenApi<T extends OpenApiLike>(spec: T, enabled: ModuleSet = enabledModules()): T {
  if (disabledModuleIds(enabled).length === 0) return spec;
  const paths: Record<string, unknown> = {};
  for (const [p, v] of Object.entries(spec.paths)) {
    const owner = moduleForApiPath(p);
    if (!owner || enabled.has(owner.id)) paths[p] = v;
  }
  return { ...spec, paths };
}

const ENDPOINT_LINE = /^(GET|POST|PUT|PATCH|DELETE)\s+(\/\S*)/;

/**
 * llms.txt minus disabled modules' endpoint lines and whole sections. A section runs
 * from its heading to the next "## " heading or "---" rule. All-on returns the text unchanged.
 */
export function filterLlmsText(text: string, enabled: ModuleSet = enabledModules()): string {
  const disabled = MODULES.filter((m) => !enabled.has(m.id));
  if (disabled.length === 0) return text;
  const drop = new Set(disabled.flatMap((m) => [...m.llmsSections]));
  const out: string[] = [];
  let skipping = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("## ") || line === "---") skipping = drop.has(line);
    if (skipping) continue;
    const m = ENDPOINT_LINE.exec(line);
    if (m) {
      const owner = moduleForApiPath(m[2].replace(/^\/api(?=\/|$)/, ""));
      if (owner && !enabled.has(owner.id)) continue;
    }
    out.push(line);
  }
  return out.join("\n");
}
