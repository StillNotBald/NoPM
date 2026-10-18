# OpenAPI and llms.txt wording - W5-C (atomic unattended jobs)

Apply in `web/src/app/api/openapi.json/route.ts` and `web/src/app/llms.txt/route.ts` during the docs pass. No request or response shape changes; this is wording only.

## Cron endpoints

- `GET /api/cron/snapshots` and `GET /api/integrations/cron`: add one sentence. "Every change a cron run makes is written together with its audit row in one database transaction: a run that cannot write its audit row changes nothing and answers with the failure, so the next tick retries."
- `GET /api/cron/snapshots`: keep "ONE `snapshot.taken` row per workspace per run". Add: "It is written by the same transaction as the snapshot rows. A replay the same day inserts no snapshot and still writes its own run-level row with `taken: 0`."
- `GET /api/integrations/cron` (weekly report part): "A scheduled weekly report claims its recipients, stores the report and writes `report.weekly.generated` in one transaction, once per workspace and ISO week. A replayed tick changes nothing and writes no audit row."

## Audit actions (Trust Center and `GET /api/audit` wording)

- `clash.auto_detected`, `clash.auto_resolve`, `budget.overspend`: "Written in the same transaction as the change they describe. The actor is the person or token whose allocation or expense write triggered the check."
- `snapshot.taken`, `report.weekly.generated` (scheduled): "The actor is the system job (`system:snapshots`, `system:weekly-report`, no human principal)."

## llms.txt

- Under the audit paragraph: one line, "Automatic clashes, overspend crossings, nightly snapshots and the weekly report are audited in the same transaction as the change; there is no automatic change without its audit row."
