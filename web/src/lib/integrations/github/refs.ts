/** The external reference format a GitHub pull request is linked to a task by (R-153). */

export const GITHUB_REF_PREFIX = "github:";
const REPO_PART = "[A-Za-z0-9_.-]{1,100}";
const REF_RE = new RegExp(`^github:(${REPO_PART})/(${REPO_PART})#([1-9][0-9]{0,8})$`);

export type PullRef = { owner: string; repo: string; number: number };

export function formatPullRef(p: PullRef): string {
  return `${GITHUB_REF_PREFIX}${p.owner}/${p.repo}#${p.number}`;
}

export function parsePullRef(value: string): PullRef | null {
  const m = REF_RE.exec(value.trim());
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

/**
 * Turn what a person types into the stored reference. Accepts `owner/repo#123`, `github:owner/repo#123`
 * and a pull request URL. Stored lower-case: GitHub owner and repository names are case-insensitive.
 */
export function normalizePullRefInput(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  const url = new RegExp(`^https://github\\.com/(${REPO_PART})/(${REPO_PART})/pull/([1-9][0-9]{0,8})(?:[/?#].*)?$`, "i").exec(text);
  if (url) return formatPullRef({ owner: url[1], repo: url[2], number: Number(url[3]) }).toLowerCase();
  const short = new RegExp(`^(?:github:)?(${REPO_PART})/(${REPO_PART})#([1-9][0-9]{0,8})$`).exec(text);
  if (short) return formatPullRef({ owner: short[1], repo: short[2], number: Number(short[3]) }).toLowerCase();
  return null;
}

/** Both spellings a task may carry, so a mixed-case reference set by an API client still matches. */
export function lookupCandidates(p: PullRef): string[] {
  const exact = formatPullRef(p);
  const lower = exact.toLowerCase();
  return exact === lower ? [exact] : [exact, lower];
}
