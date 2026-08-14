import { describe, it, expect } from "vitest";
import { ragLabel, ragTone, type RagStatus, type Tone } from "./status";

// ---------------------------------------------------------------------------
// The five canonical statuses, in enum order.
// ---------------------------------------------------------------------------
const ALL_STATUSES: RagStatus[] = ["not_started", "red", "amber", "green", "complete"];

// ---------------------------------------------------------------------------
// ragLabel
// ---------------------------------------------------------------------------
describe("ragLabel — canonical statuses", () => {
  it("maps green to 'On track'", () => {
    expect(ragLabel("green")).toBe("On track");
  });

  it("maps amber to 'At risk'", () => {
    expect(ragLabel("amber")).toBe("At risk");
  });

  it("maps red to 'Delayed'", () => {
    expect(ragLabel("red")).toBe("Delayed");
  });

  it("maps complete to 'Complete'", () => {
    expect(ragLabel("complete")).toBe("Complete");
  });

  it("maps not_started to 'In progress' (it shares the default branch)", () => {
    expect(ragLabel("not_started")).toBe("In progress");
  });

  it("never returns the raw enum value for a known status", () => {
    for (const s of ALL_STATUSES) {
      expect(ragLabel(s)).not.toBe(s);
    }
  });
});

describe("ragLabel — unknown / default branch", () => {
  it("falls back to 'In progress' for an unrecognised status", () => {
    expect(ragLabel("purple")).toBe("In progress");
    expect(ragLabel("in_review")).toBe("In progress");
  });

  it("falls back for empty and whitespace strings", () => {
    expect(ragLabel("")).toBe("In progress");
    expect(ragLabel("   ")).toBe("In progress");
  });

  it("is case-sensitive — a mis-cased status falls through to the default", () => {
    expect(ragLabel("GREEN")).toBe("In progress");
    expect(ragLabel("Green")).toBe("In progress");
  });

  it("does not trim — a padded status falls through to the default", () => {
    expect(ragLabel(" green ")).toBe("In progress");
  });

  it("survives null/undefined reaching it at runtime", () => {
    expect(ragLabel(null as unknown as string)).toBe("In progress");
    expect(ragLabel(undefined as unknown as string)).toBe("In progress");
  });

  it("always returns a non-empty string", () => {
    for (const s of [...ALL_STATUSES, "nonsense", ""]) {
      expect(ragLabel(s).length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// ragTone
// ---------------------------------------------------------------------------
describe("ragTone — canonical statuses", () => {
  it("maps green to success", () => {
    expect(ragTone("green")).toBe("success");
  });

  it("maps complete to success as well (both render green)", () => {
    expect(ragTone("complete")).toBe("success");
    expect(ragTone("complete")).toBe(ragTone("green"));
  });

  it("maps amber to warning", () => {
    expect(ragTone("amber")).toBe("warning");
  });

  it("maps red to danger", () => {
    expect(ragTone("red")).toBe("danger");
  });

  it("maps not_started to info (shares the default branch)", () => {
    expect(ragTone("not_started")).toBe("info");
  });

  it("only ever emits tones from the Tone union", () => {
    const valid: Tone[] = ["neutral", "accent", "info", "success", "warning", "danger"];
    for (const s of ALL_STATUSES) {
      expect(valid).toContain(ragTone(s));
    }
  });

  it("never emits 'neutral' or 'accent' for a project status", () => {
    for (const s of ALL_STATUSES) {
      expect(["neutral", "accent"]).not.toContain(ragTone(s));
    }
  });
});

describe("ragTone — unknown / default branch", () => {
  it("falls back to info for an unrecognised status", () => {
    expect(ragTone("purple")).toBe("info");
    expect(ragTone("blocked")).toBe("info");
  });

  it("falls back to info for empty strings and mis-cased values", () => {
    expect(ragTone("")).toBe("info");
    expect(ragTone("RED")).toBe("info");
  });

  it("survives null/undefined reaching it at runtime", () => {
    expect(ragTone(null as unknown as string)).toBe("info");
    expect(ragTone(undefined as unknown as string)).toBe("info");
  });
});

// ---------------------------------------------------------------------------
// Cross-consistency — a badge shows one label and one tone together
// ---------------------------------------------------------------------------
describe("ragLabel + ragTone agree", () => {
  it("pairs every canonical status into a stable label/tone badge", () => {
    const pairs = ALL_STATUSES.map((s) => [s, ragLabel(s), ragTone(s)]);
    expect(pairs).toEqual([
      ["not_started", "In progress", "info"],
      ["red", "Delayed", "danger"],
      ["amber", "At risk", "warning"],
      ["green", "On track", "success"],
      ["complete", "Complete", "success"],
    ]);
  });

  it("an unknown status renders exactly as not_started does", () => {
    expect(ragLabel("who_knows")).toBe(ragLabel("not_started"));
    expect(ragTone("who_knows")).toBe(ragTone("not_started"));
  });

  it("both functions are pure — repeated calls return the same value", () => {
    for (const s of ALL_STATUSES) {
      expect(ragLabel(s)).toBe(ragLabel(s));
      expect(ragTone(s)).toBe(ragTone(s));
    }
  });
});
