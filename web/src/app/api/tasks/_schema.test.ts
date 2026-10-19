import { describe, it, expect } from "vitest";
import { TaskCreateSchema, TaskUpdateSchema } from "./_schema";

// Complement seam (0041, R-81) — source/external_ref/external_url validation
// on both the create and update schemas.

describe("TaskCreateSchema — complement seam (R-81)", () => {
  const base = { name: "Wire up billing" };

  it("accepts a valid source slug, external_ref, and external_url", () => {
    const parsed = TaskCreateSchema.safeParse({
      ...base,
      source: "jira",
      external_ref: "PROJ-123",
      external_url: "https://example.atlassian.net/browse/PROJ-123",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a source with an uppercase letter", () => {
    expect(TaskCreateSchema.safeParse({ ...base, source: "Jira " }).success).toBe(false);
  });

  it("rejects a source with a trailing space", () => {
    expect(TaskCreateSchema.safeParse({ ...base, source: "jira " }).success).toBe(false);
  });

  it("rejects external_url without an http(s) scheme", () => {
    expect(TaskCreateSchema.safeParse({ ...base, external_url: "ftp://x" }).success).toBe(false);
  });

  it("accepts null for all three fields (explicit clear)", () => {
    const parsed = TaskCreateSchema.safeParse({
      ...base,
      source: null,
      external_ref: null,
      external_url: null,
    });
    expect(parsed.success).toBe(true);
  });

  it("omitting all three fields still validates (additive/optional)", () => {
    expect(TaskCreateSchema.safeParse(base).success).toBe(true);
  });
});

describe("TaskUpdateSchema — complement seam (R-81)", () => {
  it("accepts a valid source slug", () => {
    expect(TaskUpdateSchema.safeParse({ source: "jira" }).success).toBe(true);
  });

  it("rejects 'Jira ' (uppercase + trailing space)", () => {
    expect(TaskUpdateSchema.safeParse({ source: "Jira " }).success).toBe(false);
  });

  it("rejects external_url rejects 'ftp://x'", () => {
    expect(TaskUpdateSchema.safeParse({ external_url: "ftp://x" }).success).toBe(false);
  });

  it("accepts external_ref up to 200 chars and rejects past it", () => {
    expect(TaskUpdateSchema.safeParse({ external_ref: "x".repeat(200) }).success).toBe(true);
    expect(TaskUpdateSchema.safeParse({ external_ref: "x".repeat(201) }).success).toBe(false);
  });

  it("rejects an empty-string external_ref (min 1)", () => {
    expect(TaskUpdateSchema.safeParse({ external_ref: "" }).success).toBe(false);
  });
});

describe("task blocker_reason and eta (R-166)", () => {
  const base = { name: "Wire up billing" };

  it("create: both fields are optional, name stays the only required field", () => {
    const parsed = TaskCreateSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.blocker_reason).toBeUndefined();
    expect(parsed.success && parsed.data.eta).toBeUndefined();
  });

  it("create and update accept a value or null for each field", () => {
    for (const S of [TaskCreateSchema, TaskUpdateSchema]) {
      const input = S === TaskCreateSchema ? base : {};
      expect(S.safeParse({ ...input, blocker_reason: "Waiting on vendor", eta: "2026-11-02" }).success).toBe(true);
      expect(S.safeParse({ ...input, blocker_reason: null, eta: null }).success).toBe(true);
    }
  });

  it("a reason without blocked_by, and blocked_by without a reason, are both allowed", () => {
    expect(TaskUpdateSchema.safeParse({ blocker_reason: "Waiting on vendor" }).success).toBe(true);
    expect(TaskUpdateSchema.safeParse({ blocked_by: "11111111-2222-4333-8444-555555555555" }).success).toBe(true);
  });

  it("reason: 500 characters pass, 501 fail", () => {
    expect(TaskUpdateSchema.safeParse({ blocker_reason: "x".repeat(500) }).success).toBe(true);
    expect(TaskUpdateSchema.safeParse({ blocker_reason: "x".repeat(501) }).success).toBe(false);
    expect(TaskCreateSchema.safeParse({ ...base, blocker_reason: "x".repeat(501) }).success).toBe(false);
  });

  it("eta: a date in the past is allowed; a non-date or impossible date is not", () => {
    expect(TaskUpdateSchema.safeParse({ eta: "2001-01-01" }).success).toBe(true);
    expect(TaskUpdateSchema.safeParse({ eta: "next week" }).success).toBe(false);
    expect(TaskUpdateSchema.safeParse({ eta: "2026-02-30" }).success).toBe(false);
    expect(TaskUpdateSchema.safeParse({ eta: "2026-10-18T10:00:00Z" }).success).toBe(false);
    expect(TaskCreateSchema.safeParse({ ...base, eta: "18/10/2026" }).success).toBe(false);
  });
});
