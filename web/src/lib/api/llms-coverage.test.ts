/**
 * llms.txt coverage drift test.
 *
 * llms.txt is the agent-facing index of the API. openapi.json already has a
 * coverage lock (openapi-coverage.test.ts: every route.ts must be in the
 * spec); this test completes the chain: every operation in the spec must be
 * listed in llms.txt. A new endpoint that reaches the spec without reaching
 * the agent index fails CI the same day.
 */

import { describe, it, expect } from "vitest";
import { specForTesting as spec } from "@/app/api/openapi.json/route";
import { textForTesting as llmsText } from "@/app/llms.txt/route";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

/** llms.txt lists /api/openapi.json with its /api prefix; spec key is relative. */
function llmsLineFor(method: string, path: string): RegExp {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${method.toUpperCase()}\\s+(?:/api)?${escaped}\\s`, "m");
}

describe("llms.txt covers every documented OpenAPI operation", () => {
  const paths = spec.paths as Record<string, Record<string, unknown>>;

  for (const [path, item] of Object.entries(paths)) {
    for (const method of Object.keys(item)) {
      if (!HTTP_METHODS.has(method)) continue;
      it(`${method.toUpperCase()} ${path} is listed`, () => {
        expect(
          llmsLineFor(method, path).test(llmsText),
          `Spec documents ${method.toUpperCase()} ${path} but llms.txt does not list it — ` +
            `agents reading llms.txt will never find this endpoint`,
        ).toBe(true);
      });
    }
  }
});
