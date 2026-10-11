import { describe, it, expect, vi, afterEach } from "vitest";

// Plain-JS module lives under scripts/lib (no TS loader is configured for
// scripts/*.mjs — see working-days.test.ts for the precedent of importing
// one directly by relative path since it's already valid ESM).
//
// scripts/lib/env.mjs reads the REAL web/.env.local (which, in this repo,
// points at a live production Supabase project — never touch it from a
// test). So every test here mocks node:fs's existsSync/readFileSync before
// importing the module fresh (vi.resetModules() + a fresh dynamic import),
// meaning the loader never touches the real filesystem at all.
async function importEnvWithFile(fileExists: boolean, fileContent = "") {
  vi.resetModules();
  vi.doMock("node:fs", () => ({
    existsSync: () => fileExists,
    readFileSync: () => fileContent,
  }));
  return import("../../../scripts/lib/env.mjs");
}

function withEnvVar(name: string, value: string | undefined, fn: () => void) {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

afterEach(() => {
  vi.doUnmock("node:fs");
  vi.resetModules();
});

describe("loadEnv", () => {
  it("reads values from .env.local when process.env doesn't have them", async () => {
    const { loadEnv } = await importEnvWithFile(true, "FOO_TEST_VAR=from-file\nBAR_TEST_VAR=also-file\n");
    withEnvVar("FOO_TEST_VAR", undefined, () => {
      const env = loadEnv();
      expect(env.FOO_TEST_VAR).toBe("from-file");
      expect(env.BAR_TEST_VAR).toBe("also-file");
    });
  });

  it("process.env always wins over .env.local", async () => {
    const { loadEnv } = await importEnvWithFile(true, "FOO_TEST_VAR=from-file\n");
    withEnvVar("FOO_TEST_VAR", "from-process-env", () => {
      expect(loadEnv().FOO_TEST_VAR).toBe("from-process-env");
    });
  });

  it("tolerates a missing .env.local file (returns process.env values, no throw)", async () => {
    const { loadEnv } = await importEnvWithFile(false);
    withEnvVar("FOO_TEST_VAR", "only-in-process-env", () => {
      expect(() => loadEnv()).not.toThrow();
      expect(loadEnv().FOO_TEST_VAR).toBe("only-in-process-env");
    });
  });

  it("ignores comments and blank lines in the file", async () => {
    const { loadEnv } = await importEnvWithFile(
      true,
      "# a comment\n\nFOO_TEST_VAR=value\n  \n# another\nBAR_TEST_VAR=other\n",
    );
    const env = loadEnv();
    expect(env.FOO_TEST_VAR).toBe("value");
    expect(env.BAR_TEST_VAR).toBe("other");
  });
});

describe("requireEnv", () => {
  it("throws a plain-English error listing every missing name", async () => {
    const { requireEnv } = await importEnvWithFile(false);
    let thrown: Error | undefined;
    try {
      requireEnv(["FOO_MISSING_A", "FOO_MISSING_B"], {});
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown!.message).toContain("FOO_MISSING_A");
    expect(thrown!.message).toContain("FOO_MISSING_B");
  });

  it("does not throw when every required name is present and non-blank", async () => {
    const { requireEnv } = await importEnvWithFile(false);
    expect(() => requireEnv(["FOO_TEST_VAR"], { FOO_TEST_VAR: "bar" })).not.toThrow();
  });

  it("treats a blank string as missing", async () => {
    const { requireEnv } = await importEnvWithFile(false);
    expect(() => requireEnv(["FOO_TEST_VAR"], { FOO_TEST_VAR: "   " })).toThrow(/FOO_TEST_VAR/);
  });

  it("returns the env object unchanged when nothing is missing", async () => {
    const { requireEnv } = await importEnvWithFile(false);
    const env = { FOO_TEST_VAR: "bar" };
    expect(requireEnv(["FOO_TEST_VAR"], env)).toBe(env);
  });
});
