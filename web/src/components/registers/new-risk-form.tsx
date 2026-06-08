"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useModal } from "@/components/ui/modal";
import { cn } from "@/lib/cn";

type Project = { id: string; name: string };

const selectClass = cn(
  "h-11 w-full rounded-md border border-border-subtle bg-canvas px-3 text-base text-ink sm:h-10 sm:text-sm",
  "focus:outline-none focus-visible:border-border-strong focus-visible:ring-2 focus-visible:ring-accent/30",
);

/** Header action: opens the "New Risk" form in a modal. */
export function NewRiskButton({ projects }: { projects: Project[] }) {
  const modal = useModal();
  return (
    <Button
      variant="primary"
      className="h-11 sm:h-10"
      disabled={projects.length === 0}
      onClick={() => modal.open(<RiskModalForm projects={projects} />, { title: "New Risk", size: "lg" })}
    >
      <Plus size={16} className="mr-1.5" />
      New Risk
    </Button>
  );
}

function RiskModalForm({ projects }: { projects: Project[] }) {
  const router = useRouter();
  const modal = useModal();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [severity, setSeverity] = useState<"low" | "medium" | "high" | "critical">("medium");
  const [likelihood, setLikelihood] = useState<"low" | "medium" | "high" | "critical">("medium");
  const [dueDate, setDueDate] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId || !title.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/risks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          severity,
          likelihood,
          due_date: dueDate ? new Date(dueDate).toISOString() : null,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Failed to create risk");
        return;
      }
      router.refresh();
      modal.close();
    } catch {
      setError("Network error — please try again");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div className="flex flex-col gap-1.5 sm:col-span-2">
        <label className="text-xs font-medium text-ink-secondary">Title</label>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Describe the risk…" autoFocus required />
      </div>

      <div className="flex flex-col gap-1.5 sm:col-span-2">
        <label className="text-xs font-medium text-ink-secondary">Project</label>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} required className={selectClass}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-ink-secondary">Severity</label>
        <select value={severity} onChange={(e) => setSeverity(e.target.value as typeof severity)} className={selectClass}>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="critical">Critical</option>
        </select>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-ink-secondary">Likelihood</label>
        <select value={likelihood} onChange={(e) => setLikelihood(e.target.value as typeof likelihood)} className={selectClass}>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="critical">Critical</option>
        </select>
      </div>

      <div className="flex flex-col gap-1.5 sm:col-span-2">
        <label className="text-xs font-medium text-ink-secondary">Due date (optional)</label>
        <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
      </div>

      {error && <p className="text-xs text-danger sm:col-span-2">{error}</p>}

      <div className="flex flex-col-reverse gap-2 pt-1 sm:col-span-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="ghost" onClick={modal.close} disabled={loading} className="h-11 sm:h-10">
          Cancel
        </Button>
        <Button type="submit" disabled={loading || !title.trim()} className="h-11 sm:h-10">
          {loading ? "Saving…" : "Add Risk"}
        </Button>
      </div>
    </form>
  );
}
