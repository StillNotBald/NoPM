/**
 * The honest lifecycle of a board move, kept out of the component so it can be
 * tested.
 *
 *   drop ─▶ "saving" ─▶ API 2xx ─▶ "saved"   ("moved — audited ✓", then cleared)
 *                    └▶ API error / network down ─▶ cleared, card put back, reason shown
 *
 * The board used to show "moved — audited ✓" the instant a card was dropped,
 * before the PATCH had answered, and swallowed any rejection (lock, scope,
 * rule) by silently snapping the card back. "Audited" is only true once the
 * server has accepted the write (every accepted mutation writes one audit row),
 * so it now appears only after a 2xx.
 */

export type MoveState = "saving" | "saved";
export type MoveStates = ReadonlyMap<string, MoveState>;

export function withMove(states: MoveStates, id: string, state: MoveState | null): MoveStates {
  const next = new Map(states);
  if (state === null) next.delete(id);
  else next.set(id, state);
  return next;
}

/** Clear the "saved" note, but only if no newer move has taken the card over. */
export function expireSaved(states: MoveStates, id: string): MoveStates {
  return states.get(id) === "saved" ? withMove(states, id, null) : states;
}

/** Why the API refused a move, in its own words (it answers `{ error }`), else the status. */
export async function rejectionReason(res: Pick<Response, "status" | "json">): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body?.error === "string" && body.error) return body.error;
  } catch {
    // not JSON
  }
  if (res.status === 403) return "You don't have permission to change this task.";
  if (res.status === 401) return "Your session has expired.";
  return `The server answered ${res.status}.`;
}

export type PersistResult = { ok: true } | { ok: false; reason: string };

/** PATCH the new status. Never throws: a refusal and a dead network are both `ok: false` with a reason. */
export async function persistMove(
  taskId: string,
  statusType: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PersistResult> {
  try {
    const res = await fetchImpl(`/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status_type: statusType }),
    });
    if (!res.ok) return { ok: false, reason: await rejectionReason(res) };
    return { ok: true };
  } catch {
    return { ok: false, reason: "The server could not be reached." };
  }
}

/** The toast / live-region text for a refused move: what failed, why, and where the card went. */
export function failureMessage(opts: {
  name: string;
  toTitle: string;
  fromTitle: string;
  reason: string;
}): string {
  return `Couldn't move "${opts.name}" to ${opts.toTitle}: ${opts.reason} It is back in ${opts.fromTitle}.`;
}
