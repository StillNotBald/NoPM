/**
 * MRU-store tests for the recent-projects nav list.
 *
 * The module talks to the bare `localStorage` global and guards on
 * `typeof window === "undefined"` for SSR. The vitest environment is "node"
 * (no jsdom), so both globals are stubbed here with a minimal in-memory fake —
 * which also lets the SSR guard itself be tested by removing `window`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getRecentProjects, addRecentProject, type RecentProject } from "./recent-projects";

const STORAGE_KEY = "nopm.nav.recent-projects";
const MAX = 6;

// ---------------------------------------------------------------------------
// Minimal in-memory localStorage fake (node env — no jsdom)
// ---------------------------------------------------------------------------
class FakeStorage {
  private map = new Map<string, string>();
  /** When set, setItem throws this — used to simulate a quota error. */
  throwOnSet: Error | null = null;

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    if (this.throwOnSet) throw this.throwOnSet;
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
  get length(): number {
    return this.map.size;
  }
}

const g = globalThis as unknown as {
  window?: unknown;
  localStorage?: unknown;
};

let store: FakeStorage;

beforeEach(() => {
  store = new FakeStorage();
  g.localStorage = store;
  g.window = { localStorage: store }; // satisfies the `typeof window === "undefined"` guard
});

afterEach(() => {
  delete g.localStorage;
  delete g.window;
});

const project = (n: number): RecentProject => ({
  id: `id-${n}`,
  name: `Project ${n}`,
  code: `P-${n}`,
});

/** Read the raw persisted JSON (bypassing the module) for write-side assertions. */
function raw(): string | null {
  return store.getItem(STORAGE_KEY);
}

// ---------------------------------------------------------------------------
// Empty / first-write behaviour
// ---------------------------------------------------------------------------
describe("getRecentProjects — empty store", () => {
  it("returns an empty array when nothing has been stored", () => {
    expect(getRecentProjects()).toEqual([]);
  });

  it("returns an empty array when the key holds an empty string", () => {
    store.setItem(STORAGE_KEY, "");
    expect(getRecentProjects()).toEqual([]);
  });

  it("returns a real array (callers may map/spread it safely)", () => {
    expect(Array.isArray(getRecentProjects())).toBe(true);
  });
});

describe("addRecentProject — first write", () => {
  it("persists a single entry under the namespaced storage key", () => {
    addRecentProject(project(1));
    expect(raw()).toBe(JSON.stringify([project(1)]));
  });

  it("round-trips through getRecentProjects", () => {
    addRecentProject(project(1));
    expect(getRecentProjects()).toEqual([project(1)]);
  });

  it("preserves all three fields (id, name, code)", () => {
    addRecentProject({ id: "x", name: "Harbour Rail", code: "HR-01" });
    expect(getRecentProjects()[0]).toEqual({ id: "x", name: "Harbour Rail", code: "HR-01" });
  });
});

// ---------------------------------------------------------------------------
// Ordering — newest first
// ---------------------------------------------------------------------------
describe("addRecentProject — ordering", () => {
  it("puts the most recently added project first", () => {
    addRecentProject(project(1));
    addRecentProject(project(2));
    expect(getRecentProjects().map((p) => p.id)).toEqual(["id-2", "id-1"]);
  });

  it("keeps strict newest-first order across several adds", () => {
    for (let n = 1; n <= 4; n++) addRecentProject(project(n));
    expect(getRecentProjects().map((p) => p.id)).toEqual(["id-4", "id-3", "id-2", "id-1"]);
  });
});

// ---------------------------------------------------------------------------
// Dedupe by id
// ---------------------------------------------------------------------------
describe("addRecentProject — dedupe by id", () => {
  it("does not store the same id twice", () => {
    addRecentProject(project(1));
    addRecentProject(project(2));
    addRecentProject(project(1));
    const ids = getRecentProjects().map((p) => p.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("re-adding an existing project promotes it to the front", () => {
    addRecentProject(project(1));
    addRecentProject(project(2));
    addRecentProject(project(3));
    addRecentProject(project(1));
    expect(getRecentProjects().map((p) => p.id)).toEqual(["id-1", "id-3", "id-2"]);
  });

  it("re-adding with the same id but new name/code overwrites the stale copy", () => {
    addRecentProject({ id: "id-1", name: "Old Name", code: "OLD" });
    addRecentProject({ id: "id-1", name: "New Name", code: "NEW" });
    expect(getRecentProjects()).toEqual([{ id: "id-1", name: "New Name", code: "NEW" }]);
  });

  it("dedupe is exact-match on id (similar ids are distinct entries)", () => {
    addRecentProject({ id: "abc", name: "A", code: "A" });
    addRecentProject({ id: "abcd", name: "B", code: "B" });
    expect(getRecentProjects().map((p) => p.id)).toEqual(["abcd", "abc"]);
  });
});

// ---------------------------------------------------------------------------
// Cap at MAX entries
// ---------------------------------------------------------------------------
describe("addRecentProject — cap", () => {
  it(`stores at most ${MAX} entries`, () => {
    for (let n = 1; n <= 10; n++) addRecentProject(project(n));
    expect(getRecentProjects()).toHaveLength(MAX);
  });

  it("drops the oldest entry when the cap is exceeded", () => {
    for (let n = 1; n <= 7; n++) addRecentProject(project(n));
    const ids = getRecentProjects().map((p) => p.id);
    expect(ids).toEqual(["id-7", "id-6", "id-5", "id-4", "id-3", "id-2"]);
    expect(ids).not.toContain("id-1");
  });

  it("exactly MAX adds keeps every entry", () => {
    for (let n = 1; n <= MAX; n++) addRecentProject(project(n));
    expect(getRecentProjects()).toHaveLength(MAX);
    expect(getRecentProjects()[MAX - 1].id).toBe("id-1");
  });

  it("re-adding an existing project at the cap does not evict a different project", () => {
    for (let n = 1; n <= MAX; n++) addRecentProject(project(n));
    addRecentProject(project(1)); // already present — promotion, not insertion
    const ids = getRecentProjects().map((p) => p.id);
    expect(ids).toHaveLength(MAX);
    expect(ids[0]).toBe("id-1");
    expect(new Set(ids).size).toBe(MAX);
  });

  it("truncates an over-long list that was already persisted, on the next add", () => {
    const oversized = Array.from({ length: 20 }, (_, i) => project(i + 100));
    store.setItem(STORAGE_KEY, JSON.stringify(oversized));
    addRecentProject(project(1));
    expect(getRecentProjects()).toHaveLength(MAX);
    expect(getRecentProjects()[0].id).toBe("id-1");
  });

  it("getRecentProjects returns an over-long persisted list as-is (cap applies on write only)", () => {
    const oversized = Array.from({ length: 20 }, (_, i) => project(i + 100));
    store.setItem(STORAGE_KEY, JSON.stringify(oversized));
    expect(getRecentProjects()).toHaveLength(20);
  });
});

// ---------------------------------------------------------------------------
// Corrupt / hostile storage contents
// ---------------------------------------------------------------------------
describe("getRecentProjects — corrupt storage resilience", () => {
  it("returns [] for malformed JSON instead of throwing", () => {
    store.setItem(STORAGE_KEY, "{not json at all");
    expect(() => getRecentProjects()).not.toThrow();
    expect(getRecentProjects()).toEqual([]);
  });

  it("returns [] for a truncated JSON array", () => {
    store.setItem(STORAGE_KEY, '[{"id":"a","name":');
    expect(getRecentProjects()).toEqual([]);
  });

  it("returns [] when the stored value is a JSON object, not an array", () => {
    store.setItem(STORAGE_KEY, JSON.stringify({ id: "a", name: "A", code: "A" }));
    expect(getRecentProjects()).toEqual([]);
  });

  it("returns [] when the stored value is JSON null", () => {
    store.setItem(STORAGE_KEY, "null");
    expect(getRecentProjects()).toEqual([]);
  });

  it("returns [] when the stored value is a JSON string or number", () => {
    store.setItem(STORAGE_KEY, '"a string"');
    expect(getRecentProjects()).toEqual([]);
    store.setItem(STORAGE_KEY, "42");
    expect(getRecentProjects()).toEqual([]);
  });

  it("passes through array items without shape validation (documented gap)", () => {
    // read() casts the parsed array to RecentProject[] with no per-item check,
    // so garbage entries survive. Consumers must tolerate missing fields.
    store.setItem(STORAGE_KEY, JSON.stringify([{ nope: true }, null, 7]));
    expect(getRecentProjects()).toEqual([{ nope: true }, null, 7]);
  });

  it("recovers on the next write after corrupt JSON — the bad value is replaced", () => {
    store.setItem(STORAGE_KEY, "###");
    addRecentProject(project(1));
    expect(getRecentProjects()).toEqual([project(1)]);
    expect(raw()).toBe(JSON.stringify([project(1)]));
  });

  it("does not throw when getItem itself throws (storage disabled)", () => {
    store.setItem(STORAGE_KEY, JSON.stringify([project(1)]));
    const throwingGet = () => {
      throw new Error("SecurityError: storage is disabled");
    };
    const original = store.getItem.bind(store);
    store.getItem = throwingGet as unknown as typeof store.getItem;
    try {
      expect(getRecentProjects()).toEqual([]);
    } finally {
      store.getItem = original;
    }
  });
});

// ---------------------------------------------------------------------------
// Write failures (quota) are swallowed
// ---------------------------------------------------------------------------
describe("addRecentProject — write failures", () => {
  it("swallows a quota error instead of throwing at the caller", () => {
    store.throwOnSet = new Error("QuotaExceededError");
    expect(() => addRecentProject(project(1))).not.toThrow();
  });

  it("leaves the previous list intact when the write fails", () => {
    addRecentProject(project(1));
    store.throwOnSet = new Error("QuotaExceededError");
    addRecentProject(project(2));
    expect(getRecentProjects()).toEqual([project(1)]);
  });
});

// ---------------------------------------------------------------------------
// SSR guard — no window
// ---------------------------------------------------------------------------
describe("SSR guard — window undefined", () => {
  it("getRecentProjects returns [] on the server", () => {
    store.setItem(STORAGE_KEY, JSON.stringify([project(1)]));
    delete g.window;
    expect(getRecentProjects()).toEqual([]);
  });

  it("addRecentProject is a no-op on the server (no localStorage touch)", () => {
    delete g.window;
    expect(() => addRecentProject(project(1))).not.toThrow();
    expect(raw()).toBeNull();
  });
});
