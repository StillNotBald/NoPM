"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Bell, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/cn";
import { useBodyScrollLock, useInertShell, useReturnFocus } from "@/lib/hooks/use-sheet";
import { apiGet, apiPatch, apiPost } from "@/lib/api-client";
// @supabase/ssr + supabase-js are loaded lazily inside the realtime effect
// below (not at module scope) so they leave the shared shell's initial chunk —
// this component mounts on every page via app-shell.tsx, but only the bell's
// own Realtime subscription needs the Supabase client.
import type { createClient } from "@/lib/supabase/client";

type SupabaseBrowserClient = ReturnType<typeof createClient>;

// ── Types ──────────────────────────────────────────────────────────────────────

/** Shape as stored in Postgres (read_at = null means unread). */
interface DbNotification {
  id: string;
  title: string;
  body: string | null;
  read_at: string | null;
  created_at: string;
  payload?: { href?: string } | null;
  recipient_id: string;
  workspace_id: string;
  type: string;
}

/** Derived view used by the UI. */
interface Notification {
  id: string;
  title: string;
  body: string;
  read: boolean;
  created_at: string;
  payload?: { href?: string };
}

/** Shape of the list API response (after apiGet unwraps { data }). */
interface NotificationsListResponse {
  data: DbNotification[];
  total: number;
  page: number;
  limit: number;
}

function dbToUi(n: DbNotification): Notification {
  return {
    id: n.id,
    title: n.title,
    body: n.body ?? "",
    read: n.read_at !== null,
    created_at: n.created_at,
    payload: n.payload ?? undefined,
  };
}

// ── Relative time helper ───────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const delta = (Date.now() - new Date(iso).getTime()) / 1000;
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

// ── Bell button ────────────────────────────────────────────────────────────────

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const mobileCloseBtnRef = useRef<HTMLButtonElement>(null);
  const router = useRouter();

  // F1/F2 — the mobile sheet used to have no lock/inert and no close button
  // (backdrop-tap only). Scoped to below lg by the hooks themselves; the
  // desktop popover (no backdrop) is unaffected.
  useBodyScrollLock(open);
  useInertShell(open);
  useReturnFocus(open, mobileCloseBtnRef, buttonRef);

  // ── Fetch unread count only (lightweight) ─────────────────────────────────
  const fetchCount = useCallback(async () => {
    try {
      // unread=1 returns only unread rows; we use total as the unread count
      const data = await apiGet<NotificationsListResponse>("/api/notifications?unread=1&limit=1");
      setUnreadCount(data.total ?? 0);
    } catch {
      // silently ignore — bell is non-critical UI
    }
  }, []);

  // ── Fetch full list when popover opens ────────────────────────────────────
  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiGet<NotificationsListResponse>("/api/notifications?limit=30");
      const items = (data.data ?? []).map(dbToUi);
      setNotifications(items);
      setUnreadCount(items.filter((n) => !n.read).length);
    } catch {
      // silently ignore
    } finally {
      setLoading(false);
    }
  }, []);

  // On mount + window focus: refresh count
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchCount();
    const onFocus = () => fetchCount();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [fetchCount]);

  // Fetch full list when popover opens
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) fetchAll();
  }, [open, fetchAll]);

  // ── Supabase Realtime subscription ────────────────────────────────────────
  useEffect(() => {
    let supabase: SupabaseBrowserClient | null = null;
    let channelRef: ReturnType<SupabaseBrowserClient["channel"]> | null = null;
    // Guards the async gaps: if the effect is cleaned up (unmount or StrictMode
    // re-run) before the dynamic import or getUser resolves, we must neither
    // subscribe a zombie channel nor re-use the client's already-subscribed
    // channel instance.
    let cancelled = false;

    import("@/lib/supabase/client")
      .then(({ createClient }) => {
        if (cancelled) return; // effect torn down before the module loaded
        const client = createClient();
        supabase = client;

        return client.auth.getUser().then(({ data: { user } }) => {
          if (!user || cancelled) return; // unauthenticated or effect torn down

          const channel = client
            .channel("notifications-bell")
            .on(
              "postgres_changes",
              {
                event: "INSERT",
                schema: "public",
                table: "notifications",
                filter: `recipient_id=eq.${user.id}`,
              },
              (payload) => {
                const newRow = payload.new as DbNotification;
                const newItem = dbToUi(newRow);

                // Dedupe: skip if already in state (e.g. from a concurrent fetchAll)
                setNotifications((prev) => {
                  if (prev.some((n) => n.id === newItem.id)) return prev;
                  return [newItem, ...prev];
                });

                // Always bump the badge for new unread items
                if (!newItem.read) {
                  setUnreadCount((c) => c + 1);
                }
              },
            )
            .on(
              "postgres_changes",
              {
                event: "UPDATE",
                schema: "public",
                table: "notifications",
                filter: `recipient_id=eq.${user.id}`,
              },
              (payload) => {
                const updatedRow = payload.new as DbNotification;
                const wasRead = updatedRow.read_at !== null;

                setNotifications((prev) =>
                  prev.map((n) =>
                    n.id === updatedRow.id ? { ...n, read: wasRead } : n,
                  ),
                );

                // Reconcile unread badge from local state after this update
                setNotifications((prev) => {
                  const count = prev.filter((n) => !n.read).length;
                  setUnreadCount(count);
                  return prev;
                });
              },
            )
            .subscribe((status) => {
              // Fail-soft: subscription errors don't break the existing fetch path
              if (status === "CHANNEL_ERROR") {
                // existing fetch-on-focus path remains active; nothing to do
              }
            });

          channelRef = channel;
        });
      })
      .catch(() => {
        // Fail-soft: realtime is a convenience layer; fetch-on-focus still works
      });

    return () => {
      cancelled = true;
      if (channelRef && supabase) {
        // removeChannel (vs unsubscribe) also drops the topic from the client
        // registry so a remount can recreate "notifications-bell" cleanly
        supabase.removeChannel(channelRef);
      }
    };
  }, []); // mount/unmount only

  // Close on click outside (desktop popover)
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open]);

  // ── Actions ──────────────────────────────────────────────────────────────

  async function markRead(n: Notification) {
    if (!n.read) {
      try {
        await apiPatch(`/api/notifications/${n.id}`, { read: true });
        setNotifications((prev) =>
          prev.map((x) => (x.id === n.id ? { ...x, read: true } : x)),
        );
        setUnreadCount((c) => Math.max(0, c - 1));
      } catch {
        // best-effort
      }
    }
    if (n.payload?.href) {
      setOpen(false);
      router.push(n.payload.href);
    }
  }

  async function markAllRead() {
    try {
      await apiPost("/api/notifications/read-all");
      setNotifications((prev) => prev.map((x) => ({ ...x, read: true })));
      setUnreadCount(0);
    } catch {
      // best-effort
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="relative">
      {/* Bell button */}
      <button
        ref={buttonRef}
        onClick={() => setOpen((v) => !v)}
        aria-label={`Notifications${unreadCount > 0 ? `, ${unreadCount} unread` : ""}`}
        className="relative grid h-10 w-10 place-items-center rounded-md text-ink-secondary hover:bg-sunken focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <Bell size={18} />
        {unreadCount > 0 && (
          <span
            aria-hidden
            className={cn(
              "absolute right-1.5 top-1.5 flex items-center justify-center rounded-full bg-accent font-mono text-2xs font-semibold leading-none text-accent-ink",
              unreadCount < 10 ? "h-[14px] w-[14px]" : "h-[14px] min-w-[18px] px-1",
            )}
          >
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {/* ── Desktop popover ─────────────────────────────────────────────────── */}
      {open && (
        <>
          {/* Mobile backdrop / bottom-sheet */}
          <div
            className="fixed inset-0 z-40 lg:hidden"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div
            ref={popoverRef}
            role="dialog"
            aria-modal="true"
            aria-label="Notifications"
            className={cn(
              // desktop: absolute popover anchored right of button
              "absolute right-0 top-12 z-50 w-80",
              "hidden lg:block",
              "rounded-xl border border-border-subtle bg-canvas shadow-lg",
              "overflow-hidden",
            )}
          >
            <PopoverContent
              notifications={notifications}
              loading={loading}
              onMarkRead={markRead}
              onMarkAllRead={markAllRead}
            />
          </div>

          {/* Mobile: bottom sheet */}
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Notifications"
            className={cn(
              "fixed inset-x-0 bottom-0 z-50 lg:hidden",
              "rounded-t-2xl border-t border-border-subtle bg-canvas shadow-lg",
              "flex max-h-[75dvh] flex-col overflow-hidden",
            )}
          >
            <div className="relative shrink-0">
              <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-border-strong" aria-hidden />
              <button
                ref={mobileCloseBtnRef}
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close notifications"
                className="absolute right-1 top-1 grid h-11 w-11 place-items-center rounded-md text-ink-secondary hover:bg-sunken"
              >
                <X size={18} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              <PopoverContent
                notifications={notifications}
                loading={loading}
                onMarkRead={markRead}
                onMarkAllRead={markAllRead}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── Popover content (shared between desktop and mobile) ───────────────────────

function PopoverContent({
  notifications,
  loading,
  onMarkRead,
  onMarkAllRead,
}: {
  notifications: Notification[];
  loading: boolean;
  onMarkRead: (n: Notification) => void;
  onMarkAllRead: () => void;
}) {
  const hasUnread = notifications.some((n) => !n.read);

  return (
    <div className="flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
        <span className="font-mono text-xs font-semibold uppercase tracking-wider text-ink-muted">
          Notifications
        </span>
        {hasUnread && (
          <button
            onClick={onMarkAllRead}
            className="font-mono text-xs text-accent hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Mark all read
          </button>
        )}
      </div>

      {/* List */}
      <div className="max-h-[60vh] overflow-y-auto lg:max-h-[400px]">
        {loading ? (
          <div className="flex items-center justify-center py-10">
            <span className="font-mono text-xs text-ink-muted">loading...</span>
          </div>
        ) : notifications.length === 0 ? (
          <EmptyState />
        ) : (
          <ul>
            {notifications.map((n) => (
              <NotificationRow key={n.id} n={n} onClick={() => onMarkRead(n)} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ── Single notification row ────────────────────────────────────────────────────

function NotificationRow({
  n,
  onClick,
}: {
  n: Notification;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        onClick={onClick}
        className={cn(
          "w-full border-b border-border-subtle px-4 py-3 text-left transition-colors hover:bg-sunken focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
          "last:border-b-0",
        )}
      >
        <div className="flex items-start gap-2.5">
          {/* unread dot */}
          <span
            className={cn(
              "mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full",
              n.read ? "bg-transparent" : "bg-accent",
            )}
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <p
              className={cn(
                "truncate text-sm leading-snug",
                n.read ? "text-ink-secondary" : "font-medium text-ink",
              )}
            >
              {n.title}
            </p>
            {n.body && (
              <p className="mt-0.5 line-clamp-2 text-xs text-ink-muted">{n.body}</p>
            )}
            <p className="mt-1 font-mono text-2xs text-ink-muted">
              {relativeTime(n.created_at)}
            </p>
          </div>
        </div>
      </button>
    </li>
  );
}

// ── Empty state ────────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <Bell size={24} className="text-ink-muted" strokeWidth={1.5} />
      <p className="font-mono text-sm font-medium text-ink-secondary">You&apos;re all caught up</p>
      <p className="font-mono text-xs text-ink-muted">No new notifications</p>
    </div>
  );
}
