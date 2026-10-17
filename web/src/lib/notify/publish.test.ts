import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * notify() must only ever write notifications for members of the SAME
 * workspace (a recipient id can originate from a client-supplied field such
 * as owner_id, and a notification row is readable by its recipient).
 */

const inserted: unknown[] = [];
let members: { id: string }[] = [];
let lookupError: { message: string } | null = null;

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table === "profiles") {
        const q = {
          select: () => q,
          eq: () => q,
          in: () => Promise.resolve({ data: lookupError ? null : members, error: lookupError }),
        };
        return q;
      }
      return {
        insert: (rows: unknown[]) => {
          inserted.push(...rows);
          return Promise.resolve({ error: null });
        },
      };
    },
  }),
}));

import { notify } from "./publish";

describe("notify() recipient scoping", () => {
  beforeEach(() => {
    inserted.length = 0;
    members = [];
    lookupError = null;
  });

  it("drops recipients that are not members of the workspace", async () => {
    members = [{ id: "local-1" }];
    await notify({ workspaceId: "ws-a", recipientIds: ["local-1", "foreign-9"], type: "approval.approved", title: "t" });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ workspace_id: "ws-a", recipient_id: "local-1" });
  });

  it("writes nothing when every recipient is foreign", async () => {
    members = [];
    await notify({ workspaceId: "ws-a", recipientIds: ["foreign-9"], type: "approval.approved", title: "t" });
    expect(inserted).toHaveLength(0);
  });

  it("de-duplicates recipients", async () => {
    members = [{ id: "local-1" }];
    await notify({ workspaceId: "ws-a", recipientIds: ["local-1", "local-1"], type: "approval.approved", title: "t" });
    expect(inserted).toHaveLength(1);
  });

  it("is fail-soft and writes nothing when the member lookup fails", async () => {
    lookupError = { message: "boom" };
    await expect(
      notify({ workspaceId: "ws-a", recipientIds: ["local-1"], type: "approval.approved", title: "t" }),
    ).resolves.toBeUndefined();
    expect(inserted).toHaveLength(0);
  });
});
