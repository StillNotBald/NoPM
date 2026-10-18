# Sprint — Wave 4 + 4.5: Review Queue + Documents (real file storage) (2026-06-09)

**Intent:** the predecessor-platform reuse — kill the PM "long email trail" with one **Review Queue** of every pending decision, and add a **Documents register** with **real, governed file storage**. Built by two AI-agent waves on disjoint files (Wave 4: docs-data · review-queue · docs-ui; Wave 4.5: storage-api · storage-ui) + verify passes; integrated + seeded + deployed by hand. Nav wiring kept off the agents to avoid sidebar collisions.

## Done
- **Review Queue** (`/review`, governance nav): `lib/review/gather.ts` fans out 5 governed sources via `Promise.allSettled` — pending deletion_requests, `pending_approval` rebaselines, `in_review` documents, high/critical open risks, unresolved clashes — into one priority-sorted queue (approvals + critical first), grouped by kind with count chips, each row deep-linking to its action. This is the answer to the PM email-trail pain.
- **Documents register** (`/documents`, primary nav): migration `0015` — `documents` table (folder, doc_type, status draft|in_review|approved|archived, version, owner, reference_id DOC-NNN, markdown body, external_url) + workspace RLS. CRUD API (`/api/documents` GET/POST, `/api/documents/[id]` GET/PATCH/DELETE) — `route()` + `requireScope(document:*)` + `writeAudit`. Folder-tree viewer (folder → doc_type), right-push viewer with markdown render + status/version + provenance, create/edit form.
- **Real file storage** (Wave 4.5): migration `0016` — 4 nullable file columns + a **private** `documents` bucket (25 MB). Bytes flow through **signed URLs**, never our compute: `POST …/file/sign` (mint signed upload URL after workspace+size check) → browser PUTs to Storage → `POST …/file` (record metadata + audit `document.file.attach`); `GET …/file` mints a 60 s signed download URL and 302-redirects (works as iframe/img/download src); `DELETE …/file` removes + audits. Inline PDF/image preview, download for other types.
- **Interlock:** a document in `in_review` surfaces in the Review Queue → click → opens that doc via `?doc={id}`.
- **Seed:** `seed-documents.mjs` (19 PMO docs across Meridian Global — charters, RAID logs, status reports, change-control log + CRs, steering minutes; several `in_review` so the queue is populated) + `seed-document-files.mjs` (dependency-free PDF builder attaches a real, previewable PDF to **all 19**).
- **Migration tooling:** `scripts/migrate.mjs` — derives the direct DB connection from `.env.local` and delegates to `apply-migrations.mjs`.

## Verification
- `tsc --noEmit` clean · `next build` clean (41 pages incl. /review, /documents, the file routes) · migrations 0015 + 0016 applied to prod DB.
- Storage round-trip proven: signed-URL fetch → 200, valid `%PDF-` bytes, size matches the row.
- Deployed to stillnotbald.com (Wave 4 + 4.5 shipped together — Documents was not deployed half-done).
- RTM green: **37 R-IDs** (added R-38 Review Queue, R-39 Documents+storage) — `npm run rtm:verify`.
- ADR **0005-documents-file-storage** records the register+real-files decision + signed-URL governance.

## Open / deferred
- Right-push viewer holds a document snapshot; after a **live** attach/remove the panel may need reopening to reflect it (`router.refresh()` updates page data, not the open snapshot) — Wave 6 polish.
- 25 MB/file cap; no server-side virus scan (demo workspace).
- Owner demo LLM key (Wave 3 assistant) still to be configured (`NOPM_DEMO_LLM_*`).

## Next
- Wave 5: change-control register + decision log (greenlit as v1 MVP).
