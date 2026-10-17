/** Paging + caps for /approvals. Pending is never paged (it is the work queue); Decided is. */

/** Safety cap on the pending queue. Supabase caps a response at 1000 rows anyway; saying so beats a silent cut. */
export const PENDING_CAP = 1000;
export const DECIDED_PAGE_SIZE = 50;

/** `?page=` -> a positive integer (1 when absent or malformed). */
export function parsePage(v: string | undefined): number {
  if (!v || !/^\d{1,6}$/.test(v)) return 1;
  const n = Number.parseInt(v, 10);
  return n >= 1 ? n : 1;
}

/** Clamp the requested page to the last one that exists for `total` rows, and give its inclusive row range. */
export function pageWindow(
  requested: number,
  total: number,
  pageSize = DECIDED_PAGE_SIZE,
): { page: number; lastPage: number; from: number; to: number } {
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, requested), lastPage);
  const from = (page - 1) * pageSize;
  return { page, lastPage, from, to: from + pageSize - 1 };
}
