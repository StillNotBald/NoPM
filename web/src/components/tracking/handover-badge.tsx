import Link from "next/link";
import { UserX } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";

/**
 * "No backup owner" badge for a project header (M6, R-140). Self-contained: it
 * reads the one column it needs, so the page does not have to select it, and it
 * renders nothing when the project has a backup, when the read fails, or when the
 * column is not there yet (a build served a moment before migration 0095).
 */
export async function HandoverBadge({ projectId }: { projectId: string }) {
  let missing = false;
  try {
    const db = await createClient();
    const { data, error } = await db
      .from("projects")
      .select("backup_owner_id")
      .eq("id", projectId)
      .maybeSingle();
    missing = !error && !!data && !data.backup_owner_id;
  } catch {
    return null;
  }
  if (!missing) return null;
  return (
    <Link href="/handover" title="Name a backup owner so this project runs without one person" className="inline-flex">
      <Badge tone="warning" className="flex items-center gap-1">
        <UserX className="size-3" aria-hidden="true" />
        No backup owner
      </Badge>
    </Link>
  );
}
