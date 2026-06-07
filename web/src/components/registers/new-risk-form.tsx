"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { cn } from "@/lib/cn";

type Project = { id: string; name: string };

interface NewRiskFormProps {
  projects: Project[];
}

export function NewRiskForm({ projects }: NewRiskFormProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
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

      setTitle("");
      setSeverity("medium");
      setLikelihood("medium");
      setDueDate("");
      setOpen(false);
      router.refresh();
    } catch {
      setError("Network error — please try again");
    } finally {
      setLoading(false);
    }
  }

  if (!open) {
    return (
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setOpen(true)}>
          + New Risk
        </Button>
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>New Risk</CardTitle>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-ink-muted hover:text-ink text-sm leading-none"
          aria-label="Close"
        >
          ✕
        </button>
      </CardHeader>
      <CardBody>
        <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {/* Project */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-ink-secondary">Project</label>
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              required
              className={cn(
                "h-10 w-full rounded-md border border-border-subtle bg-canvas px-3 text-sm text-ink",
                "focus:outline-none focus-visible:border-border-strong focus-visible:ring-2 focus-visible:ring-accent/30",
              )}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          {/* Title */}
          <div className="flex flex-col gap-1.5 sm:col-span-1">
            <label className="text-xs font-medium text-ink-secondary">Title</label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Describe the risk…"
              required
            />
          </div>

          {/* Severity */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-ink-secondary">Severity</label>
            <select
              value={severity}
              onChange={(e) => setSeverity(e.target.value as typeof severity)}
              className={cn(
                "h-10 w-full rounded-md border border-border-subtle bg-canvas px-3 text-sm text-ink",
                "focus:outline-none focus-visible:border-border-strong focus-visible:ring-2 focus-visible:ring-accent/30",
              )}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          </div>

          {/* Likelihood */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-ink-secondary">Likelihood</label>
            <select
              value={likelihood}
              onChange={(e) => setLikelihood(e.target.value as typeof likelihood)}
              className={cn(
                "h-10 w-full rounded-md border border-border-subtle bg-canvas px-3 text-sm text-ink",
                "focus:outline-none focus-visible:border-border-strong focus-visible:ring-2 focus-visible:ring-accent/30",
              )}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          </div>

          {/* Due date */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-ink-secondary">Due date (optional)</label>
            <Input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </div>

          {/* Actions */}
          <div className="flex items-end gap-2 sm:col-span-2">
            {error && <p className="flex-1 text-xs text-danger">{error}</p>}
            <div className="ml-auto flex gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setOpen(false)}
                disabled={loading}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={loading || !title.trim()}>
                {loading ? "Saving…" : "Add Risk"}
              </Button>
            </div>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
