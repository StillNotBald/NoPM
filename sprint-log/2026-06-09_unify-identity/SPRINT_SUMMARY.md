# Sprint — Unify person identity: assignment ↔ capacity ↔ cost (2026-06-09)

**Intent:** the feature review + the My Tasks rehearsal exposed a real modelling split — `tasks.assignee_id` referenced **profiles** (logins), but the whole UI (task-form picker, activity table, board) treats the assignee as a **resource_member** (the costed, capacity-bearing person). So task assignment never connected to capacity (allocations) or cost (cost_rate/EVM). This unifies them into **one identity**.

## Done
- **Migration `0019`** — re-pointed `tasks.assignee_id` FK from `profiles(id)` → `resource_members(id)` (cleared the old profile-id values first). A resource_member optionally links to a login via `resource_members.profile_id`. One identity across assignment, capacity, and cost.
- **Login ↔ member bridge** (`seed-people-link.mjs`) — links the 3 login profiles (the admin, Priya Nair, Daniel Okoro) to resource_members (profile_id set; created the admin's member with role + cost_rate + capacity), assigns open tasks to members (weighting the demo admin to ~25%), and gives each login member a starter allocation. Result: admin login → the admin's member → **22 open tasks across all 6 projects**; load spread across all 6 members.
- **My Work + My Tasks bridge** — both filtered `assignee_id = profileId` (wrong after 0019); now resolve the login's resource_member(s) via `profile_id` and filter tasks by those member ids. (My Work already fetched the member but ignored it — fixed.)
- **Resources view** — new **Open Tasks** column per member, so assigned work sits beside capacity (allocation %) and cost (rate) on one row — the unified identity made visible.
- **Side benefit:** the in-project activity table / board now **resolve assignee names** (assignee_id is a member id, which the members map already keys on) — previously they'd have shown blank.
- Seed pipeline made coherent: removed the old profile-based assignment from `seed.mjs`, deleted superseded `seed-assignments.mjs`, documented the run order (… → seed-people-link → …).

## Verification
- `tsc --noEmit` clean · `next build` clean · migration `0019` applied · RTM green (**43 R-IDs / 165 paths**; added R-44).
- `auth-smoke` **19/19** authenticated; live: My Tasks (admin) **6/6** project groups, Resources Open-Tasks column present, admin's linked member shown.
- Data: `assignee_id` resolves to member names; per-member load — the admin 22 [login], Priya 10 [login], Daniel 10 [login], Carlos 10, Elena 11, Marcus 10.

## Open / deferred
- Task assignment doesn't yet *roll up hours* into allocation % (assigning N tasks doesn't auto-increase a member's allocation/over-allocation). A future step: derive load from `estimate_hours` vs `capacity_hours_per_week`. The identity is now unified, so this is a clean follow-on.
- `owner_id` (milestones/risks/projects) intentionally stays → profiles (ownership = a governance/login role, distinct from "who does the work").

## Status
Iron-triangle identity is now coherent: the person you assign a task to is the same person who carries capacity and cost — assignment, utilization, and EVM share one resource_member, bridged to a login.
