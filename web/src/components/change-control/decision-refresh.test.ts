/**
 * Source guard: after a 412 / already_decided refusal, Refresh must close the
 * inspector (as DecisionFlow does). The inspector body is a frozen ReactNode
 * snapshot, so router.refresh() alone leaves expectedUpdatedAt stale and every
 * retry 412s again.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(join(process.cwd(), "src", rel), "utf8");

describe("DecisionPanel refresh", () => {
  it("DecisionPanel delegates Refresh to the caller's onRefresh", () => {
    const src = read("components/change-control/change-detail.tsx");
    expect(src).toMatch(/onRefresh\?: \(\) => void/);
    expect(src).toMatch(/if \(onRefresh\) onRefresh\(\);/);
  });

  it.each([
    ["components/change-control/change-detail.tsx"],
    ["components/review/inline-action.tsx"],
  ])("%s closes the inspector on refresh and passes it to DecisionPanel", (rel) => {
    const src = read(rel);
    expect(src).toMatch(/function handleRefreshRecord\(\) \{\s*inspector\.close\(\);\s*router\.refresh\(\);\s*\}/);
    expect(src).toContain("onRefresh={handleRefreshRecord}");
  });
});
