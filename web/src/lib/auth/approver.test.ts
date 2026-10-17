import { describe, it, expect } from "vitest";
import type { Actor } from "@/lib/auth/guard";
import { ApiError } from "@/lib/api/errors";
import { requireApprover, APPROVER_ROLE_MESSAGE } from "@/lib/auth/approver";

const base = { id: "a", label: "A", workspaceId: "w" };
const user = (role?: string): Actor => ({ ...base, type: "user", role });
const token = (principalRole?: string | null): Actor =>
  ({ ...base, type: "token", scopes: [], principalRole }) as Actor;

describe("requireApprover (D-16)", () => {
  it("lets admins and managers through, as users and as token principals", () => {
    expect(() => requireApprover(user("admin"))).not.toThrow();
    expect(() => requireApprover(user("manager"))).not.toThrow();
    expect(() => requireApprover(token("admin"))).not.toThrow();
    expect(() => requireApprover(token("manager"))).not.toThrow();
  });

  it.each([user("member"), user("viewer"), user(undefined), token("member"), token("viewer"), token(null), token(undefined)])(
    "refuses everyone else with 403 role_not_permitted",
    (actor) => {
      try {
        requireApprover(actor);
        throw new Error("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ApiError);
        expect((e as ApiError).status).toBe(403);
        expect((e as ApiError).code).toBe("role_not_permitted");
        expect((e as ApiError).message).toBe(APPROVER_ROLE_MESSAGE);
      }
    },
  );

  it("ignores the token's own role field: only the human principal counts", () => {
    expect(() => requireApprover({ ...token("member"), role: "admin" })).toThrow();
  });
});
