# OpenAPI and llms.txt wording for W5-A (R-161, R-162)

No request or response shape changes: same paths, bodies, status codes and error codes. Only descriptions gain a sentence. Wave 3 applies them.

## OpenAPI descriptions (append to the existing description, one sentence each)

- `DELETE /api/projects/{id}`, `DELETE /api/tasks/{id}`, and the delete verbs of risks, issues, expenses, documents and milestones: "The deletion request and its audit entry are saved together; if the audit entry cannot be written, no request is created."
- `POST /api/deletion-requests/{id}/withdraw` and `POST /api/deletion-requests/{id}/reject`: "The status change and its audit entry are saved together; if the audit entry cannot be written, the request stays pending."
- `POST /api/projects/{id}/change-requests`, `PATCH /api/change-requests/{id}`, `DELETE /api/change-requests/{id}`: "The change and its audit entry are saved together. A change request that was decided while you were editing or deleting it is refused with 422 `change_request_decided`."
- `POST /api/projects/{id}/rebaselines`: "The proposal, its audit entry and its decision deadline are saved together. A second proposal while one waits for sign-off is 409 `pending_rebaseline_exists`."

## llms.txt (one line in the governance section)

"Every governed write (deletion requests, change requests, rebaselines) is saved in one step with its audit entry, so an agent never sees a change that has no trail."
