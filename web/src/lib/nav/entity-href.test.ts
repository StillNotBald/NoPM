/**
 * Deep-link invariant tests for entityHref + FOCUS_PARAM.
 * entityHref is the single source of truth for "where does clicking an entity go?",
 * shared by the web UI and server routes (e.g. /api/search) — a wrong href here is
 * a broken link everywhere at once.
 */
import { describe, it, expect } from "vitest";
import { entityHref, FOCUS_PARAM, type EntityKind } from "./entity-href";

// Every kind in the EntityKind union. Kept as a literal list (not derived) so
// that adding a kind to the union without updating the tests shows up as a
// missing-case failure rather than silently passing.
const ALL_KINDS: EntityKind[] = [
  "project",
  "task",
  "milestone",
  "program",
  "sprint",
  "risk",
  "issue",
  "clash",
  "decision",
  "change_request",
  "document",
];

const ID = "11111111-2222-3333-4444-555555555555";
const PROJECT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

// ---------------------------------------------------------------------------
// Per-kind hrefs — project-scoped entities
// ---------------------------------------------------------------------------
describe("entityHref — project-scoped kinds", () => {
  it("project routes to /projects/<id>", () => {
    expect(entityHref("project", { id: ID })).toBe(`/projects/${ID}`);
  });

  it("project ignores projectId (the id IS the project)", () => {
    expect(entityHref("project", { id: ID, projectId: PROJECT_ID })).toBe(`/projects/${ID}`);
  });

  it("task routes into its project with ?task=<id>", () => {
    expect(entityHref("task", { id: ID, projectId: PROJECT_ID })).toBe(
      `/projects/${PROJECT_ID}?task=${ID}`,
    );
  });

  it("milestone routes into its project with ?milestone=<id>", () => {
    expect(entityHref("milestone", { id: ID, projectId: PROJECT_ID })).toBe(
      `/projects/${PROJECT_ID}?milestone=${ID}`,
    );
  });
});

// ---------------------------------------------------------------------------
// program — T3 (F2c-mini): fragment deep link (matches the portfolio page's
// actual <section id={program.id}> anchor, not a query param)
// ---------------------------------------------------------------------------
describe("entityHref — program (T3, F2c-mini)", () => {
  it("routes to /portfolio#<id> (fragment, matching the page's real anchor)", () => {
    expect(entityHref("program", { id: ID })).toBe(`/portfolio#${ID}`);
  });

  it("ignores projectId (program is not project-scoped)", () => {
    expect(entityHref("program", { id: ID, projectId: PROJECT_ID })).toBe(
      entityHref("program", { id: ID }),
    );
  });
});

// ---------------------------------------------------------------------------
// Per-kind hrefs — register entities (focus query param)
// ---------------------------------------------------------------------------
describe("entityHref — register kinds carry a focus query param", () => {
  it("sprint routes to /sprints?sprint=<id>", () => {
    expect(entityHref("sprint", { id: ID })).toBe(`/sprints?sprint=${ID}`);
  });

  it("risk routes to /risks?risk=<id>", () => {
    expect(entityHref("risk", { id: ID })).toBe(`/risks?risk=${ID}`);
  });

  it("issue routes to /issues?issue=<id>", () => {
    expect(entityHref("issue", { id: ID })).toBe(`/issues?issue=${ID}`);
  });

  it("clash routes to /clashes?clash=<id>", () => {
    expect(entityHref("clash", { id: ID })).toBe(`/clashes?clash=${ID}`);
  });

  it("decision routes to /decisions?dec=<id> (abbreviated param)", () => {
    expect(entityHref("decision", { id: ID })).toBe(`/decisions?dec=${ID}`);
  });

  it("change_request routes to /change-control?cr=<id> (kebab path, abbreviated param)", () => {
    expect(entityHref("change_request", { id: ID })).toBe(`/change-control?cr=${ID}`);
  });

  it("document routes to /documents?doc=<id> (abbreviated param)", () => {
    expect(entityHref("document", { id: ID })).toBe(`/documents?doc=${ID}`);
  });

  it("register kinds ignore projectId entirely", () => {
    for (const kind of ["sprint", "risk", "issue", "clash", "decision", "change_request", "document"] as const) {
      expect(entityHref(kind, { id: ID, projectId: PROJECT_ID })).toBe(
        entityHref(kind, { id: ID }),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Missing / null projectId fallbacks
// ---------------------------------------------------------------------------
describe("entityHref — projectId fallbacks", () => {
  it("task with no projectId falls back to /my-tasks", () => {
    expect(entityHref("task", { id: ID })).toBe("/my-tasks");
  });

  it("task with null projectId falls back to /my-tasks", () => {
    expect(entityHref("task", { id: ID, projectId: null })).toBe("/my-tasks");
  });

  it("task with an empty-string projectId falls back to /my-tasks (empty string is falsy)", () => {
    expect(entityHref("task", { id: ID, projectId: "" })).toBe("/my-tasks");
  });

  it("milestone with no projectId falls back to the /projects index", () => {
    expect(entityHref("milestone", { id: ID })).toBe("/projects");
  });

  it("milestone with null projectId falls back to the /projects index", () => {
    expect(entityHref("milestone", { id: ID, projectId: null })).toBe("/projects");
  });

  it("milestone with an empty-string projectId falls back to the /projects index", () => {
    expect(entityHref("milestone", { id: ID, projectId: "" })).toBe("/projects");
  });

  it("fallback hrefs carry no id — they are index pages, not deep links", () => {
    expect(entityHref("task", { id: ID, projectId: null })).not.toContain(ID);
    expect(entityHref("milestone", { id: ID, projectId: null })).not.toContain(ID);
  });
});

// ---------------------------------------------------------------------------
// Total coverage of the EntityKind union
// ---------------------------------------------------------------------------
describe("entityHref — every EntityKind is handled", () => {
  it("returns a non-empty string for all 11 kinds", () => {
    expect(ALL_KINDS).toHaveLength(11);
    for (const kind of ALL_KINDS) {
      const href = entityHref(kind, { id: ID, projectId: PROJECT_ID });
      expect(typeof href, `${kind} must return a string`).toBe("string");
      expect(href.length, `${kind} must not return an empty href`).toBeGreaterThan(0);
    }
  });

  it("every href is an absolute app path (leading slash, no protocol)", () => {
    for (const kind of ALL_KINDS) {
      const href = entityHref(kind, { id: ID, projectId: PROJECT_ID });
      expect(href.startsWith("/"), `${kind} → ${href}`).toBe(true);
      expect(href).not.toMatch(/^\/\//); // not a protocol-relative external URL
      expect(href).not.toContain("://");
    }
  });

  it("never returns undefined even when projectId is absent (exhaustive switch)", () => {
    for (const kind of ALL_KINDS) {
      expect(entityHref(kind, { id: ID }), `${kind} with no projectId`).toBeDefined();
    }
  });

  it("all kinds produce distinct hrefs for the same id (no route collisions)", () => {
    const hrefs = ALL_KINDS.map((k) => entityHref(k, { id: ID, projectId: PROJECT_ID }));
    expect(new Set(hrefs).size).toBe(ALL_KINDS.length);
  });
});

// ---------------------------------------------------------------------------
// FOCUS_PARAM registry
// ---------------------------------------------------------------------------
describe("FOCUS_PARAM — registry completeness", () => {
  // project / task / milestone / program are deliberately excluded from
  // FOCUS_PARAM: project has its own page, task/milestone use
  // ?task=/?milestone= on the project page rather than a register-page
  // focus param, and program deep-links via a URL FRAGMENT (#<id>) into the
  // portfolio page rather than a query param (T3, F2c-mini).
  const EXCLUDED: EntityKind[] = ["project", "task", "milestone", "program"];
  const REGISTER_KINDS = ALL_KINDS.filter((k) => !EXCLUDED.includes(k));

  it("has an entry for every register kind and nothing else", () => {
    expect(Object.keys(FOCUS_PARAM).sort()).toEqual([...REGISTER_KINDS].sort());
  });

  it("documents the absence of a focus param for project/task/milestone", () => {
    for (const kind of EXCLUDED) {
      expect(FOCUS_PARAM as Record<string, string>).not.toHaveProperty(kind);
    }
  });

  it("maps each register kind to the exact param entityHref emits", () => {
    for (const kind of REGISTER_KINDS) {
      const param = (FOCUS_PARAM as Record<string, string>)[kind];
      const href = entityHref(kind, { id: ID });
      expect(href, `${kind} href must use ?${param}=`).toContain(`?${param}=${ID}`);
    }
  });

  it("every focus param is a non-empty URL-safe token", () => {
    for (const param of Object.values(FOCUS_PARAM)) {
      expect(param).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("focus param names are unique across kinds", () => {
    const values = Object.values(FOCUS_PARAM);
    expect(new Set(values).size).toBe(values.length);
  });
});
