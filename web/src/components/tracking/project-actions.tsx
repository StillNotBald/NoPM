"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Lock, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useModal } from "@/components/ui/modal";
import { apiPost, type ApiError } from "@/lib/api-client";
import { ProjectForm, type Project } from "@/components/forms/project-form";

interface ProjectActionsProps {
  project: Project;
}

export function ProjectActions({ project }: ProjectActionsProps) {
  const router = useRouter();
  const modal = useModal();
  const [locking, setLocking] = useState(false);

  async function handleLockToggle() {
    setLocking(true);
    try {
      if (project.is_locked) {
        await apiPost(`/api/projects/${project.id}/unlock`);
      } else {
        await apiPost(`/api/projects/${project.id}/lock`, {
          reason: "Baseline frozen",
        });
      }
      router.refresh();
    } catch (err) {
      const apiErr = err as ApiError;
      alert(apiErr.message ?? "Failed to toggle lock");
    } finally {
      setLocking(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {/* Edit */}
      <Button
        variant="secondary"
        size="sm"
        onClick={() =>
          modal.open(
            <ProjectForm mode="edit" project={project} />,
            { title: "Edit Project", size: "lg" }
          )
        }
      >
        <Pencil size={14} className="mr-1.5" />
        Edit
      </Button>

      {/* Lock / Unlock */}
      <Button
        variant={project.is_locked ? "ghost" : "secondary"}
        size="sm"
        onClick={handleLockToggle}
        disabled={locking}
        className={project.is_locked ? "text-warning hover:text-warning/80" : ""}
      >
        {locking ? (
          <Spinner size="sm" className="mr-1.5" />
        ) : (
          <Lock size={14} className="mr-1.5" />
        )}
        {project.is_locked ? "Unlock" : "Lock"}
      </Button>
    </div>
  );
}
