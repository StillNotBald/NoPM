import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { encrypt, decrypt } from "./crypto";

// ---------------------------------------------------------------------------
// Key setup — inject a valid 32-byte base64 key before any test runs.
// The crypto helpers read process.env.NOPM_ENCRYPTION_KEY inside each call,
// so setting it here covers all tests in this file.
// ---------------------------------------------------------------------------
const TEST_KEY = Buffer.alloc(32, 0xab).toString("base64"); // 32 bytes, deterministic

beforeAll(() => {
  process.env.NOPM_ENCRYPTION_KEY = TEST_KEY;
});

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------
describe("encrypt / decrypt — round-trip", () => {
  it("decrypts to the original ASCII string", () => {
    const plaintext = "hello world";
    expect(decrypt(encrypt(plaintext))).toBe(plaintext);
  });

  it("decrypts to the original unicode string", () => {
    const plaintext = "你好 🌏 café naïve résumé";
    expect(decrypt(encrypt(plaintext))).toBe(plaintext);
  });

  it("decrypts to the original long string (>1 kB)", () => {
    const plaintext = "x".repeat(2000);
    expect(decrypt(encrypt(plaintext))).toBe(plaintext);
  });

  it("round-trips an empty string", () => {
    expect(decrypt(encrypt(""))).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Ciphertext properties
// ---------------------------------------------------------------------------
describe("encrypt — ciphertext properties", () => {
  it("ciphertext is not equal to the plaintext", () => {
    const plaintext = "secret governance data";
    expect(encrypt(plaintext)).not.toBe(plaintext);
  });

  it("two encryptions of the same input produce different ciphertexts (random IV)", () => {
    const plaintext = "same message every time";
    expect(encrypt(plaintext)).not.toBe(encrypt(plaintext));
  });

  it("produces a payload with exactly three dot-separated segments", () => {
    const payload = encrypt("test");
    expect(payload.split(".")).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Tamper detection (GCM auth tag)
// ---------------------------------------------------------------------------
describe("decrypt — tamper detection", () => {
  it("throws when the ciphertext segment is modified", () => {
    const payload = encrypt("tamper me");
    const parts = payload.split(".");
    // Flip the last character of the ciphertext segment
    const ct = parts[2];
    const flipped = ct.slice(0, -1) + (ct.endsWith("A") ? "B" : "A");
    const tampered = [parts[0], parts[1], flipped].join(".");
    expect(() => decrypt(tampered)).toThrow();
  });

  it("throws when the auth tag segment is modified", () => {
    const payload = encrypt("tamper auth tag");
    const parts = payload.split(".");
    const tag = parts[1];
    // GCM auth tags are always 16 bytes → 24-char base64 ending in "==".
    // Flip the FIRST character (guaranteed data, not padding) to change the decoded bytes.
    const firstChar = tag[0];
    const replacement = firstChar === "A" ? "B" : "A";
    const flipped = replacement + tag.slice(1);
    const tampered = [parts[0], flipped, parts[2]].join(".");
    expect(() => decrypt(tampered)).toThrow();
  });

  it("throws when payload has fewer than 3 segments", () => {
    expect(() => decrypt("onlyone")).toThrow("3 dot-separated segments");
  });

  it("throws when payload has more than 3 segments", () => {
    expect(() => decrypt("a.b.c.d")).toThrow("3 dot-separated segments");
  });
});

// ---------------------------------------------------------------------------
// Wrong key
// ---------------------------------------------------------------------------
describe("decrypt — wrong key", () => {
  it("throws when decrypting with a different NOPM_ENCRYPTION_KEY", () => {
    const payload = encrypt("secret");
    // Use a different valid 32-byte key
    const otherKey = Buffer.alloc(32, 0x11).toString("base64");
    process.env.NOPM_ENCRYPTION_KEY = otherKey;
    try {
      expect(() => decrypt(payload)).toThrow();
    } finally {
      // Restore the test key so subsequent tests are not affected
      process.env.NOPM_ENCRYPTION_KEY = TEST_KEY;
    }
  });
});

// ---------------------------------------------------------------------------
// Missing key
// ---------------------------------------------------------------------------
describe("encrypt / decrypt — missing NOPM_ENCRYPTION_KEY", () => {
  // Save and restore around this block
  let savedKey: string | undefined;

  afterEach(() => {
    if (savedKey !== undefined) {
      process.env.NOPM_ENCRYPTION_KEY = savedKey;
    } else {
      delete process.env.NOPM_ENCRYPTION_KEY;
    }
    savedKey = undefined;
  });

  it("encrypt throws a clear error when the env var is absent", () => {
    savedKey = process.env.NOPM_ENCRYPTION_KEY;
    delete process.env.NOPM_ENCRYPTION_KEY;
    expect(() => encrypt("x")).toThrow("NOPM_ENCRYPTION_KEY");
  });

  it("decrypt throws a clear error when the env var is absent", () => {
    // First encrypt while key is present
    const payload = encrypt("x");
    savedKey = process.env.NOPM_ENCRYPTION_KEY;
    delete process.env.NOPM_ENCRYPTION_KEY;
    expect(() => decrypt(payload)).toThrow("NOPM_ENCRYPTION_KEY");
  });
});
