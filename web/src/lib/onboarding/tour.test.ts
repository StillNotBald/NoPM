import { describe, it, expect } from "vitest";
import {
  tourItems,
  shouldShowTour,
  isVisited,
  markVisited,
  dismissTour,
  MAX_VISITED,
} from "./tour";

describe("tourItems — 5 deep-link stops", () => {
  it("returns exactly 5 items with unique ids", () => {
    const items = tourItems();
    expect(items).toHaveLength(5);
    expect(new Set(items.map((i) => i.id)).size).toBe(5);
  });

  it("falls back to /projects for stop 4 when no project href is given", () => {
    const items = tourItems();
    const projectStop = items.find((i) => i.id === "project-lock");
    expect(projectStop?.href).toBe("/projects");
  });

  it("uses the given first-project href for stop 4 when provided", () => {
    const items = tourItems("/projects/abc-123");
    const projectStop = items.find((i) => i.id === "project-lock");
    expect(projectStop?.href).toBe("/projects/abc-123");
  });

  it("every item has a non-empty title, caption, and href", () => {
    for (const item of tourItems()) {
      expect(item.title.length).toBeGreaterThan(0);
      expect(item.caption.length).toBeGreaterThan(0);
      expect(item.href.length).toBeGreaterThan(0);
    }
  });
});

describe("shouldShowTour — dismissal is terminal", () => {
  it("shows for a brand new user with no tour state yet", () => {
    expect(shouldShowTour(undefined)).toBe(true);
  });

  it("shows when state exists but nothing has been dismissed", () => {
    expect(shouldShowTour({ visited: ["trust-center"] })).toBe(true);
  });

  it("hides once dismissed", () => {
    expect(shouldShowTour({ dismissed: true })).toBe(false);
  });
});

describe("isVisited", () => {
  it("false when state is undefined", () => {
    expect(isVisited(undefined, "trust-center")).toBe(false);
  });

  it("false when the item id isn't in the visited array", () => {
    expect(isVisited({ visited: ["review-queue"] }, "trust-center")).toBe(false);
  });

  it("true when the item id is in the visited array", () => {
    expect(isVisited({ visited: ["trust-center", "review-queue"] }, "trust-center")).toBe(true);
  });
});

describe("markVisited", () => {
  it("adds a new item id to an empty/undefined state", () => {
    expect(markVisited(undefined, "trust-center")).toEqual({ visited: ["trust-center"] });
  });

  it("appends without duplicating an existing id", () => {
    const state = { visited: ["trust-center"] };
    const next = markVisited(state, "trust-center");
    expect(next.visited).toEqual(["trust-center"]);
  });

  it("preserves dismissed alongside a new visit", () => {
    const next = markVisited({ dismissed: false, visited: ["trust-center"] }, "review-queue");
    expect(next).toEqual({ dismissed: false, visited: ["trust-center", "review-queue"] });
  });

  it("caps the visited array at MAX_VISITED, evicting oldest first", () => {
    const bloated = Array.from({ length: MAX_VISITED }, (_, i) => `item-${i}`);
    const next = markVisited({ visited: bloated }, "new-item");
    expect(next.visited).toHaveLength(MAX_VISITED);
    expect(next.visited).not.toContain("item-0");
    expect(next.visited).toContain("new-item");
  });
});

describe("dismissTour", () => {
  it("sets dismissed without disturbing an existing visited array", () => {
    expect(dismissTour({ visited: ["trust-center"] })).toEqual({
      visited: ["trust-center"],
      dismissed: true,
    });
  });

  it("works from undefined state", () => {
    expect(dismissTour(undefined)).toEqual({ dismissed: true });
  });
});
