/**
 * Deck-generation dispatch tests.
 *
 * `./gather` is mocked so no Supabase admin client is constructed — these tests
 * cover format dispatch, content types, filenames and the project-slug rule,
 * not the DB reads. The renderers themselves are exercised through the real
 * html.ts (offline, pure); pptx/pdf are covered for dispatch shape only via
 * their real offline renderers.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PortfolioReport, ProjectReport } from "./gather";
import type { EvmResult } from "@/lib/evm";

const EVM: EvmResult = {
  bac: 1000,
  pv: 400,
  ev: 400,
  ac: 500,
  committed: 600,
  cv: -100,
  sv: 0,
  cpi: 0.8,
  spi: 1,
  eac: 1250,
  etc: 750,
  vac: -250,
};

const PORTFOLIO: PortfolioReport = {
  workspaceName: "Acme Delivery",
  generatedAt: "2026-01-15T09:00:00.000Z",
  projects: [
    { code: "P-01", name: "Harbour Rail", program: "Transit", rag_status: "green", completion_pct: 42 },
  ],
  rag: { green: 1 },
  registers: { risks: 1, issues: 1, clashes: 0 },
  evmTable: [
    {
      project_name: "Harbour Rail",
      bac: 1000,
      ev: 400,
      ac: 500,
      cv: -100,
      cpi: 0.8,
      spi: 1,
      eac: 1250,
      vac: -250,
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
  topIssues: [{ title: "Late steel", priority: "high", status: "open", project_name: "Harbour Rail" }],
  milestones: [
    {
      name: "Deck pour",
      target_date: "2026-03-01",
      status: "on_track",
      completion_pct: 60,
      project_name: "Harbour Rail",
    },
  ],
};

const PROJECT: ProjectReport = {
  workspaceName: "Acme Delivery",
  generatedAt: "2026-01-15T09:00:00.000Z",
  project: {
    id: "prj-1",
    code: "P-01",
    name: "Harbour Rail",
    program: "Transit",
    description: "Extension to the north depot.",
    rag_status: "green",
    completion_pct: 42,
    start_date: "2025-06-01",
    target_date: "2026-12-01",
    currency: "MYR",
  },
  evm: EVM,
  registers: { risks: 1, issues: 1 },
  topRisks: [
    { title: "Ground conditions unknown", severity: "critical", likelihood: "high", status: "open" },
  ],
  topIssues: [{ title: "Late steel", priority: "high", status: "open" }],
  milestones: [
    { name: "Deck pour", target_date: "2026-03-01", status: "on_track", completion_pct: 60 },
  ],
};

// Mocking ./gather keeps createAdminClient (and therefore Supabase env vars)
// out of the module graph entirely.
const gatherPortfolio = vi.fn<(workspaceId: string) => Promise<PortfolioReport>>();
const gatherProject =
  vi.fn<(workspaceId: string, projectId: string) => Promise<ProjectReport | null>>();

vi.mock("./gather", () => ({
  gatherPortfolio: (workspaceId: string) => gatherPortfolio(workspaceId),
  gatherProject: (workspaceId: string, projectId: string) => gatherProject(workspaceId, projectId),
}));

const { generateDeck, generateProjectReport, DECK_FORMATS } = await import("./index");

const WS = "ws-1";

beforeEach(() => {
  gatherPortfolio.mockReset().mockResolvedValue(PORTFOLIO);
  gatherProject.mockReset().mockResolvedValue(PROJECT);
});

// ---------------------------------------------------------------------------
// DECK_FORMATS
// ---------------------------------------------------------------------------
describe("DECK_FORMATS", () => {
  it("lists exactly html, pptx and pdf", () => {
    expect(DECK_FORMATS).toEqual(["html", "pptx", "pdf"]);
  });

  it("contains no duplicates", () => {
    expect(new Set(DECK_FORMATS).size).toBe(DECK_FORMATS.length);
  });

  it("every format is a lowercase token usable as a file extension", () => {
    for (const f of DECK_FORMATS) expect(f).toMatch(/^[a-z]+$/);
  });
});

// ---------------------------------------------------------------------------
// generateDeck — html
// ---------------------------------------------------------------------------
describe("generateDeck — html", () => {
  it("returns HTML body, content type and filename", async () => {
    const out = await generateDeck(WS, "html");
    expect(typeof out.body).toBe("string");
    expect(out.contentType).toBe("text/html; charset=utf-8");
    expect(out.filename).toBe("nopm-portfolio.html");
  });

  it("renders the real portfolio HTML document", async () => {
    const out = await generateDeck(WS, "html");
    expect(out.body as string).toContain("<!doctype html>");
    expect(out.body as string).toContain("Portfolio Status Report");
    expect(out.body as string).toContain("Harbour Rail");
  });

  it("passes the workspace id straight through to the gatherer", async () => {
    await generateDeck("ws-42", "html");
    expect(gatherPortfolio).toHaveBeenCalledWith("ws-42");
  });

  it("forwards the section filter to the renderer", async () => {
    const out = await generateDeck(WS, "html", ["risks"]);
    expect(out.body as string).toContain("<h2>Top Risks</h2>");
    expect(out.body as string).not.toContain("<h2>Milestones</h2>");
  });

  it("falls back to HTML for an unrecognised format (default branch)", async () => {
    const out = await generateDeck(WS, "docx" as never);
    expect(out.contentType).toBe("text/html; charset=utf-8");
    expect(out.filename).toBe("nopm-portfolio.html");
  });

  it("propagates a gatherer failure rather than returning a partial deck", async () => {
    gatherPortfolio.mockRejectedValueOnce(new Error("db down"));
    await expect(generateDeck(WS, "html")).rejects.toThrow("db down");
  });
});

// ---------------------------------------------------------------------------
// generateDeck — binary formats
// ---------------------------------------------------------------------------
describe("generateDeck — pptx and pdf", () => {
  it("pptx returns a Buffer with the OOXML presentation content type", async () => {
    const out = await generateDeck(WS, "pptx");
    expect(Buffer.isBuffer(out.body)).toBe(true);
    expect((out.body as Buffer).length).toBeGreaterThan(0);
    expect(out.contentType).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
    expect(out.filename).toBe("nopm-portfolio.pptx");
  });

  it("pptx output is a ZIP container (PK header)", async () => {
    const out = await generateDeck(WS, "pptx");
    expect((out.body as Buffer).subarray(0, 2).toString("latin1")).toBe("PK");
  });

  it("pdf returns a Buffer with the application/pdf content type", async () => {
    const out = await generateDeck(WS, "pdf");
    expect(Buffer.isBuffer(out.body)).toBe(true);
    expect(out.contentType).toBe("application/pdf");
    expect(out.filename).toBe("nopm-portfolio.pdf");
  });

  it("pdf output starts with the %PDF- magic bytes", async () => {
    const out = await generateDeck(WS, "pdf");
    expect((out.body as Buffer).subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("filename extension matches the requested format for every DECK_FORMAT", async () => {
    for (const format of DECK_FORMATS) {
      const out = await generateDeck(WS, format);
      expect(out.filename.endsWith(`.${format}`), `${format} → ${out.filename}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// generateProjectReport
// ---------------------------------------------------------------------------
describe("generateProjectReport — dispatch", () => {
  it("returns null when the project is not found in the workspace", async () => {
    gatherProject.mockResolvedValueOnce(null);
    expect(await generateProjectReport(WS, "missing", "html")).toBeNull();
  });

  it("passes both workspace and project ids to the gatherer", async () => {
    await generateProjectReport("ws-42", "prj-9", "html");
    expect(gatherProject).toHaveBeenCalledWith("ws-42", "prj-9");
  });

  it("renders the real project HTML document", async () => {
    const out = await generateProjectReport(WS, "prj-1", "html");
    expect(out?.contentType).toBe("text/html; charset=utf-8");
    expect(out?.body as string).toContain("<title>Harbour Rail — Project Status</title>");
  });

  it("forwards the section filter", async () => {
    const out = await generateProjectReport(WS, "prj-1", "html", ["rag"]);
    expect(out?.body as string).toContain("<h2>Project Health</h2>");
    expect(out?.body as string).not.toContain("<h2>Top Risks</h2>");
  });

  it("falls back to HTML for an unrecognised format", async () => {
    const out = await generateProjectReport(WS, "prj-1", "xml" as never);
    expect(out?.contentType).toBe("text/html; charset=utf-8");
  });

  it("pptx returns a ZIP Buffer with the project filename", async () => {
    const out = await generateProjectReport(WS, "prj-1", "pptx");
    expect(Buffer.isBuffer(out?.body)).toBe(true);
    expect(out?.filename).toBe("nopm-project-p-01.pptx");
  });

  it("pdf returns a PDF Buffer with the project filename", async () => {
    const out = await generateProjectReport(WS, "prj-1", "pdf");
    expect((out?.body as Buffer).subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(out?.filename).toBe("nopm-project-p-01.pdf");
  });
});

// ---------------------------------------------------------------------------
// Filename slug rule
// ---------------------------------------------------------------------------
describe("generateProjectReport — filename slug", () => {
  const withName = (over: Partial<ProjectReport["project"]>): ProjectReport => ({
    ...PROJECT,
    project: { ...PROJECT.project, ...over },
  });

  it("uses the lowercased project code when present", async () => {
    gatherProject.mockResolvedValueOnce(withName({ code: "HR-Rail-01" }));
    const out = await generateProjectReport(WS, "prj-1", "html");
    expect(out?.filename).toBe("nopm-project-hr-rail-01.html");
  });

  it("falls back to the name when there is no code", async () => {
    gatherProject.mockResolvedValueOnce(withName({ code: null, name: "Depot" }));
    const out = await generateProjectReport(WS, "prj-1", "html");
    expect(out?.filename).toBe("nopm-project-depot.html");
  });

  it("truncates a long name to 16 characters and hyphenates whitespace", async () => {
    gatherProject.mockResolvedValueOnce(
      withName({ code: null, name: "Harbour Rail Extension Phase Two" }),
    );
    const out = await generateProjectReport(WS, "prj-1", "html");
    // "Harbour Rail Ext" → hyphenated → lowercased
    expect(out?.filename).toBe("nopm-project-harbour-rail-ext.html");
  });

  it("collapses runs of whitespace into a single hyphen", async () => {
    gatherProject.mockResolvedValueOnce(withName({ code: null, name: "A   B" }));
    const out = await generateProjectReport(WS, "prj-1", "html");
    expect(out?.filename).toBe("nopm-project-a-b.html");
  });

  it("does NOT sanitise the slug beyond lowercasing (documented gap)", async () => {
    // The code is used verbatim; punctuation, quotes and slashes survive into
    // the filename that callers put in a Content-Disposition header.
    gatherProject.mockResolvedValueOnce(withName({ code: 'X"/..' }));
    const out = await generateProjectReport(WS, "prj-1", "html");
    expect(out?.filename).toBe('nopm-project-x"/...html');
  });
});
