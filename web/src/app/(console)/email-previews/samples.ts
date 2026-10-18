import type { NotificationEmailInput } from "@/lib/notify/email";

/**
 * One sample per notification type the template knows, shown when the
 * workspace has no notifications yet — otherwise a page named "Email previews"
 * previews nothing on a fresh or seeded-empty workspace. They are generic by
 * construction (no names, no real records) and the page labels every one
 * "Sample" so none is mistaken for a delivered email.
 */
export const SAMPLE_NOTIFICATIONS: ReadonlyArray<NotificationEmailInput> = [
  {
    type: "approval.requested",
    title: "A deletion request is waiting for your approval",
    body: "A teammate asked to delete a task. A different person has to approve it before anything is removed.",
    payload: { href: "/approvals" },
  },
  {
    type: "approval.approved",
    title: "Your deletion request was approved",
    body: "The checker approved the request. The change is committed and one audit row was written.",
    payload: { href: "/trust" },
  },
  {
    type: "approval.rejected",
    title: "Your deletion request was rejected",
    body: "The checker rejected the request. Nothing was deleted.",
    payload: { href: "/approvals" },
  },
  {
    type: "risk.escalated",
    title: "A risk was escalated",
    body: "A risk was escalated and needs a review.",
    payload: { href: "/risks" },
  },
  {
    type: "clash.detected",
    title: "A clash was detected",
    body: "A schedule, resource or dependency clash was found and needs a decision.",
    payload: { href: "/clashes" },
  },
  {
    type: "item.stale",
    title: "Stale task: a task has had no update for 14 days",
    body: "No update for 14 days. Update it, or close it if it is done.",
    payload: { href: "/my-tasks" },
  },
  {
    type: "report.weekly",
    title: "Weekly status report: week of the current Monday",
    body: "A summary of projects, open high risks, pending approvals and stale items.",
    payload: { href: "/dashboard" },
  },
];
