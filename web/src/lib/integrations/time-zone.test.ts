import { describe, it, expect } from "vitest";
import { DEFAULT_TIME_ZONE, isValidTimeZone, resolveTimeZone, shiftToZone, todayInZone } from "./time-zone";
import { digestDue } from "./cron";

describe("workspace time zone", () => {
  it("defaults to Malaysia", () => expect(DEFAULT_TIME_ZONE).toBe("Asia/Kuala_Lumpur"));
  it("validates IANA names and falls back", () => {
    expect(isValidTimeZone("Asia/Kuala_Lumpur")).toBe(true);
    expect(isValidTimeZone("Mars/Base")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(resolveTimeZone("nope")).toBe(DEFAULT_TIME_ZONE);
  });
  it("today differs from UTC late in the evening UTC", () => {
    const now = new Date("2026-10-18T20:00:00Z"); // 04:00 on the 19th in KL
    expect(todayInZone("UTC", now)).toBe("2026-10-18");
    expect(todayInZone("Asia/Kuala_Lumpur", now)).toBe("2026-10-19");
  });
  it("shiftToZone exposes wall-clock fields as UTC", () => {
    expect(shiftToZone(new Date("2026-10-18T20:00:00Z"), "Asia/Kuala_Lumpur").toISOString()).toBe("2026-10-19T04:00:00.000Z");
  });
  it("digestDue uses the workspace weekday: Sunday 20:00Z is already Monday in KL", () => {
    const connector = { updated_at: "2026-09-01T00:00:00Z" };
    const sundayEvening = new Date("2026-10-18T20:00:00Z");
    expect(digestDue(connector, 1, sundayEvening)).not.toBe("today"); // UTC view: Sunday
    expect(digestDue(connector, 1, sundayEvening, "Asia/Kuala_Lumpur")).toBe("today");
  });
});
