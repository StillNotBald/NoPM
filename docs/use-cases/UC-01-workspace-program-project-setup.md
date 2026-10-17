# UC-01 · Workspace, program, and project setup

**Goal:** Stand up a project (optionally under a named program) inside a workspace so that milestones, tasks, and the rest of the governed record can hang off it.

**Actors:** Admin, Project Manager. AI agent via token can also perform every write step here with `project:write` / `program:write`.

**Preconditions:** The actor has a signed-in session (or a Bearer token) scoped to the target workspace. Every table in the schema carries `workspace_id` with row-level security, so a workspace boundary always exists before a project can be created (R-06). A workspace itself is not created through a console flow; it exists as the top-level RLS boundary the rest of the schema hangs off.

**Trigger:** A Project Manager needs to start tracking a new piece of delivery work.

## Main flow

1. (Optional) Create a program to group related projects. UI: `/portfolio` → **New Program** button (`web/src/components/forms/new-program-button.tsx`, which opens `program-form.tsx`); or `POST /api/programs` (scope `program:write`); or `nopm` (no dedicated CLI group confirmed `[UNVERIFIED]`). Body: `name` required, plus optional `code`, `owner_id` (must be a `resource_members` id, not a `profiles` id), `rag_status`.
2. Create the project. UI: `/projects` → "New Project" button, opening a form (`web/src/components/forms/project-form.tsx`) with Name, Code, Program, Phase, Currency, RAG Status, Start Date, Target Date, Baseline Start, Baseline Target, Sponsor, Project Manager, Objective, Business Case, Scope Summary, Health Commentary. This posts to `POST /api/projects` (scope `project:write`). `code` (1-32 chars, unique short identifier, e.g. `NBC-H`) and `name` are required; `rag_status` must be one of `not_started|red|amber|green|complete`; `phase` one of `initiation|planning|execution|monitoring|closing`; dates `YYYY-MM-DD`; `currency` a 3-letter ISO code.
3. CLI equivalent: `nopm projects create --name "Network Modernisation" --code NBC-H [--program <p>] [--rag green] [--phase planning] [--start 2025-01-01] [--target 2025-12-31]`.
4. MCP equivalent: `create_project` tool, scope `project:write`.
5. The new project lands on its own detail page `/projects/[id]` with eight tabs: Charter, Overview, Activity, Board, Gantt, Risks, Issues, History (`web/src/app/(console)/projects/[id]/page.tsx`, verified via `user-manual/operator/02-projects-and-tasks.md`).
6. If the project belongs to a program, the Portfolio page (`/portfolio`) groups it under that program's `<ProgramRollupCard>`, showing completion %, budget variance, actual vs planned cost, and allocated-vs-capacity hours (R-71). A project with no `program_id` falls back to the legacy text `program` field, then "Ungrouped".

## Alternate and exception flows

- **Missing `code` or `name` on create** → `422` validation error with a `fields` array naming the missing field.
- **Caller lacks `project:write` / `program:write`** → `403` scope error, never a partial write.
- **Viewer role** → any create attempt is rejected `403` at the guard layer regardless of endpoint (`requireScope`).
- **Duplicate program grouping key** — a project's `program` text label and `program_id` can diverge; the Portfolio page reconciles by falling back through `program_id` → legacy `program` text → "Ungrouped" rather than erroring.
- **Declared vs computed program health diverge** — a program's `rag_status` is set independently of the computed rollup from its child projects; the rollup card shows both side by side and flags a "Diverges" badge when they disagree (R-71).

## Postconditions

- One `project.create` audit row (and one `program.create` row if a program was created), each with `before: null` and `after:` the full inserted row, workspace-scoped.
- The project appears immediately in `GET /api/projects` and on `/projects`, `/portfolio`, and `/dashboard`.
- Trust Center (`/trust`) shows the `project.create` row with the actor, timestamp, and a "History" deep-link back to the project.

## Reporting and evidence

- The Portfolio page's program rollup cards are the primary multi-project reporting surface for this use case.
- `GET /api/export?entity=programs` provides a governed CSV export of every program (no filter params; fixed name-ascending order).
- Every project row also carries the external-reference seam (`source`/`external_ref`/`external_url`, R-81) so a project can name the upstream Jira/Slack/Teams item it mirrors without NoPM syncing to it.

## Traceability

- R-IDs: R-06 (workspace RLS isolation), R-10 (Projects CRUD), R-71 (Programs).
- Key files: `web/src/app/api/projects/route.ts`, `web/src/app/api/projects/_schema.ts`, `web/src/app/api/programs/route.ts`, `web/src/app/api/programs/_schema.ts`, `web/src/components/forms/project-form.tsx`, `web/src/components/forms/program-form.tsx`, `web/src/components/forms/new-program-button.tsx`, `web/src/lib/insight/program-rollup.ts`, `web/src/components/portfolio/program-rollup-card.tsx`, `web/src/app/(console)/portfolio/page.tsx`.
- Tests: scope registry validation and RLS-isolation invariants are covered under R-60's governance-invariant vitest suite (`web/src/lib/auth/scopes.test.ts` and the admin-client workspace-isolation guard test), not a use-case-specific test file.

## Open questions

- `[UNVERIFIED]` Whether the `nopm` CLI has a dedicated `programs` command group; `cli/README.md`'s quoted list of module command groups does not explicitly name "programs" alongside risks/issues/clashes/resources/etc.
