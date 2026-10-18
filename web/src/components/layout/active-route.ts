/**
 * Is `href` the current route or one of its children? ("/tasks" is active on
 * "/tasks" and "/tasks/123", never on "/tasks-archive".) One rule for the
 * sidebar and the bottom nav; mirrors the Essentials-mode check in
 * lib/nav/nav-config.ts.
 */
export function isActiveRoute(href: string, pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}
