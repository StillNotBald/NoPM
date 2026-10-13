import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface EmptyStateProps {
  /** One-line explanation of what this register/list is for. */
  purpose: string;
  /**
   * Primary write action (e.g. the page's existing "New Risk" trigger).
   * Only rendered when `canWrite` is true — pass the same component the
   * page already uses in its header/toolbar; mounting it a second time here
   * is the same pattern already used by the resources page's empty state
   * (`ResourceActions variant="empty-state"`).
   */
  action?: ReactNode;
  /**
   * Whether the caller may perform `action` here. Compute this from the
   * *actual* server-side write gate for this resource — usually
   * `role !== "viewer"`, but some resources (e.g. API tokens) are stricter
   * (admin/manager only). Never hardcode a role name inside this component;
   * the caller knows its own rule. Defaults to true so existing call sites
   * that don't pass it keep showing the action.
   *
   * Lesson: the shared demo login is a VIEWER — a write CTA a viewer can't
   * use just produces a confusing 403 (verify-as-funnel-identity).
   */
  canWrite?: boolean;
  /** Optional read-only pointer (e.g. the Trust Center). Always shown. */
  docsHref?: string;
  docsLabel?: string;
  icon?: ReactNode;
  className?: string;
}

/** Shared empty-state block for registers/lists — role-aware action slot. */
export function EmptyState({
  purpose,
  action,
  canWrite = true,
  docsHref,
  docsLabel = "Read the docs",
  icon,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 px-5 py-16 text-center",
        className,
      )}
    >
      {icon}
      <p className="max-w-sm text-sm text-ink-muted">{purpose}</p>
      {canWrite && action}
      {docsHref && (
        <a href={docsHref} className="text-xs text-accent hover:underline">
          {docsLabel}
        </a>
      )}
    </div>
  );
}
