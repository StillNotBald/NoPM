import { describe, it, expect } from "vitest";
import { cn } from "./cn";

// ---------------------------------------------------------------------------
// Joining
// ---------------------------------------------------------------------------
describe("cn — joining", () => {
  it("returns an empty string with no arguments", () => {
    expect(cn()).toBe("");
  });

  it("returns a single class unchanged", () => {
    expect(cn("btn")).toBe("btn");
  });

  it("joins multiple classes with a single space", () => {
    expect(cn("btn", "btn-primary", "w-full")).toBe("btn btn-primary w-full");
  });

  it("preserves multi-class strings verbatim", () => {
    expect(cn("flex items-center", "gap-2")).toBe("flex items-center gap-2");
  });

  it("preserves argument order", () => {
    expect(cn("a", "b")).toBe("a b");
    expect(cn("b", "a")).toBe("b a");
  });
});

// ---------------------------------------------------------------------------
// Falsy filtering — the conditional-class idiom
// ---------------------------------------------------------------------------
describe("cn — falsy filtering", () => {
  it("drops false (the `cond && 'class'` idiom)", () => {
    expect(cn("btn", false)).toBe("btn");
    expect(cn("btn", false && "active")).toBe("btn");
  });

  it("keeps the class when the condition holds", () => {
    const isActive = true;
    expect(cn("btn", isActive && "active")).toBe("btn active");
  });

  it("drops null and undefined (the `cond ? 'class' : null` idiom)", () => {
    expect(cn("btn", null, undefined)).toBe("btn");
    expect(cn("btn", null, "lg", undefined)).toBe("btn lg");
  });

  it("drops empty strings so no double space appears", () => {
    expect(cn("btn", "", "lg")).toBe("btn lg");
    expect(cn("", "")).toBe("");
  });

  it("returns an empty string when every part is falsy", () => {
    expect(cn(false, null, undefined, "")).toBe("");
  });

  it("never leaks a leading or trailing space", () => {
    const out = cn(null, "btn", false, "lg", undefined);
    expect(out).toBe("btn lg");
    expect(out).toBe(out.trim());
  });

  it("handles a realistic conditional variant call", () => {
    function classes(variant: string, disabled: boolean, extra?: string) {
      return cn(
        "btn",
        variant === "primary" && "btn-primary",
        variant === "ghost" && "btn-ghost",
        disabled && "opacity-50",
        extra,
      );
    }
    expect(classes("primary", false)).toBe("btn btn-primary");
    expect(classes("ghost", true, "mt-2")).toBe("btn btn-ghost opacity-50 mt-2");
    expect(classes("unknown", false)).toBe("btn");
  });
});

// ---------------------------------------------------------------------------
// What it deliberately does NOT do (it is not clsx + tailwind-merge)
// ---------------------------------------------------------------------------
describe("cn — non-goals", () => {
  it("does not deduplicate repeated classes", () => {
    expect(cn("btn", "btn")).toBe("btn btn");
  });

  it("does not resolve conflicting Tailwind utilities — last one wins in CSS, not here", () => {
    expect(cn("p-2", "p-4")).toBe("p-2 p-4");
  });

  it("does not trim or normalise whitespace inside a part", () => {
    expect(cn("  btn  ", "lg")).toBe("  btn   lg");
  });

  it("does not flatten arrays or objects the way clsx would", () => {
    // Outside the declared signature, but worth pinning: an array stringifies.
    expect(cn(["a", "b"] as unknown as string)).toBe("a,b");
  });

  it("filters 0 as falsy if a number ever reaches it at runtime", () => {
    expect(cn("btn", 0 as unknown as false)).toBe("btn");
    expect(cn("btn", 1 as unknown as string)).toBe("btn 1");
  });
});
