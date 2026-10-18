// Wave-5 Pre-1: the security and integrations slice of the M1 atomicity exception list (owner: builder W5-B).
// MFA, connectors, GitHub connector, assistant token, invites, identities (12 entries).
// Each line is one handler or library file that still writes first and audits second.
// Delete a line here the moment that entry becomes atomic; atomicity.test.ts fails until you do.
// The three slices never share a file, so parallel builders never collide.
import type { AtomicityException } from "./atomicity-exceptions";
import { ex } from "./atomicity-exceptions";

export const EXCEPTIONS: Record<string, AtomicityException> = {
  "auth/mfa/challenge#POST": ex("lead (decision needed)", "writes user_mfa state then audits; user_mfa is per-user security state, not an allowlisted table"),
  "auth/mfa/disable#POST": ex("lead (decision needed)", "writes user_mfa state then audits; user_mfa is per-user security state, not an allowlisted table"),
  "auth/mfa/enroll#POST": ex("lead (decision needed)", "writes user_mfa state then audits; user_mfa is per-user security state, not an allowlisted table"),
  "auth/mfa/verify#POST": ex("lead (decision needed)", "writes user_mfa state then audits; user_mfa is per-user security state, not an allowlisted table"),
  "integrations/connectors#POST": ex("route group 2 agent", "connector create: integration_connectors is allowlisted, the handler still writes then audits"),
  "integrations/connectors/[id]#PATCH": ex("route group 2 agent", "connector update/rotate: integration_connectors is allowlisted, the handler still writes then audits"),
  "integrations/github/connector#POST": ex("work-events wave", "GitHub connector create: writes then audits"),
  "integrations/github/connector#PATCH": ex("work-events wave", "GitHub connector update: writes then audits"),
  "integrations/github/connector#DELETE": ex("work-events wave", "GitHub connector revoke: writes then audits"),
  "lib/assistant/token.ts": ex("route group 2 agent", "mints and revokes the assistant's ephemeral api_tokens row, then audits; api_tokens is allowlisted"),
  "lib/governance/invite-accept.ts": ex("route group 2 agent", "revokes the invite when account creation fails after nopm_accept_invite, then audits; invites is allowlisted"),
  "lib/integrations/identity.ts": ex("route group 2 agent", "link-code consume and external_identities insert / revoke, then audit; external_identities is allowlisted"),
};
