// Recent-projects store backed by localStorage.
// Cap: 6 entries, deduplicated by id, newest-first.

export type RecentProject = { id: string; name: string; code: string };

const STORAGE_KEY = "nopm.nav.recent-projects";
const MAX = 6;

function read(): RecentProject[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as RecentProject[];
  } catch {
    return [];
  }
}

function write(items: RecentProject[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    /* ignore quota errors */
  }
}

export function getRecentProjects(): RecentProject[] {
  return read();
}

export function addRecentProject(project: RecentProject): void {
  const existing = read().filter((p) => p.id !== project.id);
  write([project, ...existing].slice(0, MAX));
}
