# ADR 0005 — Documents = governed register + real file storage (signed URLs)

- **Status:** Accepted
- **Date:** 2026-06-09

## Context

The predecessor-platform-reuse wave called for a "document folder viewer." Two readings were possible: (a) a metadata-only **document control register** (folder, version, approval status, owner, provenance) over generated/linked artifacts, or (b) **real file storage** — upload, store, preview, download actual files. The first interpretation was shipped first (register + Review Queue); the user then explicitly required **actual file storage**.

Document storage was not in the original v1 module list, so per the constitution's "STOP and ask" rule it was surfaced and confirmed before building.

## Decision

A document is **governed metadata _plus_ an optional real file** — not either/or. The register (`documents` table, migration 0015) carries folder / doc_type / status / version / owner / reference_id / markdown body / provenance; migration 0016 adds `storage_path / file_name / mime_type / file_size` and a **private** Supabase Storage bucket (`documents`, 25 MB cap, no public access).

**All file access flows through the governed API; bytes never touch our compute:**
- **Upload** is a 3-step dance: `POST /api/documents/[id]/file/sign` validates workspace ownership + size, then mints a short-lived **signed upload URL**; the browser PUTs the bytes straight to Supabase Storage; `POST /api/documents/[id]/file` records the metadata and writes an audit row (`document.file.attach`). This sidesteps the ~4.5 MB serverless body limit and keeps large files off our functions.
- **Download / preview** is `GET /api/documents/[id]/file` — it checks the actor owns the document's workspace, mints a 60-second **signed download URL**, and 302-redirects. Same-origin session cookies authenticate it, so the URL works directly as an `<iframe>` (PDF), `<img>` (image), or download `href`. The bucket itself is never public.
- **Remove** (`DELETE …/file`) deletes the object and clears the columns, audited `document.file.remove`.

The bucket has **no storage RLS policies** by design: only the service-role admin client touches it, exclusively to mint signed URLs after the API has already authorized the caller. Governance lives in the API layer (consistent with the rest of NoPM), not in storage ACLs.

## Consequences

- NoPM now has a real document repository with **governance over the files** (workspace isolation, audit on every attach/remove, approval status, version) — a stronger PMO-governance story than a dumb file tree.
- A new infra dependency: a Supabase Storage bucket. Created idempotently in migration 0016 (`insert … on conflict do nothing`), so `npm run migrate` provisions it with the schema — no manual console step.
- The register work (Wave 4) was **not** wasted; it became the control layer over the bytes.
- Limitations accepted for v1: 25 MB/file cap; the right-push viewer panel holds a snapshot of the document, so after a live attach/remove the panel may need reopening to reflect the change (`router.refresh()` updates page data but not the open snapshot) — flagged for Wave 6 polish; no server-side virus scanning (demo workspace, trusted users).
- Seed attaches a generated single-page PDF to every demo document (dependency-free PDF builder in `scripts/seed-document-files.mjs`), so the folder viewer shows live, previewable files with no manual upload.
