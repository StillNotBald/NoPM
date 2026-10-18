"use client";

import { PageHeader } from "@/components/ui/page-header";
import { PageContainer } from "@/components/ui/page-container";
import { PeoplePanel } from "@/components/people/people-panel";
import { useRequireSession } from "@/lib/auth/use-require-session";
import { useMyRoleState } from "@/lib/nav/use-my-role";
import { canSeeNavHref } from "@/lib/nav/nav-config";

export default function PeoplePage() {
  const status = useRequireSession();
  const { role, ready } = useMyRoleState();
  if (status !== "authenticated" || !ready) return null;
  // The people API is admin/manager-only, so members and viewers get a clear state, not a failing list.
  const allowed = canSeeNavHref("/people", role);
  return (
    <PageContainer width="narrow" className="space-y-6">
      <PageHeader title="People" />
      {allowed ? (
        <PeoplePanel />
      ) : (
        <p role="note" className="text-sm text-ink-secondary">
          Only admins and managers can manage people.
        </p>
      )}
    </PageContainer>
  );
}
