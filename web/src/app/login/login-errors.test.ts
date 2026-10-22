import { describe, it, expect } from "vitest";
import { demoLoginErrorMessage } from "./login-errors";

describe("demoLoginErrorMessage", () => {
  it("explains a rejected demo sign-in and points at the retry", () => {
    const msg = demoLoginErrorMessage("demo_unavailable");
    expect(msg).toContain("could not sign you in");
    expect(msg).toContain("Try again");
  });

  it("explains a deployment with no demo account", () => {
    expect(demoLoginErrorMessage("demo_unconfigured")).toContain("not set up");
  });

  it("shows nothing for no code, an empty code, or an unknown one (never echoes URL text)", () => {
    expect(demoLoginErrorMessage(null)).toBeNull();
    expect(demoLoginErrorMessage(undefined)).toBeNull();
    expect(demoLoginErrorMessage("")).toBeNull();
    expect(demoLoginErrorMessage("<script>alert(1)</script>")).toBeNull();
    expect(demoLoginErrorMessage("access_denied")).toBeNull();
  });

  it("does not resolve inherited object keys as codes", () => {
    expect(demoLoginErrorMessage("constructor")).toBeNull();
    expect(demoLoginErrorMessage("toString")).toBeNull();
    expect(demoLoginErrorMessage("__proto__")).toBeNull();
  });
});
