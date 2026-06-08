"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Bell } from "lucide-react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/cn";
import { apiGet, apiPatch, apiPost } from "@/lib/api-client";

// ── Types ──────────────────────────────────────────────────────────────────────

interface Notification {
  id: string;
  title: string;
  body: string;
  read: boolean;
  created_at: string;
  payload?: { href?: string };
}

interface NotificationsResponse {
  notifications: Notification[];
  unread_count: number;
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
  const router = useRouter();

  // ── Fetch unread count only (lightweight) ─────────────────────────────────
  const fetchCount = useCallback(async () => {
    try {
      const data = await apiGet<NotificationsResponse>("/api/notifications?limit=0");
      setUnreadCount(data.unread_count ?? 0);
    } catch {
      // silently ignore — bell is non-critical UI
    }
  }, []);

  // ── Fetch full list when popover opens ────────────────────────────────────
  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiGet<NotificationsResponse>("/api/notifications?limit=30");
      setNotifications(data.notifications ?? []);
      setUnreadCount(data.unread_count ?? 0);
    } catch {
      // silently ignore
    } finally {
      setLoading(false);
    }
  }, []);

  // On mount + window focus: refresh count
  useEffect(() => {
    fetchCount();
    const onFocus = () => fetchCount();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [fetchCount]);

  // Fetch full list when popover opens
  useEffect(() => {
    if (open) fetchAll();
  }, [open, fetchAll]);

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
        className="relative grid h-10 w-10 place-items-center rounded-md text-ink-secondary hover:bg-sunken focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <Bell size={18} />
        {unreadCount > 0 && (
          <span
            aria-hidden
            className={cn(
              "absolute right-1.5 top-1.5 flex items-center justify-center rounded-full bg-accent font-mono text-[9px] font-semibold leading-none text-accent-ink",
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
            className={cn(
              "fixed inset-x-0 bottom-0 z-50 lg:hidden",
              "rounded-t-2xl border-t border-border-subtle bg-canvas shadow-lg",
              "max-h-[75dvh] overflow-hidden",
            )}
          >
            <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-border-strong" aria-hidden />
            <PopoverContent
              notifications={notifications}
              loading={loading}
              onMarkRead={markRead}
              onMarkAllRead={markAllRead}
            />
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
            className="font-mono text-xs text-accent hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
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
          "w-full border-b border-border-subtle px-4 py-3 text-left transition-colors hover:bg-sunken focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40",
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
            <p className="mt-1 font-mono text-[10px] text-ink-muted">
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
