// cli/commands/reports.mjs — project status reports and portfolio deck export
//
// Endpoints (source of truth: web/src/app/api/reports/):
//   GET /api/reports/project/:id?format=html|pptx|pdf[&sections=cover,rag,…]   audit:read
//   POST /api/reports/project/:id   body: { format?, sections? }               audit:read
//   GET  /api/reports/deck?format=html|pptx|pdf[&sections=…]                   audit:read
//   POST /api/reports/deck          body: { format?, sections? }               audit:read
//
// Reports return binary content (HTML/PPTX/PDF), not the standard JSON envelope.
// The file is saved to disk (--out <path>) or a default filename in the current dir.
// Supported formats: html | pptx | pdf

import { writeFileSync } from "node:fs";
import { loadConfig, die } from "../lib/api.mjs";

export const describe = "Export project status reports or portfolio deck (html/pptx/pdf)";

export const usage = [
  "nopm reports project --project <id> --format html|pptx|pdf [--sections cover,rag,evm,risks,issues,milestones] [--out <file>]",
  "nopm reports deck    --format html|pptx|pdf [--sections cover,rag,evm] [--out <file>]",
  "  Saves the report file to --out or a default name in the current directory.",
  "  flags: --json (prints { file, bytes } metadata instead of saving)",
];

const DEFAULT_EXT = { html: "html", pptx: "pptx", pdf: "pdf" };
const CONTENT_TYPES = {
  html: "text/html",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pdf:  "application/pdf",
};

/** Fetch a report binary from the API; returns { buffer, contentDisposition }. */
async function fetchReport(path, method, body) {
  const cfg = loadConfig();
  if (!cfg.token) die("No token. Run: nopm auth set-token <token> [--url <url>]");
  const res = await fetch(cfg.url + path, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg;
    try { msg = (await res.json()).error; } catch { msg = await res.text(); }
    const err = new Error(`HTTP ${res.status}: ${msg || res.statusText}`);
    err.status = res.status;
    throw err;
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const cd = res.headers.get("content-disposition") ?? "";
  return { buffer, contentDisposition: cd };
}

/** Extract filename from Content-Disposition header, or build a default. */
function resolveFilename(contentDisposition, format, prefix) {
  const m = contentDisposition.match(/filename="([^"]+)"/);
  if (m) return m[1];
  return `${prefix}-${Date.now()}.${DEFAULT_EXT[format] ?? format}`;
}

export async function run(rest, ctx) {
  const [sub] = ctx.flags._;
  const f = ctx.flags;

  switch (sub) {
    case "project": {
      const projectId = f.project || f["project-id"];
      if (!projectId) ctx.die("usage: nopm reports project --project <id> --format html|pptx|pdf");
      const format = f.format || "html";
      if (!["html", "pptx", "pdf"].includes(format)) ctx.die("--format must be html, pptx, or pdf");

      let apiPath, method, body;
      if (f.sections) {
        // Use POST when sections are provided (agent-friendly)
        method = "POST";
        apiPath = `/api/reports/project/${projectId}`;
        body = {
          format,
          sections: String(f.sections).split(",").map((s) => s.trim()).filter(Boolean),
        };
      } else {
        method = "GET";
        apiPath = `/api/reports/project/${projectId}?format=${format}`;
      }

      const { buffer, contentDisposition } = await fetchReport(apiPath, method, body);
      const outFile = f.out || resolveFilename(contentDisposition, format, `project-${projectId}`);

      if (f.json) {
        console.log(JSON.stringify({ file: outFile, bytes: buffer.length }, null, 2));
      }

      writeFileSync(outFile, buffer);
      if (!f.json) console.log(`✓ saved ${format.toUpperCase()} report → ${outFile}  (${buffer.length} bytes)`);
      break;
    }

    case "deck": {
      const format = f.format || "html";
      if (!["html", "pptx", "pdf"].includes(format)) ctx.die("--format must be html, pptx, or pdf");

      let apiPath, method, body;
      if (f.sections) {
        method = "POST";
        apiPath = "/api/reports/deck";
        body = {
          format,
          sections: String(f.sections).split(",").map((s) => s.trim()).filter(Boolean),
        };
      } else {
        method = "GET";
        apiPath = `/api/reports/deck?format=${format}`;
      }

      const { buffer, contentDisposition } = await fetchReport(apiPath, method, body);
      const outFile = f.out || resolveFilename(contentDisposition, format, "deck");

      if (f.json) {
        console.log(JSON.stringify({ file: outFile, bytes: buffer.length }, null, 2));
      }

      writeFileSync(outFile, buffer);
      if (!f.json) console.log(`✓ saved ${format.toUpperCase()} deck → ${outFile}  (${buffer.length} bytes)`);
      break;
    }

    default:
      console.log("Unknown subcommand. Available:\n" + usage.join("\n"));
  }
}
