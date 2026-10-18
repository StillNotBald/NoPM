import { describe, it, expect } from "vitest";
import { assertBackupDiffers, effective } from "./backup";
import { backupPayload } from "./backup-form";
import { FieldsError } from "@/lib/api/errors";

const A = "22222222-2222-4222-8222-222222222222";
const B = "22222222-2222-4222-8222-222222222223";

describe("assertBackupDiffers", () => {
  it("refuses a backup equal to the primary (case-insensitive) with a field error", () => {
    expect(() => assertBackupDiffers(A, A.toUpperCase(), "backup_owner_id", "owner_id")).toThrow(FieldsError);
  });
  it("passes when either side is empty or they differ", () => {
    expect(() => assertBackupDiffers(A, B, "b", "p")).not.toThrow();
    expect(() => assertBackupDiffers(null, B, "b", "p")).not.toThrow();
    expect(() => assertBackupDiffers(A, null, "b", "p")).not.toThrow();
    expect(() => assertBackupDiffers(undefined, undefined, "b", "p")).not.toThrow();
  });
  it("effective: a patch value wins, even null; absence keeps the stored value", () => {
    expect(effective(undefined, A)).toBe(A);
    expect(effective(null, A)).toBeNull();
    expect(effective(B, A)).toBe(B);
    expect(effective(undefined, undefined)).toBeNull();
  });
});

describe("backupPayload (a form that never loaded the stored backup must not clear it)", () => {
  it("edit, untouched: sends nothing", () => {
    expect(backupPayload("risks", "", false, true)).toEqual({});
    expect(backupPayload("risks", A, false, true)).toEqual({});
  });
  it("edit, touched: sends the choice, or null for 'No backup'", () => {
    expect(backupPayload("risks", A, true, true)).toEqual({ backup_owner_id: A });
    expect(backupPayload("risks", "", true, true)).toEqual({ backup_owner_id: null });
  });
  it("create: sends only a chosen backup", () => {
    expect(backupPayload("issues", "", false, false)).toEqual({});
    expect(backupPayload("projects", A, true, false)).toEqual({ backup_owner_id: A });
  });
  it("tasks use backup_assignee_id", () => {
    expect(backupPayload("tasks", A, true, true)).toEqual({ backup_assignee_id: A });
  });
});
