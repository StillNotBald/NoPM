// One-off: attach a real, generated PDF to every seeded document so the
// Documents folder viewer shows live, previewable files out of the box.
// Dependency-free PDF builder (valid single-page PDF with correct xref offsets).
// Idempotent: re-uploads with upsert and rewrites the file columns.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(path.join(here, "..", ".env.local"), "utf8")
    .split(/\r?\n/).map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]),
);
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const BUCKET = "documents";

function escapePdf(s) {
  return String(s).replace(/([\\()])/g, "\\$1").replace(/[^\x20-\x7e]/g, " ");
}
// Build a valid single-page PDF (Helvetica) from a title + wrapped body lines.
function buildPdf(title, lines) {
  const content = [`BT /F1 22 Tf 72 730 Td (${escapePdf(title)}) Tj ET`];
  let y = 696;
  for (const ln of lines) {
    content.push(`BT /F1 12 Tf 72 ${y} Td (${escapePdf(ln)}) Tj ET`);
    y -= 20;
  }
  const stream = content.join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((o) => { pdf += String(o).padStart(10, "0") + " 00000 n \n"; });
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);

const W = (await db.from("workspaces").select("id").eq("slug", "demo").single()).data.id;
const docs = (await db.from("documents").select("id, reference_id, title, doc_type, folder, status, summary").eq("workspace_id", W)).data ?? [];

let n = 0;
for (const d of docs) {
  const fileName = `${d.reference_id || "DOC"} ${d.title}.pdf`;
  const storagePath = `${W}/${d.id}/${safe(fileName)}`;
  const pdf = buildPdf(d.title, [
    `Reference: ${d.reference_id || "-"}    Type: ${d.doc_type}    Status: ${d.status}`,
    `Folder: ${d.folder}`,
    "",
    ...(d.summary ? wrap(d.summary, 80) : ["(No summary.)"]),
    "",
    "NoPM - governed document control. Generated sample artifact.",
  ]);
  const up = await db.storage.from(BUCKET).upload(storagePath, pdf, { contentType: "application/pdf", upsert: true });
  if (up.error) { console.error("upload failed", d.reference_id, up.error.message); continue; }
  const { error } = await db.from("documents").update({
    storage_path: storagePath, file_name: fileName, mime_type: "application/pdf", file_size: pdf.length,
  }).eq("id", d.id);
  if (error) { console.error("row update failed", d.reference_id, error.message); continue; }
  n++;
}
function wrap(s, w) {
  const words = String(s).split(/\s+/); const out = []; let line = "";
  for (const word of words) {
    if ((line + " " + word).trim().length > w) { out.push(line.trim()); line = word; }
    else line += " " + word;
  }
  if (line.trim()) out.push(line.trim());
  return out.slice(0, 6);
}
console.log(`✓ Attached generated PDFs to ${n}/${docs.length} documents.`);
