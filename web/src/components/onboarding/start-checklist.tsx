"use client";

import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { useSeededPreferences } from "@/components/onboarding/use-seeded-preferences";
import type { PrefsSeed } from "@/lib/onboarding/seed";
import {
  startSteps,
  progress,
  allDone,
  markStartVisited,
  setStartDismissed,
  type StartChecklistInput,
} from "@/lib/onboarding/start-checklist";

type Props = Omit<StartChecklistInput, "visited"> & {
  /** The viewer's checklist state as the server read it (see lib/onboarding/seed.ts). */
  seed?: PrefsSeed | null;
};

/**
 * Client half of /start — renders the 5-step checklist derived by
 * lib/onboarding/start-checklist.ts. `visited`/`dismissed` come from the
 * shared preferences store (same GET/PUT /api/me/preferences pair every
 * other onboarding surface uses, via the `start` config key); every other
 * input is server-fetched workspace data passed down as props.
 */
export function StartChecklist({ seed, ...props }: Props) {
  const { ready, config, update } = useSeededPreferences(seed);

  if (!ready) return null;

  const start = config.start ?? {};
  const steps = startSteps({ ...props, visited: start.visited ?? [] });
  const { done, total, pct } = progress(steps);
  const finished = allDone(steps);

  function handleVisit(stepId: string) {
    update({ start: markStartVisited(start, stepId) });
  }

  function toggleDismissed(next: boolean) {
    update({ start: setStartDismissed(start, next) });
  }

  if (start.dismissed) {
    return (
      <button
        type="button"
        onClick={() => toggleDismissed(false)}
        className="focus-ring min-h-11 w-full rounded-lg border border-border-subtle bg-surface px-5 py-3 text-left text-sm text-ink-secondary hover:bg-well"
      >
        Checklist hidden · <span className="font-medium text-accent">Show</span>
      </button>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="min-w-0">
          <CardTitle>Get set up</CardTitle>
          <span className="mt-0.5 block text-xs text-ink-muted">
            {done} of {total} done
          </span>
        </div>
        <div className="flex items-center gap-3">
          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-well">
            <div
              className="h-full rounded-full bg-accent transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
          <button
            type="button"
            onClick={() => toggleDismissed(true)}
            className="focus-ring shrink-0 -my-3.5 rounded py-3.5 text-xs text-ink-muted hover:text-ink hover:underline"
          >
            Hide this page&apos;s checklist
          </button>
        </div>
      </CardHeader>
      <CardBody className="p-0">
        <ul className="divide-y divide-border-subtle">
          {steps.map((step) => (
            <li key={step.id} className="flex items-start gap-3 px-5 py-3.5">
              <span
                className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center"
                aria-hidden="true"
              >
                {step.done ? (
                  <CheckCircle2 size={16} className="text-success-ink" />
                ) : (
                  <span className="h-2 w-2 rounded-full border border-border-strong" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink">
                  {step.title}
                  {/* the tick is aria-hidden; say it in text too */}
                  {step.done && <span className="sr-only"> (done)</span>}
                </p>
                <p className="mt-0.5 text-xs text-ink-muted">
                  {step.canAct ? step.caption : `${step.caption} Ask your workspace admin.`}
                </p>
              </div>
              {/* one link styled as a secondary button (a <Button> inside a <Link>
                  is nested interactive content) */}
              {step.canAct && !step.done && (
                <Link
                  href={step.href}
                  onClick={() => {
                    if (step.kind === "read") handleVisit(step.id);
                  }}
                  className="focus-ring inline-flex h-11 shrink-0 items-center justify-center rounded-md border border-border-subtle bg-surface px-3 text-sm font-medium text-ink transition-colors duration-150 hover:bg-well sm:h-8"
                >
                  {step.cta}
                </Link>
              )}
            </li>
          ))}
        </ul>
        {finished && (
          <p className="border-t border-border-subtle px-5 py-3 text-center text-xs text-ink-muted">
            You&apos;re set up — explore from the sidebar.
          </p>
        )}
      </CardBody>
    </Card>
  );
}
