import type { WorkEventKind } from "./rules";

/**
 * Turn a GitHub delivery into the work events NoPM acts on (R-153): `pull_request` (opened, reopened,
 * closed, merged) and `deployment_status` (success, failure). Pure and defensive: the payload is
 * untrusted JSON, every field is shape-checked, and a delivery yields at most MAX_EVENTS_PER_DELIVERY events.
 */

/** Pull requests ACTED ON per delivery; the rest (up to MAX_PARSED_PER_DELIVERY) are recorded as truncated. */
export const MAX_EVENTS_PER_DELIVERY = 5;
export const MAX_PARSED_PER_DELIVERY = 25;

export type ParsedWorkEvent = {
  kind: WorkEventKind;
  /** `owner/repo` */
  repo: string;
  /** Pull request number, or null for a deployment that names none. */
  number: number | null;
  /** GitHub login of whoever acted, or null. */
  login: string | null;
};

const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const prNumber = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 999_999_999 ? v : null;

function loginOf(user: unknown): string | null {
  if (!isRec(user) || typeof user.login !== "string") return null;
  return LOGIN_RE.test(user.login) ? user.login : null;
}

function repoOf(payload: Record<string, unknown>): string | null {
  const repository = payload.repository;
  if (!isRec(repository) || typeof repository.full_name !== "string") return null;
  return REPO_RE.test(repository.full_name) ? repository.full_name : null;
}

/** Pull request numbers a deployment names: its payload (`pr`, `pr_number`, `pull_request`, `prs`) or a `refs/pull/N/...` / `pr-N` ref. */
export function deploymentPullNumbers(deployment: Record<string, unknown>): number[] {
  const found = new Set<number>();
  const add = (v: unknown) => {
    const n = prNumber(typeof v === "string" && /^[1-9][0-9]{0,8}$/.test(v) ? Number(v) : v);
    if (n !== null) found.add(n);
  };
  let payload: unknown = deployment.payload;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      payload = null;
    }
  }
  if (isRec(payload)) {
    add(payload.pr);
    add(payload.pr_number);
    if (isRec(payload.pull_request)) add(payload.pull_request.number);
    else add(payload.pull_request);
    for (const key of ["prs", "pull_requests"] as const) {
      const list = payload[key];
      if (Array.isArray(list)) for (const item of list.slice(0, 20)) add(isRec(item) ? item.number : item);
    }
  }
  if (typeof deployment.ref === "string") {
    const m = /(?:^|\/)(?:refs\/pull\/|pull\/|pr[-_/])([1-9][0-9]{0,8})(?:\/|$)/i.exec(deployment.ref);
    if (m) add(m[1]);
  }
  return [...found];
}

export function parseGithubDelivery(eventName: string, payload: unknown): ParsedWorkEvent[] {
  if (!isRec(payload)) return [];
  const repo = repoOf(payload);
  if (!repo) return [];
  const login = loginOf(payload.sender);

  if (eventName === "pull_request") {
    const pr = payload.pull_request;
    const number = isRec(pr) ? prNumber(pr.number) : null;
    if (number === null || !isRec(pr)) return [];
    const action = payload.action;
    if (action === "opened" || action === "reopened") return [{ kind: "pr_opened", repo, number, login }];
    if (action === "closed") return [{ kind: pr.merged === true ? "pr_merged" : "pr_closed", repo, number, login }];
    return [];
  }

  if (eventName === "deployment_status") {
    const status = payload.deployment_status;
    const deployment = payload.deployment;
    if (!isRec(status) || !isRec(deployment)) return [];
    const state = status.state;
    const kind: WorkEventKind | null =
      state === "success" ? "deploy_success" : state === "failure" || state === "error" ? "deploy_failure" : null;
    if (!kind) return [];
    const actor = loginOf(status.creator) ?? login;
    const numbers = deploymentPullNumbers(deployment).slice(0, MAX_PARSED_PER_DELIVERY);
    if (numbers.length === 0) return [{ kind, repo, number: null, login: actor }];
    return numbers.map((number) => ({ kind, repo, number, login: actor }));
  }

  return [];
}
