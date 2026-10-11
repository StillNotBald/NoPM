// Mainline prototype generator — pulls the live demo portfolio and emits a
// standalone themed SVG "subway map". Rails = artifact type; within each rail,
// every project gets its own parallel sub-track (color = project, the 6 "lines").
// Time L→R · SteerCo gates · coral critical path · cross-project clash interchanges.
// Output: scripts/mainline-prototype.html (static, hover tooltips).
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, requireEnv } from "./lib/env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const env = requireEnv(["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"], loadEnv());
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const W = (await db.from("workspaces").select("id").eq("slug", "demo").single()).data.id;
const pick = async (t, cols) => (await db.from(t).select(cols).eq("workspace_id", W)).data ?? [];
const projects   = await pick("projects", "id, code, name, rag_status, start_date, target_date");
const milestones = await pick("milestones", "id, project_id, name, target_date, baseline_target_date, status, completion_pct");
const tasks      = await pick("tasks", "id, project_id, name, start_date, due_date, status_type, completion_pct");
const risks      = await pick("risks", "id, project_id, title, severity, status, raised_at, reference_id");
const issues     = await pick("issues", "id, project_id, title, priority, status, raised_at, reference_id");
const decisions  = await pick("decisions", "id, project_id, title, status, decided_at, created_at, reference_id");
const documents  = await pick("documents", "id, project_id, title, doc_type, status, created_at, reference_id");
const clashes    = await pick("clashes", "id, title, type, severity, project_a_id, project_b_id, window_start, reference_id");

// ── theme ───────────────────────────────────────────────────────────────────
const CANVAS = "#FAF9F5", SURFACE = "#FFFFFF", INK = "#2A2825", INK2 = "#6B6862",
      MUTED = "#A8A39A", BORDER = "#E7E2D8", CORAL = "#D97757", GRID = "#EFEBE2";
const PALETTE = ["#3F8E7E", "#5B6CB8", "#C98A2B", "#A65574", "#4E7CA1", "#7A8B3C"];
const order = [...projects].sort((a, b) => (a.code || "").localeCompare(b.code || ""));
const color = {}, pidx = {}; order.forEach((p, i) => { color[p.id] = PALETTE[i % PALETTE.length]; pidx[p.id] = i; });
const pcode = Object.fromEntries(projects.map((p) => [p.id, p.code]));
const N = projects.length;

// ── time domain ───────────────────────────────────────────────────────────────
const Dt = (s) => (s ? new Date(s) : null);
const dates = [];
for (const m of milestones) { if (m.target_date) dates.push(Dt(m.target_date)); if (m.baseline_target_date) dates.push(Dt(m.baseline_target_date)); }
for (const t of tasks) { if (t.start_date) dates.push(Dt(t.start_date)); if (t.due_date) dates.push(Dt(t.due_date)); }
for (const r of risks) if (r.raised_at) dates.push(Dt(r.raised_at));
for (const p of projects) { if (p.start_date) dates.push(Dt(p.start_date)); if (p.target_date) dates.push(Dt(p.target_date)); }
let minD = new Date(Math.min(...dates)); let maxD = new Date(Math.max(...dates));
minD.setDate(minD.getDate() - 10); maxD.setDate(maxD.getDate() + 14);
const DAY = 86400000;
const span = Math.max(1, Math.round((maxD - minD) / DAY));
const LG = 188, TA = 158, RAIL_PAD = 220;          // RAIL_PAD leaves room for end labels
const DAYW = Math.min(7, Math.max(4, 1500 / span));
const lanes = [
  { key: "milestone", label: "Milestones" }, { key: "task", label: "Tasks" },
  { key: "risk", label: "Risks" }, { key: "issue", label: "Issues" },
  { key: "decision", label: "Decisions" }, { key: "doc", label: "Docs / Reports" },
  { key: "steerco", label: "SteerCo" },
];
const LH = 118, INSET = 18;
const subGap = (LH - INSET * 2) / N;
const WIDTH = LG + span * DAYW + RAIL_PAD;
const HEIGHT = TA + lanes.length * LH + 40;
const x = (s) => LG + (Dt(s) - minD) / DAY * DAYW;
const bandTop = (key) => TA + lanes.findIndex((l) => l.key === key) * LH;
const subY = (key, pid) => bandTop(key) + INSET + (pidx[pid] + 0.5) * subGap;
const bandMid = (key) => bandTop(key) + LH / 2;
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const trunc = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const today = "2026-06-09";
const SEV = { low: "#3F8E7E", medium: "#C98A2B", high: "#D97757", critical: "#C0392B" };
let svg = "";

// ── month grid + today + steerco bands ────────────────────────────────────────
{ const d = new Date(minD.getFullYear(), minD.getMonth(), 1);
  while (d <= maxD) { const gx = x(d.toISOString().slice(0, 10));
    svg += `<line x1="${gx.toFixed(1)}" y1="${TA - 30}" x2="${gx.toFixed(1)}" y2="${HEIGHT - 18}" stroke="${GRID}" stroke-width="1"/>`;
    svg += `<text x="${(gx + 6).toFixed(1)}" y="${TA - 36}" font-size="11" fill="${MUTED}" font-family="ui-monospace,monospace">${d.toLocaleDateString("en-GB", { month: "short", year: "2-digit" })}</text>`;
    d.setMonth(d.getMonth() + 1); } }
const steerco = [];
{ const q = new Date(minD.getFullYear(), Math.ceil((minD.getMonth() + 1) / 3) * 3, 0);
  while (q <= maxD) { const iso = q.toISOString().slice(0, 10); steerco.push(iso);
    const gx = x(iso); svg += `<rect x="${(gx - 3).toFixed(1)}" y="${TA - 24}" width="6" height="${HEIGHT - TA + 6}" fill="${CORAL}" opacity="0.09"/>`;
    q.setMonth(q.getMonth() + 3); } }
{ const tx = x(today);
  svg += `<line x1="${tx.toFixed(1)}" y1="${TA - 30}" x2="${tx.toFixed(1)}" y2="${HEIGHT - 18}" stroke="${CORAL}" stroke-width="1.5" stroke-dasharray="3 3"/>`;
  svg += `<rect x="${(tx - 22).toFixed(1)}" y="${TA - 52}" width="44" height="16" rx="3" fill="${CORAL}"/><text x="${tx.toFixed(1)}" y="${TA - 40}" font-size="10" fill="#fff" text-anchor="middle" font-family="ui-monospace,monospace" font-weight="600">TODAY</text>`; }

// ── lane bands: label + faint per-project guide tracks ────────────────────────
for (const l of lanes) {
  const top = bandTop(l.key);
  svg += `<rect x="0" y="${top}" width="${WIDTH}" height="${LH}" fill="${lanes.indexOf(l) % 2 ? "#00000000" : "#0000000a"}"/>`;
  svg += `<text x="22" y="${top + LH / 2 - 4}" font-size="13" fill="${INK}" font-weight="600" font-family="ui-sans-serif,system-ui">${l.label}</text>`;
  const cnt = { milestone: milestones.length, task: tasks.length, risk: risks.length, issue: issues.length, decision: decisions.length, doc: documents.length, steerco: steerco.length }[l.key];
  svg += `<text x="22" y="${top + LH / 2 + 12}" font-size="10" fill="${MUTED}" font-family="ui-monospace,monospace">${cnt} nodes</text>`;
  if (l.key !== "steerco") for (const p of order) {
    const y = subY(l.key, p.id);
    svg += `<line x1="${LG}" y1="${y.toFixed(1)}" x2="${(WIDTH - RAIL_PAD + 40).toFixed(1)}" y2="${y.toFixed(1)}" stroke="${color[p.id]}" stroke-width="1" opacity="0.13"/>`;
  } else {
    svg += `<line x1="${LG}" y1="${bandMid("steerco").toFixed(1)}" x2="${(WIDTH - RAIL_PAD + 40).toFixed(1)}" y2="${bandMid("steerco").toFixed(1)}" stroke="${BORDER}" stroke-width="1.5"/>`;
  }
}

// ── glyphs ────────────────────────────────────────────────────────────────────
const diamond = (cx, cy, r, fill, stroke, sw = 1.8) => `<path d="M${cx.toFixed(1)} ${(cy - r).toFixed(1)} L${(cx + r).toFixed(1)} ${cy.toFixed(1)} L${cx.toFixed(1)} ${(cy + r).toFixed(1)} L${(cx - r).toFixed(1)} ${cy.toFixed(1)} Z" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
const tri = (cx, cy, r, fill, stroke) => `<path d="M${cx.toFixed(1)} ${(cy - r).toFixed(1)} L${(cx + r).toFixed(1)} ${(cy + r).toFixed(1)} L${(cx - r).toFixed(1)} ${(cy + r).toFixed(1)} Z" fill="${fill}" stroke="${stroke}" stroke-width="1.3" stroke-linejoin="round"/>`;
const hexg = (cx, cy, r, fill) => { const pts = []; for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + i * Math.PI / 3; pts.push(`${(cx + r * Math.cos(a)).toFixed(1)} ${(cy + r * Math.sin(a)).toFixed(1)}`); } return `<polygon points="${pts.join(" ")}" fill="${fill}" stroke="#fff" stroke-width="1.2"/>`; };
const docG = (cx, cy, fill) => `<rect x="${(cx - 4.5).toFixed(1)}" y="${(cy - 6).toFixed(1)}" width="9" height="12" rx="1.4" fill="${fill}" stroke="#fff" stroke-width="1"/>`;
const wrap = (title, inner) => `<g class="st"><title>${esc(title)}</title>${inner}</g>`;

const projMs = {};
for (const m of milestones) if (m.target_date) (projMs[m.project_id] ||= []).push(m);
for (const k in projMs) projMs[k].sort((a, b) => Dt(a.target_date) - Dt(b.target_date));
const nearestMs = (pid, iso) => { const a = projMs[pid] || []; if (!a.length) return null; let b = a[0], bd = Infinity; for (const m of a) { const d = Math.abs(Dt(m.target_date) - Dt(iso || today)); if (d < bd) { bd = d; b = m; } } return b; };
const criticalPid = (projects.find((p) => p.rag_status === "red") || projects.find((p) => p.rag_status === "amber") ||
  [...projects].sort((a, b) => (projMs[b.id]?.length || 0) - (projMs[a.id]?.length || 0))[0])?.id;

// ── per-project milestone lines (the metro lines) ─────────────────────────────
for (const p of order) {
  const arr = projMs[p.id] || []; if (!arr.length) continue;
  const y = subY("milestone", p.id), isCrit = p.id === criticalPid;
  for (let i = 1; i < arr.length; i++) {
    const x1 = x(arr[i - 1].target_date), x2 = x(arr[i].target_date);
    svg += `<line x1="${x1.toFixed(1)}" y1="${y.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${isCrit ? CORAL : color[p.id]}" stroke-width="${isCrit ? 4.5 : 2.5}" stroke-linecap="round" opacity="${isCrit ? 0.95 : 0.75}"/>`;
  }
  const last = arr.at(-1);
  svg += `<text x="${(x(last.target_date) + 16).toFixed(1)}" y="${(y + 3.5).toFixed(1)}" font-size="10.5" fill="${isCrit ? CORAL : INK}" font-weight="${isCrit ? 700 : 600}" font-family="ui-monospace,monospace">${esc(p.code)}${isCrit ? " · critical" : ""}</text>`;
}

// ── stations ──────────────────────────────────────────────────────────────────
for (const m of milestones) { if (!m.target_date) continue;
  const cx = x(m.target_date), cy = subY("milestone", m.project_id), c = color[m.project_id];
  if (m.baseline_target_date && m.baseline_target_date !== m.target_date) { const bx = x(m.baseline_target_date);
    svg += `<line x1="${bx.toFixed(1)}" y1="${cy.toFixed(1)}" x2="${cx.toFixed(1)}" y2="${cy.toFixed(1)}" stroke="${MUTED}" stroke-width="1" stroke-dasharray="2 2"/>` + diamond(bx, cy, 4.5, "none", MUTED, 1); }
  svg += wrap(`${m.name} · ${pcode[m.project_id]} · ${m.status} · ${m.completion_pct ?? 0}%`, diamond(cx, cy, 6.5, c, "#fff"));
  svg += `<text x="${cx.toFixed(1)}" y="${(cy - 10).toFixed(1)}" font-size="8.5" fill="${INK2}" text-anchor="middle" font-family="ui-sans-serif,system-ui">${esc(trunc(m.name, 14))}</text>`;
}
for (const t of tasks) { const d = t.due_date || t.start_date; if (!d) continue; const done = t.status_type === "completed";
  svg += wrap(`${t.name} · ${pcode[t.project_id]} · ${t.status_type} · ${t.completion_pct ?? 0}%`,
    `<circle cx="${x(d).toFixed(1)}" cy="${subY("task", t.project_id).toFixed(1)}" r="3.4" fill="${color[t.project_id]}" opacity="${done ? 0.95 : 0.4}" stroke="${color[t.project_id]}" stroke-width="1"/>`); }
for (const r of risks) { if (!r.raised_at) continue; const cx = x(r.raised_at), cy = subY("risk", r.project_id);
  if (r.severity === "high" || r.severity === "critical") { const m = nearestMs(r.project_id, r.raised_at);
    if (m) svg += `<path d="M${cx.toFixed(1)} ${(cy - 7).toFixed(1)} C${cx.toFixed(1)} ${((cy + subY("milestone", r.project_id)) / 2).toFixed(1)} ${x(m.target_date).toFixed(1)} ${((cy + subY("milestone", r.project_id)) / 2).toFixed(1)} ${x(m.target_date).toFixed(1)} ${(subY("milestone", r.project_id) + 7).toFixed(1)}" fill="none" stroke="${SEV[r.severity]}" stroke-width="1" stroke-dasharray="3 3" opacity="0.5"/>`; }
  svg += wrap(`${r.reference_id || "Risk"} · ${r.title} · ${r.severity} · ${pcode[r.project_id]}`, tri(cx, cy, 6.5, color[r.project_id], r.severity === "critical" ? "#C0392B" : "#fff")); }
for (const it of issues) { if (!it.raised_at) continue; svg += wrap(`${it.reference_id || "Issue"} · ${it.title} · ${it.priority} · ${pcode[it.project_id]}`, hexg(x(it.raised_at), subY("issue", it.project_id), 5.5, color[it.project_id])); }
for (const dc of decisions) { const d = dc.decided_at || dc.created_at; if (!d) continue; const cx = x(d), cy = dc.project_id ? subY("decision", dc.project_id) : bandMid("decision"), c = dc.project_id ? color[dc.project_id] : MUTED;
  svg += wrap(`${dc.reference_id || "Decision"} · ${dc.title} · ${dc.status}`, `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="7" fill="${SURFACE}" stroke="${c}" stroke-width="1.8"/>` + diamond(cx, cy, 3.5, c, "none", 0)); }
for (const dd of documents) { if (!dd.created_at) continue; svg += wrap(`${dd.reference_id || "Doc"} · ${dd.title} · ${dd.doc_type} · ${dd.status}`, docG(x(dd.created_at), dd.project_id ? subY("doc", dd.project_id) : bandMid("doc"), dd.project_id ? color[dd.project_id] : MUTED)); }
steerco.forEach((iso) => { const cy = bandMid("steerco");
  svg += wrap(`SteerCo gate · ${new Date(iso).toLocaleDateString("en-GB", { month: "long", year: "numeric" })}`, `<rect x="${(x(iso) - 9).toFixed(1)}" y="${(cy - 9).toFixed(1)}" width="18" height="18" rx="3" fill="${CORAL}" stroke="#fff" stroke-width="2"/>`);
  svg += `<text x="${x(iso).toFixed(1)}" y="${(cy + 26).toFixed(1)}" font-size="9.5" fill="${INK2}" text-anchor="middle" font-family="ui-monospace,monospace">SteerCo · ${new Date(iso).toLocaleDateString("en-GB", { month: "short" })}</text>`; });

// ── cross-project clash interchanges (lines jumping between projects) ─────────
for (const c of clashes) { if (!c.project_a_id || !c.project_b_id) continue;
  const ma = nearestMs(c.project_a_id, c.window_start), mb = nearestMs(c.project_b_id, c.window_start); if (!ma || !mb) continue;
  const x1 = x(ma.target_date), y1 = subY("milestone", c.project_a_id), x2 = x(mb.target_date), y2 = subY("milestone", c.project_b_id);
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  svg += `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)} Q${mx.toFixed(1)} ${(my - 22).toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}" fill="none" stroke="${INK2}" stroke-width="1.4" stroke-dasharray="5 3" opacity="0.7"/>`;
  svg += wrap(`${c.reference_id || "Clash"} · ${c.title} · ${c.type} · ${pcode[c.project_a_id]} ⇄ ${pcode[c.project_b_id]}`, `<circle cx="${mx.toFixed(1)}" cy="${(my - 22).toFixed(1)}" r="6.5" fill="${SURFACE}" stroke="${INK2}" stroke-width="2"/><circle cx="${mx.toFixed(1)}" cy="${(my - 22).toFixed(1)}" r="2.3" fill="${INK2}"/>`);
}

// ── legend ──────────────────────────────────────────────────────────────────
let legend = "";
order.forEach((p, i) => { const lx = (i % 3) * 320, ly = Math.floor(i / 3) * 20;
  legend += `<rect x="${lx}" y="${ly}" width="13" height="13" rx="3" fill="${color[p.id]}"/><text x="${lx + 19}" y="${ly + 11}" font-size="11.5" fill="${INK}" font-family="ui-sans-serif,system-ui"><tspan font-family="ui-monospace,monospace" fill="${INK2}">${esc(p.code)}</tspan>  ${esc(trunc(p.name, 26))}</text>`; });

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Mainline — portfolio prototype</title>
<style>
 body{margin:0;background:${CANVAS};color:${INK};font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
 .top{padding:20px 28px 8px}
 h1{font-size:20px;margin:0 0 2px;letter-spacing:-.01em}.sub{color:${INK2};font-size:13px;margin:0 0 14px}
 .gl{display:flex;flex-wrap:wrap;gap:13px;margin-top:10px;font-size:11.5px;color:${INK2}}
 .scroll{overflow-x:auto;padding:0 8px 26px}
 svg .st{cursor:pointer;transition:transform .12s}svg .st:hover{transform:scale(1.5);transform-box:fill-box;transform-origin:center}
 .foot{padding:6px 28px 30px;color:${INK2};font-size:12.5px;max-width:1000px;line-height:1.65}
 code{background:#fff;border:1px solid ${BORDER};border-radius:4px;padding:1px 5px;font-size:11.5px}
</style></head><body>
 <div class="top">
  <h1>Mainline <span style="color:${MUTED};font-weight:400">— portfolio governance throughline</span></h1>
  <p class="sub">Rails = artifact type · each project = its own colored line · time → · ${projects.length} projects · static prototype on live seed (hover any station)</p>
  <svg width="960" height="${Math.ceil(N / 3) * 20}">${legend}</svg>
  <div class="gl"><span>◇ milestone</span><span>● task (filled = done)</span><span>▲ risk</span><span>⬢ issue</span><span>◎ decision</span><span>▭ doc</span><span>▣ SteerCo</span><span style="color:${CORAL};font-weight:700">━━ critical path</span><span>┄◯┄ clash interchange</span><span>┈ baseline / slip</span></div>
 </div>
 <div class="scroll"><svg width="${WIDTH.toFixed(0)}" height="${HEIGHT}" font-family="ui-sans-serif,system-ui"><rect width="${WIDTH.toFixed(0)}" height="${HEIGHT}" fill="${CANVAS}"/>${svg}</svg></div>
 <div class="foot"><b>What this is:</b> every governance artifact across the whole portfolio on one horizontal map. Each rail is an artifact type; inside it, every project runs as its own parallel colored line. Milestone diamonds chain along each line; the <span style="color:${CORAL};font-weight:700">coral line</span> is the computed critical path. Dashed feeders angle up from high/critical risks into the milestone they threaten (fishbone). Dashed arcs jumping between lines are <b>cross-project clash interchanges</b>. Coral bands + ▣ are SteerCo gates; the dashed coral vertical is Today.
 <br><br><b>Spec, not yet built (your call):</b> <code>Trace mode</code> — click a node → its full upstream/downstream web lights, rest dims · Week/Month/Quarter zoom · click → opens the existing inspector · real dependency edges (task graph currently empty) · live <code>GET /api/timeline</code> feed.</div>
</body></html>`;
const out = path.join(here, "mainline-prototype.html");
writeFileSync(out, html, "utf8");
console.log("wrote", out, "·", (html.length / 1024).toFixed(0) + "kb · width", WIDTH.toFixed(0), "· DAYW", DAYW.toFixed(1), "· span", span);
