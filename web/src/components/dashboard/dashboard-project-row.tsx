"use client";

import type { ReactNode } from "react";
import { useInspector } from "@/components/layout/app-shell";
import { ProjectDossier, type DossierProject } from "./project-dossier";
import { TR, TD } from "@/components/ui/data-table";
import { cn } from "@/lib/cn";

/**
 * Dashboard project row — opens the project status dossier in the right-push
 * inspector (C-level "what's happening?" journey).
 *
 * Semantics: the row keeps native `<tr>` semantics. The keyboard / screen
 * reader path is a real `<button>` in the code cell ("Open status for X");
 * mouse users may also click anywhere on the row (clicks that land on a link
 * or button, e.g. the name EntityLink, are left alone).
 */
export function DashboardProjectRow({
  project,
  openR,
  openI,
  children,
}: {
  project: DossierProject;
  openR: number;
  openI: number;
  children: ReactNode;
}) {
  const inspector = useInspector();
  const open = () =>
    inspector.open(<ProjectDossier project={project} openR={openR} openI={openI} />, `${project.code} · status`);

  return (
    <TR
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a,button")) return;
        open();
      }}
      className="cursor-pointer transition-colors duration-100 hover:bg-well"
    >
      <TD>
        <button
          type="button"
          onClick={open}
          aria-label={`Open status for ${project.code} ${project.name}`}
          className={cn(
            "focus-ring -mx-1 rounded px-1 font-mono text-xs font-medium text-ink-secondary",
            "hover:text-accent hover:underline",
          )}
        >
          {project.code}
        </button>
      </TD>
      {children}
    </TR>
  );
}
