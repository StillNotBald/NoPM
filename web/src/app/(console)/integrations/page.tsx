import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PageContainer } from "@/components/ui/page-container";
import { PageHeader } from "@/components/ui/page-header";
import { IntegrationsConsole } from "@/components/integrations/integrations-console";

export const metadata = { title: "Integrations" };

/**
 * Integrations — connect Lark / Feishu (approve from chat, weekly digest),
 * link your own Lark account, and subscribe to milestones from any calendar
 * app. A thin server shell (title + sign-in guard); every read and write goes
 * through the governed REST API from the client console, so this page holds no
 * data access of its own.
 */
export default async function IntegrationsPage() {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");

  return (
    <PageContainer>
      <PageHeader title="Integrations" />
      <IntegrationsConsole />
    </PageContainer>
  );
}
