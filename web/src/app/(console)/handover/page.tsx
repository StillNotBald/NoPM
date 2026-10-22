import Link from "next/link";
import { redirect } from "next/navigation";
import { Download } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { PageContainer } from "@/components/ui/page-container";
import { PageHeader } from "@/components/ui/page-header";
import {
  gatherHandover,
  type HandoverDb,
  type HandoverItem,
  type KeyPerson,
  type ProjectHandover,
} from "@/lib/handover/report";

export const metadata = { title: "Handover" };

const TYPE_LABEL: Record<HandoverItem["type"], string> = {
  project: "Project", risk: "Risk", issue: "Issue", task: "Task",
};
const SHOWN_PER_OWNER = 6;

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

function ItemLine({ item }: { item: HandoverItem }) {
  return (
    <li className="flex min-w-0 items-baseline gap-2 text-sm">
      <span className="w-14 shrink-0 font-mono text-2xs uppercase tracking-wide text-ink-muted">
        {TYPE_LABEL[item.type]}
      </span>
      <span className="min-w-0 break-words text-ink">
        {item.reference ? <span className="font-mono text-ink-secondary">{item.reference} </span> : null}
        {item.title}
      </span>
    </li>
  );
}

function ItemList({ items }: { items: HandoverItem[] }) {
  const shown = items.slice(0, SHOWN_PER_OWNER);
  return (
    <ul className="space-y-1.5">
      {shown.map((it) => (
        <ItemLine key={`${it.type}-${it.id}`} item={it} />
      ))}
      {items.length > shown.length ? (
        <li className="text-xs text-ink-muted">and {items.length - shown.length} more</li>
      ) : null}
    </ul>
  );
}

function ProjectCard({ p }: { p: ProjectHandover }) {
  const gaps = p.without_backup + p.unowned;
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border-subtle px-4 py-3 sm:px-5">
        <Link href={`/projects/${p.project.id}`} className="min-w-0 break-words text-sm font-medium text-ink hover:underline">
          {p.project.code ? <span className="font-mono text-ink-secondary">{p.project.code} </span> : null}
          {p.project.name}
        </Link>
        <Badge tone={gaps === 0 ? "success" : "warning"} size="sm">
          {gaps === 0 ? "Covered" : `${plural(gaps, "gap")} of ${plural(p.open_items, "open item")}`}
        </Badge>
      </div>
      {gaps === 0 ? (
        <p className="px-4 py-3 text-sm text-ink-muted sm:px-5">
          Every open item here has an owner and a backup.
        </p>
      ) : (
        <div className="divide-y divide-border-subtle">
          {p.owners.map((g) => (
            <div key={g.person.key} className="space-y-2 px-4 py-3 sm:px-5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-medium text-ink">{g.person.label}</span>
                <span className="text-xs text-ink-muted">
                  solely owns {plural(g.counts.total, "open item")}
                </span>
              </div>
              <ItemList items={g.items} />
            </div>
          ))}
          {p.unowned_items.length > 0 ? (
            <div className="space-y-2 px-4 py-3 sm:px-5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-medium text-ink">No owner</span>
                <span className="text-xs text-ink-muted">{plural(p.unowned_items.length, "open item")}</span>
              </div>
              <ItemList items={p.unowned_items} />
            </div>
          ) : null}
        </div>
      )}
    </Card>
  );
}

function PersonCard({ k }: { k: KeyPerson }) {
  return (
    <Card className="px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="text-sm font-medium text-ink">{k.person.label}</span>
        {k.bus_factor_1 ? <Badge tone="danger" size="sm">Single point of failure</Badge> : <Badge tone="success" size="sm">Backed up</Badge>}
      </div>
      <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
        <div>
          <dt className="text-ink-muted">Solely own</dt>
          <dd className="font-mono text-sm text-ink">{k.sole_items}</dd>
        </div>
        <div>
          <dt className="text-ink-muted">Projects</dt>
          <dd className="font-mono text-sm text-ink">{k.projects_touched}</dd>
        </div>
        <div>
          <dt className="text-ink-muted">Back up for</dt>
          <dd className="font-mono text-sm text-ink">{k.backup_items}</dd>
        </div>
      </dl>
    </Card>
  );
}

export default async function HandoverPage() {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");

  // RLS limits every table to the signed-in user's workspace.
  const report = await gatherHandover(db as unknown as HandoverDb, null, null);
  const withGaps = report.projects.filter((p) => p.without_backup + p.unowned > 0);
  const covered = report.projects.filter((p) => p.without_backup + p.unowned === 0);
  const keyPeople = report.key_people.filter((k) => k.bus_factor_1);
  const s = report.summary;

  return (
    <PageContainer className="space-y-6">
      <div className="space-y-1">
        <PageHeader
          title="Handover"
          exports={
            <a
              href="/api/reports/handover?format=csv"
              download
              className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-border-subtle px-3 text-sm text-ink hover:bg-well sm:min-h-9"
            >
              <Download className="size-4" aria-hidden="true" />
              Export CSV
            </a>
          }
        />
        <p className="-mt-3 text-sm text-ink-muted">
          Open work with one owner and no backup.
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ["Open items", s.open_items],
          ["No backup", s.without_backup],
          ["No owner", s.unowned],
          ["Single points of failure", s.people_bus_factor_1],
        ].map(([label, value]) => (
          <Card key={label as string} className="px-4 py-3">
            <dt className="text-xs text-ink-muted">{label}</dt>
            <dd className="font-mono text-xl text-ink">{value}</dd>
          </Card>
        ))}
      </dl>

      {s.open_items === 0 ? (
        <Card className="px-5 py-6 text-sm text-ink-muted">
          No open work yet. Name a backup owner on an item and it shows here.
        </Card>
      ) : (
        <>
          <section className="space-y-3" aria-labelledby="handover-people">
            <h2 id="handover-people" className="text-xs font-medium uppercase tracking-wide text-ink-muted">
              Key people
            </h2>
            {keyPeople.length === 0 ? (
              <Card className="px-5 py-4 text-sm text-ink-muted">
                No one solely owns open work. Every owned item has a backup.
              </Card>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {keyPeople.map((k) => (
                  <PersonCard key={k.person.key} k={k} />
                ))}
              </div>
            )}
          </section>

          <section className="space-y-3" aria-labelledby="handover-projects">
            <h2 id="handover-projects" className="text-xs font-medium uppercase tracking-wide text-ink-muted">
              Projects with gaps ({withGaps.length})
            </h2>
            {withGaps.map((p) => (
              <ProjectCard key={p.project.id} p={p} />
            ))}
            {covered.length > 0 ? (
              <p className="text-xs text-ink-muted">
                {plural(covered.length, "project")} fully covered:{" "}
                {covered.map((p) => p.project.code ?? p.project.name).join(", ")}.
              </p>
            ) : null}
          </section>
        </>
      )}
    </PageContainer>
  );
}
