import { describe, expect, it } from "vitest";
import { bodyPreview } from "./charter-preview";

describe("bodyPreview", () => {
  it("drops heading lines instead of fusing them into the prose", () => {
    const body = "# Customer Data Platform\n\n## Purpose\nAuthorises the build of a unified customer profile.\n";
    expect(bodyPreview(body)).toBe("Authorises the build of a unified customer profile.");
  });

  it("strips list markers, bold, code ticks and link syntax", () => {
    const body = "- **Scope:** `CDP` ingestion\n2. See [the plan](https://example.test/plan)";
    expect(bodyPreview(body)).toBe("Scope: CDP ingestion See the plan");
  });

  it("truncates with an ellipsis at maxLen", () => {
    const p = bodyPreview("word ".repeat(100), 20);
    expect(p?.length).toBe(21);
    expect(p?.endsWith("…")).toBe(true);
  });

  it("returns null for empty, whitespace-only and heading-only bodies", () => {
    expect(bodyPreview(null)).toBeNull();
    expect(bodyPreview("   \n ")).toBeNull();
    expect(bodyPreview("# Only a title\n## And a subtitle")).toBeNull();
  });
});
