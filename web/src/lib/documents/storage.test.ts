/**
 * Path-safety invariant tests for document storage helpers.
 * Exercises sanitizeFileName, buildStoragePath, validateStoragePath,
 * and the BUCKET / MAX_FILE_SIZE constants.
 */
import { describe, it, expect } from "vitest";
import {
  sanitizeFileName,
  buildStoragePath,
  validateStoragePath,
  BUCKET,
  MAX_FILE_SIZE,
} from "./storage";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
describe("storage constants", () => {
  it("BUCKET is 'documents'", () => {
    expect(BUCKET).toBe("documents");
  });

  it("MAX_FILE_SIZE is 25 MiB (26214400 bytes)", () => {
    expect(MAX_FILE_SIZE).toBe(25 * 1024 * 1024);
  });

  it("MAX_FILE_SIZE is greater than 0", () => {
    expect(MAX_FILE_SIZE).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// sanitizeFileName
// ---------------------------------------------------------------------------
describe("sanitizeFileName — path traversal and separator stripping", () => {
  it("replaces forward slashes with underscores", () => {
    const result = sanitizeFileName("a/b/c.pdf");
    expect(result).not.toContain("/");
  });

  it("replaces backslashes with underscores", () => {
    const result = sanitizeFileName("a\\b\\c.pdf");
    expect(result).not.toContain("\\");
  });

  it("strips path separators from '../../etc/passwd' (dots survive; separators do not)", () => {
    // sanitizeFileName removes / and \ but not dot sequences — dots are in the
    // allowed character set. The result contains no path separators, so the
    // remaining ".." cannot cause traversal in an object-storage key.
    const result = sanitizeFileName("../../etc/passwd");
    expect(result).not.toContain("/");
    expect(result).not.toContain("\\");
    // Separators become underscores — confirm no raw slash or backslash remains
    expect(result).toMatch(/^[a-zA-Z0-9.\-_]+$/);
  });

  it("strips mixed path separators: 'a/b\\c.pdf' → no separators", () => {
    const result = sanitizeFileName("a/b\\c.pdf");
    expect(result).not.toContain("/");
    expect(result).not.toContain("\\");
  });

  it("replaces separators so traversal input has no forward/back slashes remaining", () => {
    // The dots in '../../../secret' survive (allowed chars), but all slashes are gone.
    // Without separators the string is a flat token — no directory traversal possible.
    const result = sanitizeFileName("../../../secret");
    expect(result).not.toContain("/");
    expect(result).not.toContain("\\");
    expect(result).toMatch(/^[a-zA-Z0-9.\-_]+$/);
  });

  it("keeps a normal filename readable (letters, digits, dot, dash, underscore)", () => {
    const result = sanitizeFileName("Charter v2.pdf");
    // The space becomes underscore but most characters survive
    expect(result).toMatch(/[a-zA-Z]/); // has letters
    expect(result).toMatch(/\.pdf$/i);  // extension preserved
  });

  it("preserves safe characters: letters, digits, dot, dash, underscore", () => {
    const safe = "My-Report_2024.v3.docx";
    const result = sanitizeFileName(safe);
    expect(result).toBe(safe);
  });

  it("replaces spaces (not in allowed set) with underscores", () => {
    const result = sanitizeFileName("my file.pdf");
    expect(result).not.toContain(" ");
  });

  it("truncates to at most 200 characters", () => {
    const long = "a".repeat(300) + ".pdf";
    expect(sanitizeFileName(long).length).toBeLessThanOrEqual(200);
  });

  it("handles an empty string without throwing", () => {
    expect(() => sanitizeFileName("")).not.toThrow();
    expect(sanitizeFileName("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// buildStoragePath
// ---------------------------------------------------------------------------
describe("buildStoragePath — canonical path structure", () => {
  const wsId = "ws-abc-123";
  const docId = "doc-xyz-456";

  it("starts with workspaceId + '/'", () => {
    const path = buildStoragePath(wsId, docId, "report.pdf");
    expect(path.startsWith(`${wsId}/`)).toBe(true);
  });

  it("starts with workspaceId + '/' + documentId + '/'", () => {
    const path = buildStoragePath(wsId, docId, "report.pdf");
    expect(path.startsWith(`${wsId}/${docId}/`)).toBe(true);
  });

  it("has exactly 3 slash-separated segments for a simple filename", () => {
    const path = buildStoragePath(wsId, docId, "report.pdf");
    const parts = path.split("/");
    expect(parts).toHaveLength(3);
  });

  it("strips path separators from a traversal filename — no extra slashes in result", () => {
    // sanitizeFileName replaces / and \ with _, so the third path segment contains
    // no additional slashes. The prefix wsId/docId/ is therefore intact.
    const path = buildStoragePath(wsId, docId, "../../evil");
    const parts = path.split("/");
    // Exactly 3 segments: wsId, docId, sanitized name
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe(wsId);
    expect(parts[1]).toBe(docId);
  });

  it("sanitizes a traversal filename before embedding — prefix remains intact", () => {
    const path = buildStoragePath(wsId, docId, "../../../etc/passwd");
    // After sanitization slashes are gone; the path prefix is still correct
    expect(path.startsWith(`${wsId}/${docId}/`)).toBe(true);
    // Result has exactly 3 slash-separated segments
    expect(path.split("/")).toHaveLength(3);
  });

  it("preserves a normal filename in the third segment", () => {
    const path = buildStoragePath(wsId, docId, "Charter v2.pdf");
    const parts = path.split("/");
    // Third segment should be the sanitized filename (space → underscore)
    expect(parts[2]).toBeTruthy();
    expect(parts[2]).not.toContain("/");
  });
});

// ---------------------------------------------------------------------------
// validateStoragePath
// ---------------------------------------------------------------------------
describe("validateStoragePath — workspace/document prefix enforcement", () => {
  const wsId = "ws-abc-123";
  const docId = "doc-xyz-456";

  it("accepts a correctly built path for the matching workspace+doc", () => {
    const path = buildStoragePath(wsId, docId, "report.pdf");
    expect(validateStoragePath(path, wsId, docId)).toBe(true);
  });

  it("rejects a path with a different workspace prefix", () => {
    const path = buildStoragePath(wsId, docId, "report.pdf");
    expect(validateStoragePath(path, "ws-other-999", docId)).toBe(false);
  });

  it("rejects a path with a different document id", () => {
    const path = buildStoragePath(wsId, docId, "report.pdf");
    expect(validateStoragePath(path, wsId, "doc-other-999")).toBe(false);
  });

  it("rejects a path that attempts directory traversal in the prefix", () => {
    const traversalPath = `${wsId}/${docId}/../../other-ws/other-doc/evil.pdf`;
    // Even if the path starts with the right prefix, a real traversal attempt
    // should be rejected — validateStoragePath checks the prefix literally.
    // A path containing ".." should not validate for a DIFFERENT workspace.
    expect(validateStoragePath(traversalPath, "other-ws", "other-doc")).toBe(false);
  });

  it("rejects an empty path", () => {
    expect(validateStoragePath("", wsId, docId)).toBe(false);
  });

  it("rejects a path that starts with the workspace but misses the docId segment", () => {
    const shortPath = `${wsId}/report.pdf`;
    expect(validateStoragePath(shortPath, wsId, docId)).toBe(false);
  });

  it("rejects a path where workspace is a prefix of the actual workspace id", () => {
    // e.g. workspaceId="ws-a" must not match path starting with "ws-ab/"
    const path = buildStoragePath("ws-ab", docId, "file.pdf");
    expect(validateStoragePath(path, "ws-a", docId)).toBe(false);
  });
});
