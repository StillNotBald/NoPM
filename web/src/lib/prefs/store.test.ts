import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { apiGet, apiPut } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPut: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({ apiGet, apiPut }));

import {
  getPrefsSnapshot,
  loadPreferences,
  subscribePreferences,
  updatePreferences,
  resetPreferencesStore,
} from "./store";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  resetPreferencesStore();
  apiGet.mockReset();
  apiPut.mockReset();
  apiPut.mockResolvedValue({});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadPreferences — one GET per session, shared by every caller", () => {
  it("dedupes concurrent callers onto a single in-flight GET", async () => {
    const d = deferred<{ config: object; demo: boolean; updatedAt: string | null }>();
    apiGet.mockReturnValue(d.promise);

    const a = loadPreferences();
    const b = loadPreferences();
    const c = loadPreferences();
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(getPrefsSnapshot().status).toBe("loading");

    d.resolve({ config: { density: "compact" }, demo: false, updatedAt: "2026-09-04T00:00:00Z" });
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect(ra).toBe(rb);
    expect(rb).toBe(rc);
    expect(ra.status).toBe("ready");
    expect(ra.config).toEqual({ density: "compact" });
    expect(ra.updatedAt).toBe("2026-09-04T00:00:00Z");
  });

  it("serves later calls from cache without another GET", async () => {
    apiGet.mockResolvedValue({ config: {}, demo: false, updatedAt: null });
    await loadPreferences();
    await loadPreferences();
    await loadPreferences();
    expect(apiGet).toHaveBeenCalledTimes(1);
  });

  it("a failed GET yields status error with an empty config and is NOT cached (next call retries)", async () => {
    apiGet.mockRejectedValueOnce(new Error("401"));
    const first = await loadPreferences();
    expect(first.status).toBe("error");
    expect(first.config).toEqual({});

    apiGet.mockResolvedValueOnce({ config: { density: "compact" }, demo: true, updatedAt: null });
    const second = await loadPreferences();
    expect(second.status).toBe("ready");
    expect(second.demo).toBe(true);
    expect(apiGet).toHaveBeenCalledTimes(2);
  });

  it("notifies subscribers on every transition and stops after unsubscribe", async () => {
    apiGet.mockResolvedValue({ config: {}, demo: false, updatedAt: null });
    const listener = vi.fn();
    const unsubscribe = subscribePreferences(listener);
    await loadPreferences(); // idle→loading→ready = 2 emits
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    await updatePreferences({ density: "compact" });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("updatePreferences — optimistic local merge + fail-soft PUT of the partial", () => {
  it("merges locally with the server's semantics (top-level override, columns per register) and PUTs only the partial", async () => {
    apiGet.mockResolvedValue({
      config: { columns: { tasks: ["name"] }, density: "comfortable", nav: { mode: "all" } },
      demo: false,
      updatedAt: "x",
    });
    await loadPreferences();

    await updatePreferences({ columns: { risks: ["title"] }, hints: { dismissed: ["risks"] } });

    expect(getPrefsSnapshot().config).toEqual({
      columns: { tasks: ["name"], risks: ["title"] },
      density: "comfortable",
      nav: { mode: "all" },
      hints: { dismissed: ["risks"] },
    });
    expect(apiPut).toHaveBeenCalledTimes(1);
    expect(apiPut).toHaveBeenCalledWith("/api/me/preferences", {
      config: { columns: { risks: ["title"] }, hints: { dismissed: ["risks"] } },
    });
  });

  it("never PUTs for the shared demo identity — local state only", async () => {
    apiGet.mockResolvedValue({ config: {}, demo: true, updatedAt: null });
    await loadPreferences();
    await updatePreferences({ nav: { mode: "all" } });
    expect(getPrefsSnapshot().config).toEqual({ nav: { mode: "all" } });
    expect(apiPut).not.toHaveBeenCalled();
  });

  it("keeps the optimistic state and warns (does not throw) when the PUT fails", async () => {
    apiGet.mockResolvedValue({ config: {}, demo: false, updatedAt: null });
    apiPut.mockRejectedValueOnce(new Error("500"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await loadPreferences();
    await expect(updatePreferences({ density: "compact" })).resolves.toBeUndefined();
    await Promise.resolve(); // let the rejected PUT settle
    expect(getPrefsSnapshot().config).toEqual({ density: "compact" });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("resolves as soon as local state is updated, before the PUT completes", async () => {
    apiGet.mockResolvedValue({ config: {}, demo: false, updatedAt: null });
    await loadPreferences();
    const d = deferred<object>();
    apiPut.mockReturnValue(d.promise);
    await updatePreferences({ density: "compact" }); // must not hang on the pending PUT
    expect(getPrefsSnapshot().config.density).toBe("compact");
    d.resolve({});
  });
});
