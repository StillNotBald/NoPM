# UC-30 · Cross-project dependencies and contingency

**Goal:** Let a project manager say that one project depends on another. A project that is not red, but depends (directly or through other projects) on a red project, is shown as contingent in the portfolio. The declared health of every project stays where a person set it.

**Actors:** Project manager, with project write access, to declare a dependency. Anyone with project read access sees the portfolio marker and the chain.

**Preconditions:** Migration 0099 is applied before the new build is deployed. Both projects are in the same workspace. Dependencies can be declared on a locked project, because the locked schedule does not change.

**Trigger:** One project cannot finish until another delivers, releases a resource, takes a decision, or closes a risk. The portfolio should show that at a glance.

## Main flow

1. Open the project that waits on the other one. Open the **Project dependencies** panel.
2. Choose the other project, the kind (delivery, resource, decision or risk) and, optionally, a risk that records why the dependency matters. Add a short note if needed.
3. Select **Add dependency**. The row appears under "depends on". The other project's code, name and declared RAG show beside it.
4. Open **Portfolio**. A project that is not red and is contingent on a red project shows an amber **Contingent** tag. Hovering the tag names the red project. The project's own health colour and label do not change.
5. Open **Mainline**, Network lens. Project dependencies are drawn between the projects, and the caption says so.
6. Read the chain on the project page, or call `GET /api/projects/{id}/contingency`. The chain runs from this project to the red one, up to five hops.
7. Remove a dependency from the same panel when it no longer applies.

## Alternate and exception flows

- **Dependency on the same project** → `422` `self_dependency`.
- **The other project or the risk belongs to another workspace** → `422` `invalid_reference`. The refusal reads the same whether the id is missing or foreign.
- **The linked risk is in neither project** → `422` `risk_not_in_projects`.
- **The link would close a loop, of any length and kind** → `422` `circular_dependency`. The database also refuses it.
- **The same pair with the same kind already exists** → `409` `duplicate_dependency`.
- **Removing a dependency that is not under this project** → `404`.

## Postconditions

- Adding a dependency writes one `project.dependency.add` audit row, with the row in after.
- Removing one writes one `project.dependency.remove` audit row, with the row in before.
- No declared RAG is changed by any dependency.

## Evidence produced

- The `project_dependencies` row, with the kind, the optional linked risk and the note.
- The two audit rows above.

## API calls

- `GET /api/projects/{id}/dependencies` lists both directions (scope `project:read`).
- `POST /api/projects/{id}/dependencies` adds one (scope `project:write`), body `depends_on_project_id`, `kind`, optional `linked_risk_id` and `note`.
- `DELETE /api/projects/{id}/dependencies/{depId}` removes one (scope `project:write`).
- `GET /api/projects/{id}/contingency` returns the declared RAG, the worst RAG among dependencies, whether the project is contingent on red, and the chain (scope `project:read`).
- `GET /api/timeline` returns `projectDependencies` and edges of kind `dependency`.

## Reporting and evidence

- Contingency is advisory. The marker is a suggestion, and the declared health is changed only by a person.
- The contingency walk is transitive, to a depth of five, and it stops if it meets a cycle. The response says when the depth limit was reached.

## Traceability

- R-IDs: R-147 (cross-project dependencies and contingency, audit gap B5).
- Key files: `web/supabase/migrations/20261018000099_project_dependencies.sql`, `web/src/app/api/projects/[id]/dependencies/route.ts`, `web/src/app/api/projects/[id]/contingency/route.ts`, `web/src/lib/insight/project-contingency.ts`, `web/src/lib/insight/program-rollup.ts`, `web/src/components/tracking/project-dependencies-panel.tsx`, `web/src/components/mainline/dependency-lens.tsx`.

## Open questions

- The portfolio shows a contingent tag only. It does not yet show how many days of slip the red project would pass on.
