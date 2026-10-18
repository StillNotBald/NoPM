/**
 * The deployed build, for GET /api/health — so "is live equal to main?" can be
 * answered from outside without trusting a status page (audit L-02).
 *
 * Vercel injects VERCEL_GIT_COMMIT_SHA / VERCEL_GIT_COMMIT_REF at build and run
 * time; self-hosters (Docker, `next start`) can bake NEXT_PUBLIC_BUILD_SHA into
 * the image instead. Read from the environment only — no git call, no DB, no
 * filesystem — so the liveness probe stays instant and dependency-free.
 */
export interface BuildInfo {
  sha: string | null;
  ref: string | null;
}

function clean(value: string | undefined): string | null {
  const v = value?.trim();
  return v ? v : null;
}

export function readBuildInfo(env: Record<string, string | undefined> = process.env): BuildInfo {
  return {
    sha: clean(env.VERCEL_GIT_COMMIT_SHA) ?? clean(env.NEXT_PUBLIC_BUILD_SHA),
    ref: clean(env.VERCEL_GIT_COMMIT_REF),
  };
}
