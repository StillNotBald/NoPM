import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { ModulesProvider, useAllNavItems, useNavSections, useScopeLists } from "@/lib/modules-context";

afterEach(() => {
  delete process.env.NOPM_MODULES;
});

describe("proxy gate", () => {
  it("answers the standard 404 envelope for a disabled module's API route", async () => {
    process.env.NOPM_MODULES = "risks_issues";
    const res = await proxy(new NextRequest("http://x/api/projects/abc/budget"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found", code: "not_found" });
    expect(res.headers.get("content-security-policy")).toBeTruthy();
  });

  it("rewrites a disabled console page to the 404 route", async () => {
    process.env.NOPM_MODULES = "risks_issues";
    const res = await proxy(new NextRequest("http://x/budget"));
    expect(res.status).toBe(404);
    expect(res.headers.get("x-middleware-rewrite")).toContain("/module-disabled");
  });

  it("lets an enabled module's API route through", async () => {
    process.env.NOPM_MODULES = "risks_issues";
    const res = await proxy(new NextRequest("http://x/api/risks/abc"));
    expect(res.status).toBe(200);
  });
});

describe("client nav hooks", () => {
  function Probe() {
    const sections = useNavSections();
    const items = useAllNavItems();
    const { choices, agentPreset } = useScopeLists();
    return createElement(
      "pre",
      null,
      JSON.stringify({
        hrefs: sections.flatMap((s) => s.items.map((i) => i.href)),
        flat: items.map((i) => i.href),
        sections: sections.map((s) => s.label),
        choices,
        agentPreset,
      }),
    );
  }
  const read = (disabled: string[]) =>
    JSON.parse(
      renderToStaticMarkup(createElement(ModulesProvider, { disabled }, createElement(Probe)))
        .replace(/<\/?pre>/g, "")
        .replace(/&quot;/g, '"'),
    );

  it("without a disabled list everything shows", () => {
    const all = read([]);
    expect(all.hrefs).toContain("/budget");
    expect(all.flat).toEqual(all.hrefs);
    expect(all.choices).toContain("budget:read");
  });

  it("drops disabled modules from sections, the flat list and the scope lists", () => {
    const r = read(["budget", "resources", "clashes"]);
    expect(r.hrefs).not.toContain("/budget");
    expect(r.hrefs).not.toContain("/resources");
    expect(r.flat).not.toContain("/clashes");
    // "Capacity" keeps one item: /people (workspace members) belongs to the kernel, so the section stays.
    expect(r.sections).toContain("Capacity");
    expect(r.choices.some((c: string) => c.startsWith("budget:") || c.startsWith("resource:"))).toBe(false);
    expect(r.agentPreset).not.toContain("budget:read");
    expect(r.agentPreset).toContain("task:write");
  });
});
