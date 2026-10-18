# W3-D OpenAPI / llms.txt notes (for the docs agent)

New routes (all `{data}` / `{error}` contract, workspace-filtered):

- `GET /api/projects/{id}/dependencies` - scope `project:read`. Returns an array. Each item: `id, workspace_id, project_id, depends_on_project_id, kind (delivery|resource|decision|risk), linked_risk_id, note, created_by, created_at, updated_at, direction (depends_on|depended_on_by), other_project {id, code, name, rag_status}`. 404 when the project is not in the caller's workspace.
- `POST /api/projects/{id}/dependencies` - scope `project:write`. Body `{ depends_on_project_id (uuid, required), kind (enum, required), linked_risk_id (uuid|null, optional), note (string max 500|null, optional) }`. 201 with the row. Errors: 404 project not found; 422 validation (`fields`); 422 `self_dependency`; 422 `invalid_reference` (other project or risk not in this workspace); 422 `risk_not_in_projects` (risk must belong to one of the two projects); 422 `circular_dependency`; 422 `cross_workspace` (database backstop); 409 `duplicate_dependency` (same pair and kind). Allowed on a locked project. Audit: `project.dependency.add` (target_type project, before null, after the row).
- `DELETE /api/projects/{id}/dependencies/{depId}` - scope `project:write`. 204. 404 when the dependency is not under this project in this workspace. Allowed on a locked project. Audit: `project.dependency.remove` (before the row, after null).
- `GET /api/projects/{id}/contingency` - scope `project:read`. Returns `{ project_id, declared_rag, worst_dependency_rag (red|amber|not_started|green|complete|null), contingent_on_red (boolean), chain [{id, code, name, rag_status}] (from this project to the red project, empty when not contingent), depth_capped (boolean) }`. Transitive, depth at most 5, cycle-safe. Advisory: never changes a declared RAG.

Changed: `GET /api/timeline` response gains `projectDependencies: [{ id, projectId, dependsOnProjectId, kind, note }]`, and `edges[].kind` gains the value `dependency` (milestone-to-milestone, label = dependency kind). Existing edge kinds are unchanged.

Audit glossary: `project.dependency.add`, `project.dependency.remove` (already added to `action-glossary.ts`).

Use-case note: declare a dependency, see the contingent marker on the Portfolio, read the chain on the project page or via the contingency route. The marker is a suggestion; the declared health is changed only by a person.
