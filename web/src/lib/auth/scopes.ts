/**
 * Central scope registry. Every `resource:action` scope the API enforces via
 * requireScope() is listed here, so a Personal Access Token can only be minted
 * with scopes the system actually understands — a bogus scope is rejected at
 * creation rather than silently granted (and never matched).
 *
 * hasScope() (auth/tokens.ts) still honours legacy wildcards ("<resource>:*" and
 * the global "*") for already-minted tokens — EXCEPT for PRIVILEGED_SCOPES
 * (the approve/decide verbs), which wildcards never grant — but isValidScope()
 * — used at MINT time — accepts only concrete scopes and per-resource
 * "<resource>:*" wildcards. The bare global "*" can no longer be minted
 * (defense-in-depth).
 *
 * Hour logging was removed (2026-10-17): the retired `time:*` scopes are no
 * longer registered, so they cannot be minted. Tokens minted earlier that carry
 * them still authenticate — scopes are matched by name at request time, not
 * re-validated — and the retired scopes simply match nothing.
 */
export const SCOPES = [
  "project:read", "project:write",
  "program:read", "program:write", "program:delete:request",
  "milestone:read", "milestone:write", "milestone:delete:request", "milestone:delete:approve",
  "task:read", "task:write", "task:delete:request", "task:delete:approve",
  "project:delete:request", "project:delete:approve",
  "sprint:read", "sprint:write", "sprint:delete:request",
  "risk:read", "risk:write", "risk:delete", "risk:delete:request", "risk:delete:approve",
  "issue:read", "issue:write", "issue:delete", "issue:delete:request", "issue:delete:approve",
  "clash:read", "clash:write", "clash:delete:request",
  "resource:read", "resource:write", "resource:delete:request", "allocation:delete:request",
  "budget:read", "budget:write",
  "expense:delete:request", "expense:delete:approve",
  "document:read", "document:write", "document:delete:request", "document:delete:approve",
  "change:read", "change:write", "change:decide",
  "rebaseline:approve",
  "decision:read", "decision:write",
  "notification:read",
  "audit:read",
  "report:read",
  "assistant:read", "assistant:write",
  "saved_view:read", "saved_view:write",
] as const;

export type Scope = (typeof SCOPES)[number];

/**
 * Scopes that DECIDE a governed request (the "checker" half of every
 * maker-checker flow). Wildcards NEVER grant these (2026-10-16, D2): the
 * global `*` and any `<resource>:*` ("task:*", "project:*",
 * "change:*", "rebaseline:*") stop at the privileged boundary, so a
 * token that was handed a convenient wildcard to read and write a resource
 * cannot also approve its own work. A privileged scope must be granted by
 * its exact name, which makes every approver token a deliberate act.
 *
 * Enforced in hasScope() (auth/tokens.ts); the mint UI's wildcard choices
 * are unchanged, they simply no longer include these.
 */
export const PRIVILEGED_SCOPES: readonly Scope[] = [
  "task:delete:approve",
  "project:delete:approve",
  "risk:delete:approve",
  "issue:delete:approve",
  "expense:delete:approve",
  "document:delete:approve",
  "milestone:delete:approve",
  "change:decide",
  "rebaseline:approve",
];

/**
 * Deletion is a request for every governed record (audit gap G8, migration 0102):
 * DELETE /api/<entity>/:id raises a deletion request and a second person approves it.
 * `risk:delete` and `issue:delete` were the wave-1 scopes for a DIRECT hard delete; the
 * direct delete no longer exists, so they now mean "may request the deletion" and are
 * accepted wherever `<entity>:delete:request` is. Tokens minted with them keep working;
 * no token gains the right to approve. Look the scope up through requestDeleteScopes().
 */
export const LEGACY_DELETE_SCOPE_ALIASES: Readonly<Record<string, string>> = {
  "risk:delete": "risk:delete:request",
  "issue:delete": "issue:delete:request",
};

/** The scopes that let a caller REQUEST deletion of this entity (the new scope first, then any legacy alias). */
export function requestDeleteScopes(entity: string): string[] {
  const modern = `${entity}:delete:request`;
  return [modern, ...Object.entries(LEGACY_DELETE_SCOPE_ALIASES).filter(([, to]) => to === modern).map(([from]) => from)];
}

/** Resource prefixes that support a `<resource>:*` wildcard grant. */
export const SCOPE_RESOURCES: ReadonlySet<string> = new Set(
  SCOPES.map((s) => s.split(":")[0]),
);

const SCOPE_SET: ReadonlySet<string> = new Set(SCOPES);

// [a-z_]+ (not just [a-z]+) so an underscored resource name — e.g.
// saved_view — still supports a "<resource>:*" wildcard grant.
const WILDCARD = /^([a-z_]+):\*$/;

/**
 * True if `scope` is a known concrete scope, a `<resource>:*` wildcard for a
 * known resource, or the global `*`. Used to validate PAT scopes at mint time.
 */
export function isValidScope(scope: string): boolean {
  if (SCOPE_SET.has(scope)) return true;
  const m = scope.match(WILDCARD);
  return !!m && SCOPE_RESOURCES.has(m[1]);
}

/**
 * Least-privilege preset for the "Connect your agent" onboarding flow
 * (F1e / L-49) — every read scope in the registry plus `task:write`,
 * `risk:write`, `issue:write` and `project:write` (audit gap K4, CR-2026-10-18-01
 * A5), so a freshly-minted agent PAT can read the whole workspace and create/edit
 * tasks, risks, issues and projects but can never request/approve a deletion,
 * approve a rebaseline, decide a change request, or write anything else. It holds NO
 * delete scope: raising a deletion request for a risk or issue needs `risk:delete:request`
 * (or the older `risk:delete`; likewise for issues), none of which is in this preset, and
 * approving one needs the exact `<entity>:delete:approve`. `project:write` can LOCK a project, never unlock (Q-GOV-10). Derived from SCOPES (not hand-listed) so it can never drift
 * onto a scope the registry doesn't recognise; scopes.test.ts asserts the
 * least-privilege shape directly against this constant.
 */
export const AGENT_PRESET_SCOPES: readonly Scope[] = SCOPES.filter((s) =>
  s.endsWith(":read"),
).concat(["task:write", "risk:write", "issue:write", "project:write"]);

/**
 * Full scope choice list for the manual token-mint UI (tokens/page.tsx),
 * DERIVED from SCOPES — replaces a hand-curated list that silently drifted
 * out of sync as new resources (change/document/saved_view/assistant/
 * decision/program/sprint/milestone/notification, rebaseline:approve) were
 * added to the registry without a matching checkbox ever appearing.
 *
 * Grouped by resource, in registry order. A resource with MORE than one
 * concrete scope gets a `<resource>:*` wildcard choice first, followed by
 * every concrete scope for that resource; a resource with exactly one scope
 * (e.g. `notification:read`, `audit:read`, `rebaseline:approve`) gets no
 * wildcard — one scope already IS the whole resource, so a wildcard would
 * just be a second name for the same grant. `task:delete:request`/`approve`
 * and `project:delete:request`/`approve` fall out of this naturally as
 * explicit entries (they're concrete scopes on the `task`/`project`
 * resources, always listed alongside that resource's wildcard).
 *
 * scopes.test.ts asserts this covers every SCOPES entry either directly or
 * via its resource wildcard, so a future scope addition can never silently
 * fail to show up in the mint UI again.
 */
export function scopeChoices(): string[] {
  const byResource = new Map<string, Scope[]>();
  for (const scope of SCOPES) {
    const resource = scope.split(":")[0];
    const list = byResource.get(resource);
    if (list) list.push(scope);
    else byResource.set(resource, [scope]);
  }
  const choices: string[] = [];
  for (const scopesForResource of byResource.values()) {
    if (scopesForResource.length > 1) choices.push(`${scopesForResource[0].split(":")[0]}:*`);
    choices.push(...scopesForResource);
  }
  return choices;
}
