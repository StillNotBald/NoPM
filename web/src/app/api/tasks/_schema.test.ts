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
