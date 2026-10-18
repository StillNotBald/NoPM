"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useModal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { ShowOncePanel } from "@/components/governance/show-once-panel";
import { createFeed, fetchFeeds, fetchProjects, fetchWorkspaceFeeds, revokeFeed, type OwnedFeedView } from "./api";
import { absoluteUrl, formatDate, formatRelativeTime, toWebcalUrl } from "./format";
import { useApiResource, useNow, useOrigin } from "./hooks";
import { errorText, type ProjectOption } from "./model";
import { ConfirmDialog, CopyValue, Field, InlineAlert, LoadingRow, Select } from "./shared";

const SUBSCRIBE_HINTS: { app: string; how: string }[] = [
  { app: "Apple Calendar", how: "File, New Calendar Subscription, then paste the link." },
  { app: "Outlook", how: "Add calendar, Subscribe from web, then paste the link." },
  { app: "Google Calendar", how: "Other calendars (+), From URL, then paste the link." },
  { app: "Lark", how: "Calendar, subscribe to an external calendar, then paste the link." },
];

/**
 * Shown once, straight after a feed is created: the secret URL is not retrievable afterwards.
 * Same pattern as a new API token (focus moves here, it scrolls into view, it waits for "I've saved it").
 */
function CreatedPanel({ url, onDismiss }: { url: string; onDismiss: () => void }) {
  return (
    <ShowOncePanel
      heading="Your subscription link"
      onDismiss={onDismiss}
      returnFocusTo={() => document.getElementById("feed-name")}
    >
      <CopyValue label="Subscription URL" value={url} subject="subscription URL" />
      <a
        href={toWebcalUrl(url)}
        className="focus-ring inline-flex min-h-[44px] items-center rounded-sm text-sm font-medium text-accent hover:underline sm:min-h-0"
      >
        Open in your calendar app
      </a>
      <ul className="space-y-1 text-sm text-ink-secondary">
        {SUBSCRIBE_HINTS.map((h) => (
          <li key={h.app}>
            <span className="font-medium text-ink">{h.app}:</span> {h.how}
          </li>
        ))}
      </ul>
      <p className="text-xs text-ink-muted">
        Anyone with this link can read these milestones. Revoke the feed if it leaks.
      </p>
    </ShowOncePanel>
  );
}

/**
 * "Calendar feed" card (every non-viewer). Milestones as an iCalendar
 * subscription: create a named feed (optionally for one project), copy the
 * secret URL once into any calendar app, revoke it whenever. Fetching a feed
 * is deliberately not audited per request; creating and revoking are.
 */
export function CalendarFeedsCard({ role }: { role: string | null | undefined }) {
  const toast = useToast();
  const modal = useModal();
  const origin = useOrigin();
  const now = useNow(true, 60_000);
  // A workspace admin sees every member's feeds (with the owner), so a departed
  // employee's link can be found and revoked; everyone else sees their own.
  const isAdmin = role === "admin";
  const feeds = useApiResource(isAdmin ? fetchWorkspaceFeeds : fetchFeeds);
  const projects = useApiResource(fetchProjects);

  const [name, setName] = useState("My milestones");
  const [projectId, setProjectId] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | undefined>();
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);

  // undefined = who-am-I is still loading: don't flash a create form a viewer would then lose.
  const canCreate = role !== "viewer";
  const projectOptions: ProjectOption[] = projects.state.status === "ready" ? projects.state.data : [];
  const projectName = (id: string | null) => projectOptions.find((p) => p.id === id)?.name ?? "One project";

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setNameError("Give the feed a name.");
      document.getElementById("feed-name")?.focus();
      return;
    }
    setNameError(undefined);
    setCreating(true);
    setCreateError(null);
    try {
      const created = await createFeed({ name, projectId });
      setCreatedUrl(absoluteUrl(created.url, origin || window.location.origin));
      feeds.reload();
    } catch (err) {
      setCreateError(errorText(err, "Could not create the calendar feed."));
    } finally {
      setCreating(false);
    }
  }

  function askRevoke(feed: OwnedFeedView) {
    modal.open(
      <ConfirmDialog
        heading={`Revoke “${feed.name}”?`}
        confirmLabel="Revoke feed"
        failureFallback="Could not revoke the feed."
        onConfirm={async () => {
          await revokeFeed(feed.id);
          toast.success("Calendar feed revoked.");
          feeds.reload();
        }}
      >
        <p>
          {isAdmin && feed.ownerName ? `This feed belongs to ${feed.ownerName}. ` : ""}
          Calendar apps using this link stop updating right away. A revoked link can&apos;t be restored; create a new feed to subscribe again.
        </p>
      </ConfirmDialog>,
      { title: "Revoke calendar feed", size: "sm" },
    );
  }

  let list: ReactNode;
  if (feeds.state.status === "loading") {
    list = <LoadingRow label={isAdmin ? "Loading feeds…" : "Loading your feeds…"} />;
  } else if (feeds.state.status === "unavailable") {
    list = <p className="text-sm text-ink-secondary">Calendar feeds aren&apos;t available on this deployment yet.</p>;
  } else if (feeds.state.status === "forbidden") {
    list = <p className="text-sm text-ink-secondary">Your role can&apos;t use calendar feeds.</p>;
  } else if (feeds.state.status === "error") {
    list = (
      <div className="space-y-3">
        <InlineAlert>Could not load {isAdmin ? "the feeds" : "your feeds"}: {feeds.state.message}</InlineAlert>
        <Button variant="secondary" size="sm" className="h-11 w-full sm:h-8 sm:w-auto" onClick={feeds.retry}>
          Try again
        </Button>
      </div>
    );
  } else if (feeds.state.data.length === 0) {
    list = <p className="text-sm text-ink-muted">No feeds yet. Create one above to subscribe from a calendar app.</p>;
  } else {
    list = (
      <ul className="divide-y divide-border-subtle rounded-md border border-border-subtle" aria-label={isAdmin ? "Workspace calendar feeds" : "Your calendar feeds"}>
        {feeds.state.data.map((feed) => (
          <li key={feed.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-ink" title={feed.name}>
                {feed.name}
              </p>
              <p className="text-xs text-ink-muted">
                {isAdmin && <>{feed.ownerName ?? "Unknown owner"} · </>}
                {feed.projectId ? projectName(feed.projectId) : "All projects"} · created {formatDate(feed.createdAt)} ·{" "}
                {feed.lastFetchedAt ? `last fetched ${formatRelativeTime(feed.lastFetchedAt, now)}` : "not fetched yet"}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-11 w-full text-danger-ink hover:bg-danger/10 sm:h-8 sm:w-auto"
              onClick={() => askRevoke(feed)}
              aria-label={`Revoke ${feed.name}`}
            >
              Revoke
            </Button>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <Card id="calendar">
      <CardHeader>
        <div>
          <CardTitle>Calendar feed</CardTitle>
          <p className="mt-0.5 text-xs text-ink-muted">Subscribe to milestones from any calendar app.</p>
        </div>
      </CardHeader>
      <CardBody className="space-y-5">
        {createdUrl && <CreatedPanel url={createdUrl} onDismiss={() => setCreatedUrl(null)} />}

        {role === undefined ? (
          <LoadingRow label="Checking what you can do here…" />
        ) : canCreate ? (
          <form onSubmit={handleCreate} noValidate className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field id="feed-name" label="Feed name" error={nameError}>
                {(a11y) => (
                  <Input
                    {...a11y}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={creating}
                    maxLength={80}
                    autoComplete="off"
                  />
                )}
              </Field>
              <Field id="feed-project" label="Project" optional>
                {(a11y) => (
                  <Select
                    {...a11y}
                    value={projectId}
                    onChange={(e) => setProjectId(e.target.value)}
                    disabled={creating}
                  >
                    <option value="">All projects</option>
                    {projectOptions.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            {createError && <InlineAlert>{createError}</InlineAlert>}
            <Button type="submit" variant="primary" size="md" className="h-11 w-full sm:h-10 sm:w-auto" disabled={creating}>
              {creating ? (
                <>
                  <Spinner size="sm" className="mr-2" /> Creating…
                </>
              ) : (
                "Create feed"
              )}
            </Button>
          </form>
        ) : (
          <InlineAlert tone="neutral">Viewers can&apos;t create calendar feeds. Ask a member or admin to create one.</InlineAlert>
        )}

        <div className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-muted">{isAdmin ? "Workspace feeds" : "Your feeds"}</h4>
          {list}
        </div>
      </CardBody>
    </Card>
  );
}
