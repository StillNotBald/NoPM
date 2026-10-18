/**
 * HTML report renderer tests — section registry well-formedness, section
 * filtering, and escaping of report data.
 *
 * Report HTML is generated server-side from workspace records (project names,
 * risk titles, descriptions) and served/downloaded as a document, so anything
 * a user can type must not become live markup. The injection tests below pin
 * the current escaping behaviour of `esc` (which handles & < > only).
 */
import { describe, it, expect } from "vitest";
import {
  renderHtml,
  renderProjectHtml,
  PORTFOLIO_SECTIONS,
  PROJECT_SECTIONS,
} from "./html";
import type { PortfolioReport, ProjectReport } from "./gather";
import type { EvmResult } from "@/lib/evm";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EVM: EvmResult = {
  bac: 1_000_000,
  pv: 400_000,
  ev: 380_000,
  ac: 420_000,
  committed: 500_000,
  cv: -40_000,
  sv: -20_000,
  cpi: 0.9048,
  spi: 0.95,
  eac: 1_105_263,
  eac_cpi: 1_105_263,
  eac_bottom_up: null,
  committed_open: 500_000,
  forecast_method: "cpi",
  estimate_to_complete: null,
  etc: 685_263,
  vac: -105_263,
};

function portfolio(over: Partial<PortfolioReport> = {}): PortfolioReport {
  return {
    workspaceName: "Acme Delivery",
    generatedAt: "2026-01-15T09:00:00.000Z",
    projects: [
      { code: "P-01", name: "Harbour Rail", program: "Transit", rag_status: "green", completion_pct: 42 },
      { code: null, name: "Depot Upgrade", program: null, rag_status: "amber", completion_pct: 10 },
    ],
    rag: { green: 1, amber: 1 },
    registers: { risks: 3, issues: 2, clashes: 1 },
    evmTable: [
      {
        project_name: "Harbour Rail",
        bac: 1_000_000,
        ev: 380_000,
        ac: 420_000,
        cv: -40_000,
        cpi: 0.9,
        spi: 0.95,
        eac: 1_105_263,
        vac: -105_263,
      },
    ],
    topRisks: [
      {
        title: "Ground conditions unknown",
        severity: "critical",
        likelihood: "high",
        status: "open",
        project_name: "Harbour Rail",
      },
    ],
    topIssues: [
      { title: "Late steel delivery", priority: "high", status: "open", project_name: "Harbour Rail" },
    ],
    milestones: [
      {
        name: "Deck pour complete",
        target_date: "2026-03-01",
        status: "on_track",
        completion_pct: 60,
        project_name: "Harbour Rail",
      },
    ],
    ...over,
  };
}

function project(over: Partial<ProjectReport> = {}): ProjectReport {
  return {
    workspaceName: "Acme Delivery",
    generatedAt: "2026-01-15T09:00:00.000Z",
    project: {
      id: "prj-1",
      code: "P-01",
      name: "Harbour Rail",
      program: "Transit",
      description: "Extension of the harbour line to the north depot.",
      rag_status: "green",
      completion_pct: 42,
      start_date: "2025-06-01",
      target_date: "2026-12-01",
      currency: "MYR",
    },
    evm: EVM,
    registers: { risks: 3, issues: 2 },
    topRisks: [
      { title: "Ground conditions unknown", severity: "critical", likelihood: "high", status: "open" },
    ],
    topIssues: [{ title: "Late steel delivery", priority: "high", status: "open" }],
    milestones: [
      { name: "Deck pour complete", target_date: "2026-03-01", status: "on_track", completion_pct: 60 },
    ],
    ...over,
  };
}

/** Merge a partial project record into the fixture without losing required fields. */
function withProject(over: Partial<ProjectReport["project"]>): ProjectReport {
  const base = project();
  return { ...base, project: { ...base.project, ...over } };
}

// ---------------------------------------------------------------------------
// Section registries
// ---------------------------------------------------------------------------
describe("section registries — well-formedness", () => {
  it("PORTFOLIO_SECTIONS lists the 7 portfolio sections in render order", () => {
    expect([...PORTFOLIO_SECTIONS]).toEqual([
      "cover",
      "rag",
      "projects",
      "evm",
      "risks",
      "issues",
      "milestones",
    ]);
  });

  it("PROJECT_SECTIONS lists the 6 project sections in render order", () => {
    expect([...PROJECT_SECTIONS]).toEqual(["cover", "rag", "evm", "risks", "issues", "milestones"]);
  });

  it("neither registry contains duplicates", () => {
    expect(new Set(PORTFOLIO_SECTIONS).size).toBe(PORTFOLIO_SECTIONS.length);
    expect(new Set(PROJECT_SECTIONS).size).toBe(PROJECT_SECTIONS.length);
  });

  it("PROJECT_SECTIONS is a subset of PORTFOLIO_SECTIONS", () => {
    for (const s of PROJECT_SECTIONS) {
      expect(PORTFOLIO_SECTIONS as readonly string[]).toContain(s);
    }
  });

  it("'projects' is portfolio-only (a project report is already a single project)", () => {
    expect(PORTFOLIO_SECTIONS as readonly string[]).toContain("projects");
    expect(PROJECT_SECTIONS as readonly string[]).not.toContain("projects");
  });

  it("every section key is a lowercase token", () => {
    for (const s of [...PORTFOLIO_SECTIONS, ...PROJECT_SECTIONS]) {
      expect(s).toMatch(/^[a-z]+$/);
    }
  });
});

// ---------------------------------------------------------------------------
// Portfolio — document shell
// ---------------------------------------------------------------------------
describe("renderHtml — document shell", () => {
  it("renders a complete HTML document", () => {
    const html = renderHtml(portfolio());
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
  });

  it("titles the document with the workspace name", () => {
    expect(renderHtml(portfolio())).toContain("<title>Acme Delivery — Portfolio Status</title>");
  });

  it("always renders the audit-log footer, even with no sections selected", () => {
    const html = renderHtml(portfolio(), ["nope"]);
    expect(html).toContain("captured in an immutable audit log");
  });

  it("inlines the stylesheet (self-contained download)", () => {
    const html = renderHtml(portfolio());
    expect(html).toContain("<style>");
    expect(html).not.toContain("<link rel=\"stylesheet\"");
  });
});

// ---------------------------------------------------------------------------
// Portfolio — section rendering and filtering
// ---------------------------------------------------------------------------
describe("renderHtml — sections", () => {
  it("renders every section by default", () => {
    const html = renderHtml(portfolio());
    expect(html).toContain("Portfolio Status Report"); // cover
    expect(html).toContain("<h2>RAG Summary</h2>");
    expect(html).toContain("<h2>Projects</h2>");
    expect(html).toContain("<h2>EVM / Budget</h2>");
    expect(html).toContain("<h2>Top Risks</h2>");
    expect(html).toContain("<h2>Top Issues</h2>");
    expect(html).toContain("<h2>Milestones</h2>");
  });

  it("renders every section when sections is an empty array (falls back to all)", () => {
    const html = renderHtml(portfolio(), []);
    expect(html).toContain("<h2>Projects</h2>");
    expect(html).toContain("<h2>Milestones</h2>");
  });

  it("renders only the requested sections", () => {
    const html = renderHtml(portfolio(), ["risks"]);
    expect(html).toContain("<h2>Top Risks</h2>");
    expect(html).not.toContain("<h2>Projects</h2>");
    expect(html).not.toContain("<h2>Top Issues</h2>");
    expect(html).not.toContain("Portfolio Status Report");
  });

  it("honours a multi-section selection", () => {
    const html = renderHtml(portfolio(), ["cover", "milestones"]);
    expect(html).toContain("Portfolio Status Report");
    expect(html).toContain("<h2>Milestones</h2>");
    expect(html).not.toContain("<h2>EVM / Budget</h2>");
  });

  it("ignores unknown section keys without throwing", () => {
    expect(() => renderHtml(portfolio(), ["not-a-section"])).not.toThrow();
    const html = renderHtml(portfolio(), ["not-a-section"]);
    expect(html).not.toContain("<h2>");
  });

  it("section order is fixed by the renderer, not by the caller's array order", () => {
    const html = renderHtml(portfolio(), ["milestones", "risks"]);
    expect(html.indexOf("<h2>Top Risks</h2>")).toBeLessThan(html.indexOf("<h2>Milestones</h2>"));
  });

  it("RAG section injects the project-count card ahead of the RAG cards", () => {
    const html = renderHtml(portfolio(), ["rag"]);
    expect(html).toContain(">Projects</div>");
    expect(html.indexOf(">Projects</div>")).toBeLessThan(html.indexOf(">Green</div>"));
    expect(html).toContain("Open Risks <b>3</b>");
    expect(html).toContain("Clashes <b>1</b>");
  });

  it("RAG cards default missing buckets to 0", () => {
    const html = renderHtml(portfolio({ rag: {} }), ["rag"]);
    expect(html).toContain(">0</div><div class=\"lbl\">Green</div>");
  });
});

// ---------------------------------------------------------------------------
// Portfolio — empty-state branches
// ---------------------------------------------------------------------------
describe("renderHtml — empty states", () => {
  it("shows a placeholder row when there are no projects", () => {
    const html = renderHtml(portfolio({ projects: [] }), ["projects"]);
    expect(html).toContain("No projects yet");
  });

  it("shows a message when there is no budget data", () => {
    const html = renderHtml(portfolio({ evmTable: [] }), ["evm"]);
    expect(html).toContain("No budget data yet.");
    expect(html).not.toContain("<th class=\"right\">BAC</th>");
  });

  it("shows a message when there are no open risks", () => {
    expect(renderHtml(portfolio({ topRisks: [] }), ["risks"])).toContain("No open risks.");
  });

  it("shows a message when there are no open issues", () => {
    expect(renderHtml(portfolio({ topIssues: [] }), ["issues"])).toContain("No open issues.");
  });

  it("shows a message when there are no upcoming milestones", () => {
    expect(renderHtml(portfolio({ milestones: [] }), ["milestones"])).toContain(
      "No upcoming milestones.",
    );
  });

  it("renders an em-dash for a milestone with no target date", () => {
    const r = portfolio();
    r.milestones[0].target_date = null;
    expect(renderHtml(r, ["milestones"])).toContain("<td>—</td>");
  });

  it("renders empty cells for a null project code/program", () => {
    const html = renderHtml(portfolio(), ["projects"]);
    expect(html).toContain("<td></td>"); // null code and null program on Depot Upgrade
    expect(html).toContain("Depot Upgrade");
  });
});

// ---------------------------------------------------------------------------
// Portfolio — number formatting and variance classes
// ---------------------------------------------------------------------------
describe("renderHtml — EVM formatting", () => {
  it("marks a negative cost variance with the .neg class", () => {
    expect(renderHtml(portfolio(), ["evm"])).toContain('class="right neg"');
  });

  it("marks a positive cost variance with the .pos class", () => {
    const r = portfolio();
    r.evmTable[0].cv = 5000;
    r.evmTable[0].cpi = 1.2;
    const html = renderHtml(r, ["evm"]);
    expect(html).toContain('class="right pos"');
  });

  it("marks a zero cost variance as neutral", () => {
    const r = portfolio();
    r.evmTable[0].cv = 0;
    expect(renderHtml(r, ["evm"])).toContain('class="right neutral"');
  });

  it("renders an em-dash for null indices", () => {
    const r = portfolio();
    r.evmTable[0].cpi = null;
    r.evmTable[0].spi = null;
    r.evmTable[0].eac = null;
    r.evmTable[0].vac = null;
    const html = renderHtml(r, ["evm"]);
    expect(html).toContain("—");
  });

  it("formats indices to two decimal places", () => {
    const r = portfolio();
    r.evmTable[0].cpi = 0.9048;
    expect(renderHtml(r, ["evm"])).toContain("0.90");
  });
});

// ---------------------------------------------------------------------------
// Portfolio — escaping
// ---------------------------------------------------------------------------
describe("renderHtml — escaping report data", () => {
  it("escapes a <script> tag injected via a project name", () => {
    const html = renderHtml(
      portfolio({
        projects: [
          {
            code: "X",
            name: "<script>alert(1)</script>",
            program: null,
            rag_status: "green",
            completion_pct: 0,
          },
        ],
      }),
      ["projects"],
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes markup injected via the workspace name (cover + <title>)", () => {
    const html = renderHtml(portfolio({ workspaceName: "</title><script>x</script>" }));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;/title&gt;&lt;script&gt;x&lt;/script&gt;");
  });

  it("escapes markup injected via a project code and program", () => {
    const html = renderHtml(
      portfolio({
        projects: [
          {
            code: "<b>C</b>",
            name: "N",
            program: "<i>P</i>",
            rag_status: "green",
            completion_pct: 0,
          },
        ],
      }),
      ["projects"],
    );
    expect(html).toContain("&lt;b&gt;C&lt;/b&gt;");
    expect(html).toContain("&lt;i&gt;P&lt;/i&gt;");
    expect(html).not.toContain("<b>C</b>");
  });

  it("escapes markup injected via a risk title, severity, likelihood and status", () => {
    const html = renderHtml(
      portfolio({
        topRisks: [
          {
            title: "<img src=x onerror=alert(1)>",
            severity: "<critical>",
            likelihood: "<high>",
            status: "<open>",
            project_name: "<p>",
          },
        ],
      }),
      ["risks"],
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;critical&gt;");
    expect(html).toContain("&lt;open&gt;");
  });

  it("escapes markup injected via an issue title", () => {
    const html = renderHtml(
      portfolio({
        topIssues: [{ title: "<svg onload=alert(1)>", priority: "high", status: "open" }],
      }),
      ["issues"],
    );
    expect(html).not.toContain("<svg");
    expect(html).toContain("&lt;svg onload=alert(1)&gt;");
  });

  it("escapes markup injected via a milestone name and status", () => {
    const html = renderHtml(
      portfolio({
        milestones: [
          {
            name: "<script>m</script>",
            target_date: null,
            status: "<on_track>",
            completion_pct: 0,
          },
        ],
      }),
      ["milestones"],
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;m&lt;/script&gt;");
  });

  it("escapes markup injected via an EVM row project name", () => {
    const r = portfolio();
    r.evmTable[0].project_name = "<script>e</script>";
    const html = renderHtml(r, ["evm"]);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;e&lt;/script&gt;");
  });

  it("escapes ampersands", () => {
    const html = renderHtml(portfolio({ workspaceName: "Piling & Foundations" }));
    expect(html).toContain("Piling &amp; Foundations");
  });

  it("escapes & before < so entities are not double-encoded", () => {
    const html = renderHtml(portfolio({ workspaceName: "<b>" }));
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("&amp;lt;");
  });

  it("does NOT escape quotes (documented gap — esc handles & < > only)", () => {
    // Every esc() call site is a text node, so an unescaped quote cannot break
    // out of an attribute today. Pinned so a future move of esc() output into
    // an attribute is caught by this test.
    const html = renderHtml(portfolio({ workspaceName: `The "Gateway" & 'North' package` }));
    expect(html).toContain(`The "Gateway" &amp; 'North' package`);
  });

  it("falls back to a neutral tone colour for an unknown RAG status (no style injection)", () => {
    const html = renderHtml(
      portfolio({
        projects: [
          {
            code: "X",
            name: "N",
            program: null,
            rag_status: "red;}</style><script>x</script>",
            completion_pct: 0,
          },
        ],
      }),
      ["projects"],
    );
    // The colour comes from the TONE map (fallback), never from the raw status
    expect(html).toContain("background:#9a968d");
    expect(html).not.toContain("<script>");
  });
});

// ---------------------------------------------------------------------------
// Project report
// ---------------------------------------------------------------------------
describe("renderProjectHtml — document shell and sections", () => {
  it("renders a complete document titled with the project name", () => {
    const html = renderProjectHtml(project());
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>Harbour Rail — Project Status</title>");
  });

  it("renders every project section by default", () => {
    const html = renderProjectHtml(project());
    expect(html).toContain("<h2>Project Health</h2>");
    expect(html).toContain("<h2>EVM / Budget</h2>");
    expect(html).toContain("<h2>Top Risks</h2>");
    expect(html).toContain("<h2>Top Issues</h2>");
    expect(html).toContain("<h2>Milestones</h2>");
  });

  it("renders only the requested sections", () => {
    const html = renderProjectHtml(project(), ["rag"]);
    expect(html).toContain("<h2>Project Health</h2>");
    expect(html).not.toContain("<h2>EVM / Budget</h2>");
    expect(html).not.toContain("<h2>Top Risks</h2>");
  });

  it("register tables omit the Project column (single-project report)", () => {
    const html = renderProjectHtml(project(), ["risks", "issues", "milestones"]);
    expect(html).not.toContain("<th>Project</th>");
  });

  it("portfolio register tables DO include the Project column", () => {
    const html = renderHtml(portfolio(), ["risks"]);
    expect(html).toContain("<th>Project</th>");
  });

  it("shows the project code beside the name on the cover", () => {
    expect(renderProjectHtml(project(), ["cover"])).toContain("(P-01)");
  });

  it("omits the code parenthetical when code is null", () => {
    const html = renderProjectHtml(withProject({ code: null }), ["cover"]);
    expect(html).not.toContain("()");
  });

  it("omits the program from the subtitle when program is null", () => {
    const html = renderProjectHtml(withProject({ program: null }), ["cover"]);
    expect(html).toContain("Acme Delivery");
    expect(html).not.toContain(" · Transit");
  });

  it("omits the description paragraph when description is null", () => {
    const html = renderProjectHtml(withProject({ description: null }), ["cover"]);
    expect(html).not.toContain("margin:-24px 0 32px");
  });

  it("renders the description when present", () => {
    expect(renderProjectHtml(project(), ["cover"])).toContain("north depot");
  });

  it("omits the date line when both dates are null", () => {
    const html = renderProjectHtml(withProject({ start_date: null, target_date: null }), ["cover"]);
    expect(html).not.toContain("→");
  });

  it("renders a half date line with an em-dash when only one date is set", () => {
    const html = renderProjectHtml(withProject({ start_date: null }), ["cover"]);
    expect(html).toContain("— →");
  });

  it("renders the currency note in the EVM section", () => {
    expect(renderProjectHtml(project(), ["evm"])).toContain("Currency: MYR");
  });

  it("marks a negative CV and a sub-1 CPI as negative in the EVM cards", () => {
    const html = renderProjectHtml(project(), ["evm"]);
    expect(html).toContain('class="num neg"');
  });

  it("marks a positive CV as positive", () => {
    const html = renderProjectHtml({ ...project(), evm: { ...EVM, cv: 5000, cpi: 1.1 } }, ["evm"]);
    expect(html).toContain('class="num pos"');
  });

  it("marks a null CPI as neutral", () => {
    const html = renderProjectHtml({ ...project(), evm: { ...EVM, cv: 0, cpi: null } }, ["evm"]);
    expect(html).toContain('class="num neutral"');
  });

  it("surfaces the open risk and issue counts on the health cards", () => {
    const html = renderProjectHtml(project(), ["rag"]);
    expect(html).toContain(">3</div><div class=\"lbl\">Open Risks</div>");
    expect(html).toContain(">2</div><div class=\"lbl\">Open Issues</div>");
  });
});

describe("renderProjectHtml — escaping report data", () => {
  it("escapes markup injected via the project name (cover, h1 and <title>)", () => {
    const html = renderProjectHtml(withProject({ name: "<script>alert(1)</script>" }));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes markup injected via the project description", () => {
    const html = renderProjectHtml(withProject({ description: "<img src=x onerror=alert(1)>" }), [
      "cover",
    ]);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("escapes markup injected via the project code, program and currency", () => {
    const html = renderProjectHtml(
      withProject({ code: "<b>C</b>", program: "<i>P</i>", currency: "<u>MYR</u>" }),
      ["cover", "evm"],
    );
    expect(html).toContain("&lt;b&gt;C&lt;/b&gt;");
    expect(html).toContain("&lt;i&gt;P&lt;/i&gt;");
    expect(html).toContain("&lt;u&gt;MYR&lt;/u&gt;");
    expect(html).not.toContain("<u>MYR</u>");
  });

  it("escapes markup injected via the RAG status and falls back to a safe colour", () => {
    const html = renderProjectHtml(withProject({ rag_status: '"><script>x</script>' }), ["rag"]);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).toContain("color:#9a968d");
  });

  it("escapes markup injected via the workspace name", () => {
    const html = renderProjectHtml({ ...project(), workspaceName: "<script>w</script>" }, ["cover"]);
    expect(html).not.toContain("<script>");
  });
});

// ---------------------------------------------------------------------------
// KNOWN GAP — completion_pct is interpolated raw into a style attribute.
// Typed as `number` and coerced with Number() in gather.ts, so it is safe in
// practice; pinned here so a type/source change is caught deliberately.
// ---------------------------------------------------------------------------
describe("completion_pct — raw interpolation into style width (documented gap)", () => {
  it("writes the numeric percentage straight into the progress bar width", () => {
    const html = renderHtml(portfolio(), ["projects"]);
    expect(html).toContain('style="width:42%"');
  });

  it("does not escape or validate a non-numeric completion_pct", () => {
    const r = portfolio();
    (r.projects[0] as { completion_pct: unknown }).completion_pct = '10%"><script>x</script>';
    const html = renderHtml(r, ["projects"]);
    // Actual behaviour: the raw value lands inside the style attribute unescaped.
    expect(html).toContain('<script>x</script>');
  });

  it("does not escape a non-numeric milestone completion_pct either", () => {
    const r = portfolio();
    (r.milestones[0] as { completion_pct: unknown }).completion_pct = '0%"><b>x</b>';
    expect(renderHtml(r, ["milestones"])).toContain("<b>x</b>");
  });
});
