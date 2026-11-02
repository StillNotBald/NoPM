/**
 * Untrusted tool-result wrapping (audit A1, step 1).
 *
 * Everything a tool returns can contain text written by other people (task
 * names, document bodies, comments, risk text). Before it goes back to the
 * model it is wrapped in an explicit delimiter, and the system prompt tells the
 * model that anything inside is data, never instructions.
 *
 * Breakout is prevented by escaping every "<" in the JSON as a backslash-u escape. That is
 * still valid JSON that parses to the same value, but injected text can no
 * longer close the wrapper or open a fake one.
 */

export const TOOL_RESULT_TAG = "tool_result";

/** Backslash + "u003c": the JSON escape for "<". (0x5c is a backslash.) */
const ESCAPED_LT = String.fromCharCode(0x5c) + "u003c";

/** Safe attribute value for the tool name (the name is model output, so it is sanitised too). */
function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "unknown";
}

/** Wrap serialized JSON from a tool in untrusted-data delimiters. */
export function wrapUntrustedToolResult(toolName: string, json: string): string {
  const escaped = json.replace(/</g, ESCAPED_LT);
  return `<${TOOL_RESULT_TAG} tool="${safeName(toolName)}" untrusted="true">\n${escaped}\n</${TOOL_RESULT_TAG}>`;
}

/** Inverse of the wrapper, for tests and diagnostics: the JSON inside, parsed. */
export function unwrapToolResult(content: string): unknown {
  const open = content.indexOf(">\n");
  const close = `\n</${TOOL_RESULT_TAG}>`;
  if (!content.startsWith(`<${TOOL_RESULT_TAG} `) || open < 0 || !content.endsWith(close)) {
    throw new Error("not a wrapped tool result");
  }
  return JSON.parse(content.slice(open + 2, content.length - close.length));
}
