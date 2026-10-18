/**
 * FilterBar / GroupBySelect server-render smoke tests.
 *
 * No DOM environment exists in this repo, so these render to static markup and
 * check what the UI audit found broken: every toolbar control (search, selects,
 * the date range, group-by) was a sibling <label> with no `for`, so screen
 * readers announced "combo box" / "edit text" with no name.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { controlsIn, danglingLabels, unnamedControls } from "@/components/forms/a11y-markup";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, replace() {}, refresh() {} }),
  usePathname: () => "/tasks",
  useSearchParams: () => new URLSearchParams(),
}));

import { FilterBar } from "./filter-bar";
import { GroupBySelect } from "./group-by-select";
import {
  filterWritesReplaceHistory,
  applyControlsUpdate,
  type FilterFieldConfig,
} from "./use-list-controls";

const FIELDS: readonly FilterFieldConfig[] = [
  { key: "q", label: "Search", type: "text", placeholder: "Task name…" },
  { key: "status_type", label: "Status", type: "select", options: [{ value: "started", label: "Started" }] },
  { key: "due", label: "Due between", type: "date-range", fromKey: "due_after", toKey: "due_before" },
];

function render(values: Record<string, string> = {}, activeCount = 0) {
  return renderToStaticMarkup(
    createElement(FilterBar, { fields: FIELDS, values, onChange: () => {}, onClear: () => {}, activeCount }),
  );
}

describe("FilterBar labels", () => {
  const markup = render();

  it("names every control, and every label points at a real control", () => {
    expect(controlsIn(markup)).toHaveLength(4); // search, status, due from, due to
    expect(unnamedControls(markup)).toEqual([]);
    expect(danglingLabels(markup)).toEqual([]);
  });

  it("wires the visible text label to the search input and the select (click-to-focus, voice control)", () => {
    expect(markup).toMatch(/<label[^>]*for="([^"]+)"[^>]*>Search<\/label>/);
    expect(markup).toMatch(/<label[^>]*for="([^"]+)"[^>]*>Status<\/label>/);
  });

  it("groups the date range under its visible label", () => {
    const group = markup.match(/role="group"[^>]*aria-labelledby="([^"]+)"/);
    expect(group).not.toBeNull();
    expect(markup).toContain(`id="${group![1]}"`);
    expect(markup).toContain('aria-label="Due between from"');
    expect(markup).toContain('aria-label="Due between to"');
  });

  it("seeds the search box from the URL value", () => {
    expect(render({ q: "stakeholder" })).toContain('value="stakeholder"');
  });

  it("uses solid focus rings on selects (not the 1.5:1 translucent ring)", () => {
    expect(markup).toContain("focus-ring");
    expect(markup).not.toMatch(/ring-accent\//);
  });
});

describe("GroupBySelect label", () => {
  it("is a labelled select", () => {
    const markup = renderToStaticMarkup(
      createElement(GroupBySelect, {
        options: [{ value: "status", label: "Status" }],
        value: null,
        onChange: () => {},
      }),
    );
    expect(unnamedControls(markup)).toEqual([]);
    expect(danglingLabels(markup)).toEqual([]);
    expect(markup).toContain("Group by");
  });
});

describe("how filter writes reach the URL", () => {
  it("typing in a text filter replaces history (one Back press leaves the page, not 15 drafts)", () => {
    expect(filterWritesReplaceHistory(FIELDS[0])).toBe(true);
  });

  it("selects and date ranges are discrete choices and keep their history entries", () => {
    expect(filterWritesReplaceHistory(FIELDS[1])).toBe(false);
    expect(filterWritesReplaceHistory(FIELDS[2])).toBe(false);
  });

  it("a filter change resets paging but keeps unrelated params", () => {
    const next = applyControlsUpdate(new URLSearchParams("page=3&sort=name:asc&view=v1"), { q: "abc" });
    expect(next.get("q")).toBe("abc");
    expect(next.get("page")).toBeNull();
    expect(next.get("sort")).toBe("name:asc");
    expect(next.get("view")).toBe("v1");
  });
});
