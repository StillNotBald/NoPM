# Decisions — RESOLVED (2026-07-11)

All locked with the owner in the ASK round (or directly in chat where noted).

1. **Demo LLM provider = OpenRouter, same API key as the reference demo site** (owner, in chat).
   Free-tier model (`nvidia/nemotron-3-super-120b-a12b:free`), account deliberately holds zero
   credits = hard spend ceiling. New `openrouter.ts` adapter (raw fetch, no new lib). ~50 req/day
   cap SHARED with the reference demo — accepted; fallback carries overflow.
2. **Fallback = grounded answers** (ASK). Deterministic intent matcher over 2–3 read-only
   intents, through the same ephemeral-scoped-token path, rate-limited, persisted like a normal
   turn, demo-mode labeled. Never a 500, never hallucinated data, never a spliced chimera reply
   (mid-stream deaths after tokens flushed → sanitized error + retry affordance).
3. **Demo chat privacy = fresh chat each visit** (ASK). Demo visitors: no saved-conversation
   list, no cross-visit persistence. BYOK users unchanged. No migration.
4. **Demo reset = nightly GitHub Action** (ASK) running new `npm run seed:all` (8 scripts,
   documented order, includes purging demo-user assistant conversations). Manual command also
   available.
5. **Mobile search entry = header search icon** (ASK), visible < sm, opens palette full-screen.
6. **"Anonymous visitor" = session-based** via existing R-53 one-click demo login (recommended,
   unopposed). `requireAuth` stays untouched; no sessionless public endpoint.
7. **X-Demo-Mode header on non-streaming path only**; streaming keeps `usedDemoKey` in the
   `done` event (headers are already sent before the stream resolves).
8. **Auth-gating: patch the two unguarded client pages** (`settings`, `tokens`) with one shared
   client-safe guard; no middleware centralization.
9. **Trust Center stays off the 4-slot bottom nav** (palette + Apps sheet reach it).
10. **Touch targets: targeted subset** (header + assistant panel chrome); rest logged as debt.
11. **Kanban mobile = horizontal scroll** with min-width tracks, `lg:` carve-out preserves the
    current desktop 5-col fluid grid; + KeyboardSensor & non-drag status path (WCAG 2.1.1).
12. **Theme ground truth = macOS-terminal-light**; constitution's stale cream/coral lines
    corrected this initiative (owner drove the retheme 2026-06-08; docs never caught up).
