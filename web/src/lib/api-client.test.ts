import { afterEach, describe, expect, it, vi } from "vitest";
import { apiPost, type ApiError } from "./api-client";

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    })),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("api-client error contract", () => {
  it("keeps the machine-readable code so a four-eyes refusal can be told from any other 403", async () => {
    stubFetch(403, { error: "Self-approval is not allowed (four-eyes)", code: "self_approval" });
    const err = (await apiPost("/api/x").catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(403);
    expect(err.code).toBe("self_approval");
    expect(err.message).toBe("Self-approval is not allowed (four-eyes)");
  });

  it("carries the code for every refusal the decision routes send", async () => {
    for (const code of ["no_principal", "already_decided", "project_locked", "precondition_failed"]) {
      stubFetch(422, { error: "nope", code });
      const err = (await apiPost("/api/x").catch((e) => e)) as ApiError;
      expect(err.code).toBe(code);
    }
  });

  it("leaves code undefined when the route sends none, and still unwraps fields and the 412 version", async () => {
    stubFetch(412, { error: "Record changed", current_updated_at: "2026-10-16T00:00:00Z" });
    const err = (await apiPost("/api/x").catch((e) => e)) as ApiError;
    expect(err.code).toBeUndefined();
    expect(err.currentUpdatedAt).toBe("2026-10-16T00:00:00Z");

    stubFetch(422, { error: "Validation failed", code: "validation_failed", fields: [{ field: "a", message: "b" }] });
    const fieldErr = (await apiPost("/api/x").catch((e) => e)) as ApiError;
    expect(fieldErr.fields).toEqual([{ field: "a", message: "b" }]);
  });

  it("returns the unwrapped data on success", async () => {
    stubFetch(200, { data: { ok: 1 } });
    await expect(apiPost("/api/x")).resolves.toEqual({ ok: 1 });
  });
});
