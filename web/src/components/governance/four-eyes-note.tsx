import { CircleAlert } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * The one place the four-eyes rule is worded in the console.
 *
 * The rule (decided server-side by `lib/governance/decide.ts`): the person who
 * decides must be a DIFFERENT person from the one who raised the request. A
 * token counts as the person who created it, so you cannot approve what your
 * own agent raised. The server also tells each page, per row, whether the
 * viewer can decide and why not (`lib/review/four-eyes.ts`), and this note is
 * what renders that answer: in place of Approve / Reject, never beside them.
 *
 * Presentational and server-renderable (no hooks); the types live here so
 * client components can import them without pulling in server code.
 */

/** Why the viewer cannot decide an item. */
export type FourEyesBlock =
  | "you_raised"
  | "your_token_raised"
  | "no_scope"
  | "role_not_permitted"
  | "needs_admin"
  | "project_locked"
  | "no_principal";

/** What the server worked out for one item and the signed-in viewer. */
export interface DecideState {
  canDecide: boolean;
  /** Why not; null whenever `canDecide` is true. */
  block: FourEyesBlock | null;
  /**
   * The viewer is the exact actor that raised a deletion request, so they may
   * withdraw it (the one self-decision four-eyes permits). A request raised by
   * the viewer's token is NOT withdrawable from a session: only that token can.
   */
  canWithdraw: boolean;
}

/** Fallback for callers that were not given a verdict (e.g. a pre-verdict row). */
export const CAN_DECIDE: DecideState = { canDecide: true, block: null, canWithdraw: false };

export const BLOCK_COPY: Record<FourEyesBlock, { lead: string; rest: string; detail?: string }> = {
  you_raised: {
    lead: "You raised this (or your token did)",
    rest: " — a different person must decide.",
  },
  your_token_raised: {
    lead: "You raised this (or your token did)",
    rest: " — a different person must decide.",
    detail: "Your token raised it, and a token counts as the person who created it.",
  },
  no_scope: {
    lead: "Your role can view this, not decide it",
    rest: ". Ask a member or admin.",
  },
  role_not_permitted: {
    lead: "Only managers and admins can approve",
    rest: ". Ask a manager or admin.",
  },
  needs_admin: {
    lead: "Only an admin can decide this",
    rest: ". Ask an admin.",
  },
  project_locked: {
    lead: "Project is locked",
    rest: " — unlock it or rebaseline first.",
  },
  no_principal: {
    lead: "This sign-in isn't tied to a person",
    rest: ", so it can't decide (four-eyes). Sign in as yourself.",
  },
};

/** The sentence that states the rule when the viewer is allowed to decide. */
export function ruleText(verb: "raised" | "submitted" = "raised"): string {
  return `A different person from the one who ${verb} it must decide. A token counts as the person who created it, so you cannot decide what your own agent raised.`;
}

export function FourEyesNote({
  block,
  verb = "raised",
  variant = "box",
  className,
}: {
  /** Set when the viewer cannot decide; omit to state the rule. */
  block?: FourEyesBlock | null;
  /** "raised" (default) or "submitted" in the rule sentence. */
  verb?: "raised" | "submitted";
  /**
   * box: tinted callout with icon (inspectors). inline: tinted text, no box
   * (dense rows). quiet: muted page-level line stating the rule.
   */
  variant?: "box" | "inline" | "quiet";
  className?: string;
}) {
  const copy = block ? BLOCK_COPY[block] : null;

  const body = copy ? (
    <>
      <span className="font-semibold">{copy.lead}</span>
      {copy.rest}
      {copy.detail && <span className="mt-0.5 block">{copy.detail}</span>}
    </>
  ) : (
    <>
      <span className="font-semibold">Four-eyes:</span>{" "}
      {ruleText(verb)}
    </>
  );

  if (variant === "inline") {
    return <p className={cn("text-xs leading-snug text-warning-ink", className)}>{body}</p>;
  }
  if (variant === "quiet") {
    return <p className={cn("text-sm text-ink-muted [&>span:first-child]:text-ink-secondary", className)}>{body}</p>;
  }

  return (
    <div
      role="note"
      className={cn(
        "flex gap-2.5 rounded-md border border-warning/30 bg-warning/10 px-3 py-2.5 text-xs leading-snug text-warning-ink",
        className,
      )}
    >
      <CircleAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
      <p>{body}</p>
    </div>
  );
}
