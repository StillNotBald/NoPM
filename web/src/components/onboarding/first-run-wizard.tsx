"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { apiPost, type ApiError } from "@/lib/api-client";
import { FieldError } from "@/components/forms/project-form";
import { usePreferences } from "@/lib/prefs/use-preferences";
import {
  clampStep,
  shouldShowWizard,
  dismissedState,
  advancedState,
  completedState,
} from "@/lib/onboarding/steps";

/**
 * First-run wizard (L-45, D7). Mounted ONLY by dashboard/page.tsx, inside its
 * `projects.length === 0` branch, and only when the server has already
 * confirmed the caller `canWrite` (viewers never get this component at all —
 * they keep seeing the plain empty state, per recon-identity.md §5 the
 * verify-as-funnel-identity lesson).
 *
 * Every step calls an EXISTING public API (POST /api/projects, POST
 * /api/projects/{id}/tasks) — this component adds no new server code beyond
 * the `onboarding` preferences key. Progress persists via
 * PUT /api/me/preferences ONLY when GET said `demo: false`; a demo actor
 * keeps the wizard in local component state only and it simply re-shows on
 * their next visit (acceptable per D7 — the shared-demo-identity carve-out).
 *
 * Deliberately does NOT call router.refresh() until the final "Done" step —
 * refreshing earlier would re-run the dashboard server component, see
 * projects.length > 0 after step 2 creates a project, and unmount this
 * component mid-flow (the parent's mount condition is evaluated once, at
 * first render, not continuously).
 */

type CreatedProject = { id: string; code: string; name: string };

export function FirstRunWizard() {
  const router = useRouter();
  const toast = useToast();
  const prefs = usePreferences();

  // Derived straight from the shared prefs store (R-78) rather than local
  // state — `prefs.update()` merges optimistically and re-renders every
  // subscriber synchronously, so `visible`/`step` stay correct across
  // dismiss/advance/complete without a parallel copy to keep in sync. The
  // store's own fail-soft (a failed GET yields an empty config, `ready`
  // still flips true) reproduces the exact same "show the wizard from the
  // top" fallback the old catch block wrote by hand — `shouldShowWizard`/
  // `clampStep` already treat `undefined` that way.
  const loaded = prefs.ready;
  const onboarding = prefs.config.onboarding;
  const visible = shouldShowWizard(onboarding);
  const step = clampStep(onboarding?.step);

  const [projectCode, setProjectCode] = useState("");
  const [projectName, setProjectName] = useState("");
  const [project, setProject] = useState<CreatedProject | null>(null);
  const [taskName, setTaskName] = useState("");

  const [saving, setSaving] = useState(false);
  const [topError, setTopError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // D7 — demo identity never persists preferences; the store already
  // no-ops the PUT for it (local-only, fresh per visit) so this is just a
  // merge into the shared config.
  function persist(next: typeof onboarding) {
    void prefs.update({ onboarding: next });
  }

  function dismiss() {
    persist(dismissedState(onboarding));
  }

  function clearErrors() {
    setTopError(null);
    setFieldErrors({});
  }

  function applyError(err: unknown) {
    const apiErr = err as ApiError;
    setTopError(apiErr.message ?? "Something went wrong");
    const map: Record<string, string> = {};
    for (const f of apiErr.fields ?? []) map[f.field] = f.message;
    setFieldErrors(map);
  }

  async function handleCreateProject(e: FormEvent) {
    e.preventDefault();
    clearErrors();
    if (!projectCode.trim() || !projectName.trim()) return;
    setSaving(true);
    try {
      const created = await apiPost<CreatedProject>("/api/projects", {
        code: projectCode.trim(),
        name: projectName.trim(),
      });
      setProject(created);
      persist(advancedState(onboarding, 3));
      toast.success("Project created");
    } catch (err) {
      applyError(err);
    } finally {
      setSaving(false);
    }
  }

  async function handleCreateTask(e: FormEvent) {
    e.preventDefault();
    clearErrors();
    if (!project || !taskName.trim()) return;
    setSaving(true);
    try {
      await apiPost(`/api/projects/${project.id}/tasks`, { name: taskName.trim() });
      persist(completedState(onboarding));
      toast.success("Task created");
    } catch (err) {
      applyError(err);
    } finally {
      setSaving(false);
    }
  }

  function skipTaskStep() {
    // Abandoning here is valid — a project without a task is a valid state
    // (register acceptance criterion). Still marks the wizard done so it
    // doesn't reappear once a project already exists.
    persist(completedState(onboarding));
  }

  function finish() {
    router.refresh();
  }

  // T3 (F2c-mini) — connect-agent pointer restored: once the wizard has
  // resolved its persisted state and determined it should NOT render (the
  // visitor dismissed it, or already completed it on a prior visit), fall
  // back to the old L-49 one-line pointer link rather than rendering
  // nothing at all. Viewers never reach this component in the first place
  // (dashboard/page.tsx only mounts it when canWrite is true, server-side)
  // — their equivalent fallback lives in dashboard/page.tsx itself, right
  // next to the canWrite gate.
  if (loaded && !visible) {
    return (
      <p className="mt-4 text-center text-xs text-ink-muted">
        Or{" "}
        <a href="/tokens#connect-agent" className="text-accent hover:underline">
          connect an AI agent →
        </a>
      </p>
    );
  }

  if (!loaded || !visible) return null;

  return (
    <div className="mx-auto mt-4 max-w-md rounded-lg border border-border-subtle bg-canvas text-left">
      <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
        <span className="text-xs font-medium uppercase tracking-widest text-ink-muted">
          Get started · step {step} of 4
        </span>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss setup guide"
          className="rounded-md p-1 text-ink-muted hover:bg-sunken hover:text-ink"
        >
          <X size={14} />
        </button>
      </div>

      <div className="space-y-4 px-4 py-5">
        {topError && (
          <div className="rounded-md bg-danger/10 px-3 py-2 text-xs text-danger-ink">{topError}</div>
        )}

        {step === 1 && (
          <>
            <p className="text-sm text-ink">
              NoPM tracks projects, tasks, risks, and budgets in one governed
              workspace — every change is audited automatically.
            </p>
            <p className="text-sm text-ink-muted">
              Let&apos;s create your first project and task so you can see it in
              action.
            </p>
            <Button
              type="button"
              variant="primary"
              className="h-11 w-full sm:h-10"
              onClick={() => persist(advancedState(onboarding, 2))}
            >
              Get started
            </Button>
          </>
        )}

        {step === 2 && (
          <form onSubmit={handleCreateProject} className="space-y-3">
            <p className="text-sm text-ink-muted">Create your first project.</p>
            <div>
              <Input
                value={projectCode}
                onChange={(e) => setProjectCode(e.target.value)}
                placeholder="Code (e.g. PRJ-001)"
                maxLength={32}
                required
              />
              <FieldError message={fieldErrors.code} />
            </div>
            <div>
              <Input
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder="Project name"
                maxLength={255}
                required
              />
              <FieldError message={fieldErrors.name} />
            </div>
            <Button
              type="submit"
              variant="primary"
              className="h-11 w-full sm:h-10"
              disabled={saving || !projectCode.trim() || !projectName.trim()}
            >
              {saving ? (
                <>
                  <Spinner size="sm" className="mr-2" />
                  Creating…
                </>
              ) : (
                "Create project"
              )}
            </Button>
          </form>
        )}

        {step === 3 && project && (
          <form onSubmit={handleCreateTask} className="space-y-3">
            <p className="text-sm text-ink-muted">
              <span className="font-medium text-ink">{project.code}</span> created.
              Now add its first task.
            </p>
            <div>
              <Input
                value={taskName}
                onChange={(e) => setTaskName(e.target.value)}
                placeholder="Task name"
                maxLength={255}
                required
              />
              <FieldError message={fieldErrors.name} />
            </div>
            <Button
              type="submit"
              variant="primary"
              className="h-11 w-full sm:h-10"
              disabled={saving || !taskName.trim()}
            >
              {saving ? (
                <>
                  <Spinner size="sm" className="mr-2" />
                  Creating…
                </>
              ) : (
                "Create task"
              )}
            </Button>
            <button
              type="button"
              onClick={skipTaskStep}
              className="w-full text-center text-xs text-ink-muted hover:underline"
            >
              Skip for now
            </button>
          </form>
        )}

        {step === 4 && (
          <>
            <p className="text-sm text-ink">You&apos;re set up.</p>
            <p className="text-sm text-ink-muted">
              Explore your tasks, or connect an AI agent so it can drive NoPM
              for you via its own governed API token.
            </p>
            <div className="flex flex-col gap-2">
              <a href="/tasks" onClick={finish}>
                <Button type="button" variant="primary" className="h-11 w-full sm:h-10">
                  Go to Tasks
                </Button>
              </a>
              <a
                href="/tokens#connect-agent"
                onClick={finish}
                className="text-center text-xs text-accent hover:underline"
              >
                Or connect an AI agent to drive NoPM for you →
              </a>
              <a
                href="/start"
                onClick={finish}
                className="text-center text-xs text-accent hover:underline"
              >
                See your next steps →
              </a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
