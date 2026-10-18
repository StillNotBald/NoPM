# Owner-visible changes — audit-gap programme (CR-2026-10-18-01)

Every row is a change the owner or a user can see, or a change that alters what an existing caller receives. The lead flips **Status** from `planned` to `built` after review. Kind is one of `added`, `removed`, `hidden`, `renamed`, `re-ordered` or `behaviour`.

## Wave 1 — foundation (schema integrity, lean payloads, access review)

| Change | Kind | Where | Why | Agent | Status |
|---|---|---|---|---|---|
| Preset agent token gains `risk:write`, `issue:write` and `project:write`. It never gains approve or decide scopes. Tokens minted from the preset are broader than before. | behaviour | Tokens page, one-click agent preset | Assumption A5 (CR-2026-10-18-01) | W1-B | planned |
| Risk `category` is no longer accepted or returned by the API. It is no longer shown on the risk form or the risks list. | removed | Risk API, risk form, risks list | Assumption A4; K1. Column kept until a later release drops it. | W1-B | planned |
| List routes return a summary by default (projects, risks, issues, tasks, milestones). Callers that relied on full records must ask for `?view=full`. | behaviour | List API routes, and the MCP `list_*` tools | K5: lean payloads | W1-B | planned |
| List routes accept `?view=summary`, `?view=full` and `?fields=<comma list>`. | added | List API routes, and the MCP `list_*` tools | K2, K4: callers choose the fields they need | W1-B | planned |
| People panel gains an **Export people (CSV)** button. The button renders for anyone who can open the panel. Only an admin or manager session can export; a member who clicks gets a 403. | added | Settings → People panel | M5, M3 (export half) | W1-C | planned |
| Members export is refused for member-role users with a message that names the permission needed. | behaviour | Members export address | M5: access review | W1-C | planned |
| Tokens page gains an **Export tokens (CSV)** button. The file lists labels, scopes and dates, never the token value. Admins only. | added | Tokens page | M3 (export half) | W1-C | planned |
| Trust Center audit CSV gains a `principal_id` column. The column names the human behind an agent or token action. | added | Trust Center → Audit export | M3 audit CSV columns; K3 traceability | W1-C | planned |
| The project lock badge names the person or token that locked the project. | behaviour | Project header lock badge | M7: lock integrity | W1-A | planned |
| Existing locks gain their locker from the audit history. Locks with no audit row show the label "legacy lock (locker not recorded)". | behaviour | Project lock badge, for locks made before this release | M7 backfill of `locked_by` from audit rows | W1-A | planned |
| Unlock refused for members now says who can unlock (managers and admins) instead of a generic refusal. | renamed | Unlock error message | M7 | W1-A | planned |
| Lock and unlock attempts through an agent token record the token label as the locker. | behaviour | Lock API and the audit trail | M7; assumption A6 keeps lock semantics | W1-A | planned |
| People page gains a second button, **Export chat links (CSV)**. | added | Settings → People panel | M3 (export half) | W1-C | planned |
| Export gains a new `identities` entity (CSV). | added | Export API | M3 (export half) | W1-C | planned |
| Every export entity accepts `from`, `to` and `on` date-range filters. | behaviour | Export API, all CSV entities | M3 (export half) | W1-C | planned |
| The audit CSV gains five columns, not only `principal_id`. | added | Trust Center → Audit export | M3 audit CSV columns | W1-C | planned |
| Risk form: the single Impact Area dropdown becomes a checkbox group (several areas per risk). | behaviour | Risk create and edit form | K1, K2: `impact_areas[]` | W1-B | planned |
| Risk form: the "Category (free text)" field is removed. | removed | Risk create and edit form | Assumption A4 | W1-B | planned |
| Risk register gains an "Impact area" filter (single select). The risks page accepts `?impact_area=a,b` to match any of the listed areas. | added | Risks register page and risks list API | K2 | W1-B | planned |
| Risk detail: the label "Impact Area" is renamed "Impact Areas" and shows a comma list. | renamed | Risk detail page | K2 | W1-B | planned |
| Project Risks tab sub-line shows `risk_category` in place of `category`. | behaviour | Project Risks tab | Assumption A4 | W1-B | planned |
| CLI: all `ls` commands send `view=full`, so CLI output is unchanged. | behaviour | CLI `ls` commands | K5: lean payloads | W1-B | planned |
| CLI: new flags `--risk-category` and `--impact-area a,b`. | added | CLI risk commands | K1, K2 | W1-B | planned |
| CLI: the `--category` flag is removed. | removed | CLI risk commands | Assumption A4 | W1-B | planned |
| MCP `create_risk` and `update_risk` gain `risk_category` and `impact_areas` parameters. | added | MCP server tools | K1, K2 | W1-B | planned |
| New audit action `four_eyes.legacy_requester_unknown` appears in the Trust Center stream. It is written only when a legacy approval has no known requester. | added | Trust Center activity stream | M1 audit completeness | W1-C | planned |
| Token unlock refusal has its own text: "Agents and API tokens cannot" unlock. | renamed | Unlock error message for tokens | M7 | W1-A | planned |
| Database: a locked project can no longer exist without a locker (CHECK). Unlock clears the locker. | behaviour | Project lock state, all unlock paths | M7 lock integrity | W1-A | planned |
| Hard-deleting a risk or issue needs the new `risk:delete` or `issue:delete` scope. The agent preset can lock a project but never unlock or delete. | behaviour | API scopes and Tokens page help text | Wave 1 fix pass: scope boundary | W1-B | planned |

## Wave 2 — change-request evidence chain

Rows added when wave 2 starts.

| Change | Kind | Where | Why | Agent | Status |
|---|---|---|---|---|---|

## Wave 3 — runs without you

Rows added when wave 3 starts.

| Change | Kind | Where | Why | Agent | Status |
|---|---|---|---|---|---|

## Wave 4 — governance tiers, deletion flow, atomic audit, work events

Rows added when wave 4 starts. Assumptions A1, A3 and A8 land here.

| Change | Kind | Where | Why | Agent | Status |
|---|---|---|---|---|---|
