"use client";

import type { ReactNode } from "react";
import { useInspector } from "@/components/layout/app-shell";
import { ProjectDossier, type DossierProject } from "./project-dossier";
import { cn } from "@/lib/cn";

/**
 * Clickable dashboard row — opens the project status dossier in the right-push
 * inspector (C-level "what's happening?" journey). The project name inside is an
 * EntityLink that stops propagation, so clicking the name still deep-links to the
 * full project page; clicking anywhere else on the row opens the quick dossier.
 */
export function DashboardProjectRow({
  project,
  openR,
  openI,
  isLast,
  children,
}: {
  project: DossierProject;
  openR: number;
  openI: number;
  isLast: boolean;
  children: ReactNode;
}) {
  const inspector = useInspector();
  const open = () =>
    inspector.open(<ProjectDossier project={project} openR={openR} openI={openI} />, `${project.code} · status`);

  return (
    <tr
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      className={cn(
        "cursor-pointer transition-colors duration-100 hover:bg-sunken",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
        !isLast && "border-b border-border-subtle",
      )}
    >
      {children}
    </tr>
  );
}
