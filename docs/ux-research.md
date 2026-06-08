# NoPM — UX research (cross-tool RAG) → design rules

Synthesized from Linear · Asana · ClickUp · Monday · Jira · Smartsheet · MS Project · Height · Notion · TeamGantt, through an Apple/iOS lens. Used to refine the enrichment (forms, activity table, Gantt, project page) — keep it **lite + calm**, not enterprise-bloated.

## Three highest-leverage rules
1. **Cap hierarchy at 2 levels (Task → Subtask); ~5 default columns.** Milestone is the grouping band, so the tree never feels deep. (Reject ClickUp infinite nesting / every-field-on-every-row.)
2. **Keyboard-command model = agent/API model.** `Cmd/Ctrl-K` palette + `C`-to-create + `J/K/X/E` list nav. The same discrete commands scoped agent tokens drive.
3. **Default-calm, opt-in-power.** Timeline not full-Gantt; dependencies/critical-path/baseline as toggles (off by default); AI/agent changes shown in a distinct **pending → human-confirm** (maker-checker) state.

## Forms
- Title-first; everything else optional inline property chips with smart defaults from context. Required = title only.
- Centered modal-sheet for global create (`C`); persistent **right side-panel** for task detail (non-blocking, triage down a list).
- Inline **"+ Add"** ghost row at list bottom; Enter commits + reopens a fresh row.
- **Autosave on blur** for edits (no Save button); fold first-N-min of edits into "creation" so the audit log isn't spammed.
- Field pickers = lightweight popovers, never stacked modals. AVOID: all fields shown by default, long accordion forms, blocking modals for quick add.

## Activity / task table
- Clean **indented list**, not a visible grid: thin tree connectors, no heavy cell borders; hover reveals edit affordances; click-into-cell = inline edit with Tab/arrow nav + always-available Esc (no keyboard traps).
- Sticky milestone group bands + column headers; expand/collapse with iOS motion; collapsed parent shows a roll-up progress pill.
- 5 default columns (Title, Status, Assignee, Due, Progress); more behind a quiet "+". Density toggle (Comfortable default) outside the table.
- Bulk-edit via multi-select + floating action bar; drag-reorder/re-parent with clear drop indicator. AVOID: 3+ nesting, spreadsheet chrome, every column on by default.

## Gantt / timeline
- Default **Timeline** (bars + milestones + today line); "Full Gantt" toggle adds dependencies/critical-path. Week/Month calm defaults; Day/Quarter optional.
- Rounded soft-shadow bars with lighter progress fill; milestones = diamonds; **one accent per status** (not a rainbow).
- Direct-manipulation (later): drag move, edge resize, drag-handle to link; **FS arrows** privileged, switch to Jira-style end-badges when dense. Baseline = faint ghost bar; critical path = single highlight only when toggled.
- Collapsible left grid, scroll-synced; mobile = read-only horizontal-scroll. AVOID: arrow spaghetti, permanent critical path, MS-Project density by default.

## Project detail / overview
- **Quiet header:** name + status pill + lead + target date + one progress ring + health dot. One line, whitespace — no metrics wall.
- **Tab/view-switcher** (iOS segmented): fixed **Overview** home + List · Timeline · Board (+ Risks/Issues as quiet tabs). One click, capped count.
- **Overview = a document, not a dashboard:** summary → description → milestones → a few "at a glance" cards (progress, scope-creep line, dates, open risks/issues).
- **Updates feed** (health + newest-first) is where the **immutable audit trail** and **agent actions** surface human-readably for maker-checker review.
- Inline-editable properties in a right rail (Linear `Cmd-I`); one obvious "+ New task" per view + global `C`. AVOID: widget-grid dashboards as default, crowded header, scattered create buttons.

## Apple/iOS lens (cross-cutting)
Clarity · Deference (chrome recedes, content is hero) · Depth. SF type, hierarchy by weight not color, ~15–17px body, tabular numerals for dates/budget. 8pt grid, hairline dividers, soft shadows, large radii, white+grey + one accent. Progressive disclosure is the anti-bloat lever. Motion 200–250ms iOS curves, respect reduced-motion. Touch targets ≥44px; tables/Gantt → mobile cards / read-only timeline. **Maker-checker as UX:** agent proposes in a "pending" style, human confirms before commit.
