# W2-A OpenAPI / llms.txt notes (for the docs agent)

New route: `POST /api/change-requests/{id}/implement` (M2)
- Scope `change:write`. Allowed for the requester's person, or a manager or admin (the human behind a token counts). Needs a principal.
- Body (optional): `{ note?: string | null }`, max 2000 characters.
- Response `{ data: ChangeRequest }` with `status: "implemented"`, `implemented_at`, `implemented_by`, `implemented_by_type`, `implemented_by_id`, `implemented_by_label`, `implemented_principal_id`, `implemented_note`.
- Errors: 403 `no_principal` (token with no recorded owner), 403 `not_requester`, 404, 422 `invalid_transition` (not approved), 422 `already_implemented` (repeat, never re-stamped), 422 validation.
- One database transaction (`nopm_implement_change_request`, migration 0092): status move, stamp and audit row `change_request.implement`. `implemented_at` is never earlier than `decided_at` (CHECK).
- ChangeRequest schema gains: `implemented_at` (date-time, nullable), `implemented_by` (uuid, nullable, users only), `implemented_by_type`, `implemented_by_id`, `implemented_by_label`, `implemented_principal_id`, `implemented_note`, `impact_scope`. The `status` enum gains `implemented`. The text that says "status needs a decider, so approved / rejected / deferred / implemented are reached through ..." should now say `implemented` is reached through POST `/implement`, the others through `/decision`.

Changed: `POST /api/projects/{id}/change-requests`, `PATCH /api/change-requests/{id}`: new optional field `impact_scope` (nullable array, one entry per area, max 6): `{ area: scope|schedule|cost|quality|resources|compliance, direction: increase|decrease|neutral, note?: string|null (max 2000) }`. `impact_summary` is unchanged. Editing `impact_scope` on a pending request re-issues the approval card.

Changed: `POST /api/projects/{id}/decisions`, `PATCH /api/decisions/{id}`, and the Decision schema (all optional, nullable):
- `change_request_id` uuid. Must be a change request in the caller's workspace and on the decision's project, else 422 `invalid_reference` with `fields[0].field = change_request_id`.
- `options_structured` array (max 20) of `{ label: string 1-200, chosen?: boolean (default false), note?: string|null (max 2000) }`; at most one `chosen`, labels unique (case-insensitive). The free-text `options` stays; both are returned.
- PATCH is still refused on an accepted or superseded decision (existing rule), so link a decision while it is proposed or when recording it.

Changed: list views. The `fields=` allow-list (and `view=full`) for change requests gains `impact_scope`, `implemented_at`, `implemented_by_label`, `implemented_note`; for decisions it gains `change_request_id`, `options_structured`. The summary view gains `implemented_at` (change requests) and `change_request_id` (decisions).

Audit: new action `change_request.implement` (glossary entry added). `change_request.update`, `decision.create` and `decision.update` carry the new fields in `after`.
