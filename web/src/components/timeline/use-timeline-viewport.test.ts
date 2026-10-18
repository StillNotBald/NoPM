import { describe, expect, it } from "vitest";
import { TODAY_PILL_ROOM_PX, todayOpenScrollLeft } from "./use-timeline-viewport";
import { scrollLeftForToday } from "@/lib/timeline/scale";

describe("todayOpenScrollLeft", () => {
  it("matches the plain lead-in when the window is wide (desktop)", () => {
    // 14px/day, 754px window: the 196px lead is well inside the window
    expect(todayOpenScrollLeft(1969, 754, 2702, 14)).toBe(scrollLeftForToday(1969, 754, 2702, 14));
  });

  it("keeps today's pill on screen in a phone window", () => {
    // phone: ~190px beside the rail, so the 196px lead put today off the right edge
    const viewport = 190;
    const left = todayOpenScrollLeft(1969, viewport, 2702, 14);
    const pillStart = 1969 - left;
    expect(pillStart).toBeGreaterThanOrEqual(0);
    expect(pillStart + TODAY_PILL_ROOM_PX).toBeLessThanOrEqual(viewport);
  });

  it("still clamps to the scrollable range", () => {
    expect(todayOpenScrollLeft(50, 190, 2702, 14)).toBe(0); // today near the start
    expect(todayOpenScrollLeft(2700, 190, 2702, 14)).toBe(2702 - 190); // never past content - window
    expect(todayOpenScrollLeft(500, 900, 600, 14)).toBe(0); // content narrower than window
  });

  it("does not go negative for a window narrower than the pill", () => {
    expect(todayOpenScrollLeft(1000, 40, 2702, 14)).toBe(1000);
  });
});
