/**
 * OpenAPI coverage drift test.
 *
 * At test time this file:
 *   1. Globs every route.ts under src/app/api (excluding _schema files and the
 *      openapi.json route itself).
 *   2. Derives the API path for each file by stripping the src/app/api prefix,
 *      stripping route-group segments like (console), and converting [id] → {id}.
 *   3. Reads the file to detect exported HTTP-method handlers (GET/POST/PATCH/
 *      PUT/DELETE).
 *   4. Asserts every (path, method) pair is present in the OpenAPI spec.
 *
 * The test FAILS if any route is undocumented, giving CI early warning before
 * the spec and codebase drift.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

// ---------------------------------------------------------------------------
// Import the spec directly from the route module.
// We re-export it as a named export for test access.
// ---------------------------------------------------------------------------
import { specForTesting as spec } from "@/app/api/openapi.json/route";

// ---------------------------------------------------------------------------
// File-system helpers
// ---------------------------------------------------------------------------

/** Recursively enumerate all route.ts files under a directory. */
function findRouteFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findRouteFiles(full));
    } else if (entry.isFile() && entry.name === "route.ts") {
      results.push(full);
    }
  }
  return results;
}

/** Convert a file-system path to an OpenAPI path segment.
 *
 * e.g.  src/app/api/projects/[id]/tasks/route.ts
 *    →  /projects/{id}/tasks
 *
 * Rules:
 *   - Strip everything up to and including src/app/api
 *   - Drop the trailing /route.ts
 *   - Strip route-group segments: segments wrapped in parentheses, e.g. (console)
 *   - Convert [param] to {param}
 *   - The openapi.json pseudo-directory is NOT an API path — skip it
 */
function deriveApiPath(absPath: string, apiRoot: string): string | null {
  // Normalise to forward slashes for consistent matching
  const rel = relative(apiRoot, absPath).split(sep).join("/");

  // rel is now e.g. "projects/[id]/tasks/route.ts"
  // Drop trailing /route.ts
  const withoutRouteTs = rel.replace(/\/route\.ts$/, "");

  // openapi.json is a file-system trick to serve GET /api/openapi.json — skip
  if (withoutRouteTs === "openapi.json") return null;

  // Split into segments and filter
  const segments = withoutRouteTs.split("/").filter((seg) => {
    // Drop route-group segments: (foo)
    if (/^\([^)]+\)$/.test(seg)) return false;
    return true;
  });

  // Convert [param] → {param}
  const converted = segments.map((seg) =>
    seg.replace(/^\[(.+)\]$/, "{$1}"),
  );

  return "/" + converted.join("/");
}

// HTTP methods we track
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

/** Read a route file and detect which HTTP method exports it declares. */
function detectMethods(absPath: string): HttpMethod[] {
  const src = readFileSync(absPath, "utf8");
  return HTTP_METHODS.filter((m) => {
    // Match: export const GET = ... or export async function GET(
    const exportedConst = new RegExp(`export\\s+const\\s+${m}\\s*=`);
    const exportedFn = new RegExp(`export\\s+(?:async\\s+)?function\\s+${m}\\s*[(<]`);
    return exportedConst.test(src) || exportedFn.test(src);
  });
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe("OpenAPI coverage — every route must be documented", () => {
  const apiRoot = join(__dirname, "../../app/api");
  const routeFiles = findRouteFiles(apiRoot);

  // Build the list of (path, method) pairs we expect the spec to document
  type RouteEntry = { path: string; method: string; file: string };
  const routeEntries: RouteEntry[] = [];

  for (const file of routeFiles) {
    const apiPath = deriveApiPath(file, apiRoot);
    if (apiPath === null) continue; // skip openapi.json itself

    const methods = detectMethods(file);
    for (const method of methods) {
      routeEntries.push({ path: apiPath, method: method.toLowerCase(), file });
    }
  }

  it("finds at least one route entry (sanity)", () => {
    expect(routeEntries.length).toBeGreaterThan(0);
  });

  for (const { path, method, file } of routeEntries) {
    it(`spec documents ${method.toUpperCase()} ${path} (${relative(join(__dirname, "../../.."), file)})`, () => {
      const pathItem = (spec.paths as Record<string, Record<string, unknown>>)[path];
      expect(
        pathItem,
        `Path "${path}" is missing from the OpenAPI spec. Add it to src/app/api/openapi.json/route.ts`,
      ).toBeDefined();

      const operation = pathItem[method];
      expect(
        operation,
        `Method "${method.toUpperCase()}" on path "${path}" is missing from the OpenAPI spec.`,
      ).toBeDefined();
    });
  }
});
