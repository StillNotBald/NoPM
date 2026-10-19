# W5-I notes for W5-H (OpenAPI and llms)
- `GET /api/workspace-settings`: `approval_policy` no longer contains `emergency_retro_hours`. Update `openapi.json/route.ts` line 824 (remove it from the listed fields) and `llms.txt/route.ts` line 314.
- `PATCH /api/workspace-settings`: `emergency_retro_hours` is still accepted and ignored (never validated, never stored, never returned). Keep it named as retired in line 837 and `llms.txt` line 93.
- `openapi.json/route.ts` line 192 says it is "deprecated and has no effect"; reword to "retired".
- No other contract changes. Change-request status `emergency` stays in lists until the CUTOVER/12 live check.
