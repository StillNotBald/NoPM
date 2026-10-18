/** UAT-007: the project page must load the complement seam columns, or "Link PR" shows nothing after a reopen. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("project page task select", () => {
  it("includes source, external_ref and external_url", () => {
    const src = readFileSync(join(process.cwd(), "src", "app", "(console)", "projects", "[id]", "page.tsx"), "utf8");
    const select = /\.from\("tasks"\)[\s\S]*?\.select\("([^"]+)"\)/.exec(src)?.[1] ?? "";
    for (const col of ["source", "external_ref", "external_url"]) expect(select.split(/,\s*/), col).toContain(col);
  });
});
