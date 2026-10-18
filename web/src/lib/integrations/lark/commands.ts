/**
 * Bot DM command parsing. The bot understands three things and nothing else
 * (PLAN D9) — `help`, `link <code>`, `approvals` — so this is a tiny, pure,
 * allow-list parser: no natural language, no argument beyond the link code, and
 * anything unrecognised becomes `unknown` (the handler answers with help).
 *
 * Text arrives as the `content` JSON string of an `im.message.receive_v1`
 * event (`{"text":"…"}` for message_type "text"; other types carry no text and
 * are answered with help).
 */

export type BotCommand =
  | { kind: "help" }
  | { kind: "approvals" }
  /** `code` is null when the user typed `link` with a missing or malformed code. */
  | { kind: "link"; code: string | null }
  | { kind: "unknown" };

/** Link codes look like `NPL-ABCD-1234` (the hub validates the real thing; this is a shape check). */
const CODE_SHAPE = /^[A-Z0-9][A-Z0-9-]{5,31}$/;
const BARE_CODE = /^NPL-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

const HELP_WORDS = new Set(["help", "h", "?", "hi", "hello", "hey", "start", "commands", "menu"]);
const APPROVAL_WORDS = new Set(["approvals", "approval", "pending", "inbox"]);

/** Pull the plain text out of a message `content` JSON string; null when there is none. */
export function extractMessageText(messageType: string, content: unknown): string | null {
  if (messageType !== "text" || typeof content !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(content);
    const text = parsed && typeof parsed === "object" ? (parsed as { text?: unknown }).text : null;
    return typeof text === "string" ? text : null;
  } catch {
    return null;
  }
}

function normalise(text: string): string {
  return (
    text
      // Full-width / compatibility forms (common in CJK input methods) → ASCII.
      .normalize("NFKC")
      // Zero-width characters and mention placeholders such as `@_user_1`.
      .replace(/[\p{Cf}\p{Zl}\p{Zp}]/gu, "")
      .replace(/@_user_\d+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      // `/help`, `/nopm help`, `nopm help`
      .replace(/^\/?(?:nopm\b[\s:,-]*)?\/?/i, "")
      .trim()
  );
}

export function parseCommand(text: string | null | undefined): BotCommand {
  if (!text) return { kind: "unknown" };
  const cleaned = normalise(text);
  if (!cleaned) return { kind: "unknown" };

  if (BARE_CODE.test(cleaned.toUpperCase())) return { kind: "link", code: cleaned.toUpperCase() };

  const [first, ...rest] = cleaned.split(" ");
  const lowered = first.toLowerCase();
  // "help?" / "help!" → "help"; a lone "?" stays "?".
  const word = lowered.replace(/[.!?]+$/g, "") || lowered;

  if (word === "link" || word === "bind") {
    const candidate = rest.join("").toUpperCase();
    return { kind: "link", code: CODE_SHAPE.test(candidate) ? candidate : null };
  }
  if (rest.length === 0 && HELP_WORDS.has(word)) return { kind: "help" };
  if (rest.length === 0 && APPROVAL_WORDS.has(word)) return { kind: "approvals" };
  return { kind: "unknown" };
}
