"use client";

import { useEffect, useId, useRef, useState, useCallback, type FocusEvent, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { Settings, Keyboard, LifeBuoy, LogOut, User, Rocket } from "lucide-react";
import { cn } from "@/lib/cn";
import { IconButton } from "@/components/ui/icon-button";
import { useEscapeClose } from "@/lib/hooks/use-sheet";
import { KeyboardShortcuts } from "./keyboard-shortcuts";
// @supabase/ssr + supabase-js load lazily inside the sign-out handler below —
// this menu mounts on every page via app-shell.tsx, and only sign-out needs
// the Supabase client.

interface Identity {
  label: string;
  role: string | null;
  workspaceId: string;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

function Avatar({ name, size = "md" }: { name: string; size?: "sm" | "md" }) {
  const abbr = initials(name) || "?";
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full bg-accent/20 font-semibold text-ink",
        size === "sm" ? "h-7 w-7 text-xs" : "h-8 w-8 text-sm",
      )}
    >
      {abbr}
    </span>
  );
}

/** The enabled menu items, in DOM order. */
function menuItems(root: HTMLElement | null): HTMLElement[] {
  return Array.from(root?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []);
}

export function AccountMenu() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  // Fetch identity from /api/me
  useEffect(() => {
    fetch("/api/me")
      .then((r) => r.json())
      .then((json) => {
        if (json.data) {
          setIdentity({
            label: json.data.label ?? "User",
            role: json.data.role ?? null,
            workspaceId: json.data.workspaceId ?? "",
          });
        }
      })
      .catch(() => {
        // Non-fatal — avatar still renders with fallback
      });
  }, []);

  // Escape (top-most overlay only) closes and hands focus back to the avatar.
  useEscapeClose(open, () => {
    setOpen(false);
    triggerRef.current?.focus();
  });

  // Close on a pointer press outside the menu.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [open]);

  // APG menu: focus lands on the first item when the menu opens.
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => menuItems(listRef.current)[0]?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  // Arrow keys / Home / End move between items; Tab leaving the menu closes it.
  function onMenuKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const list = menuItems(listRef.current);
    if (list.length === 0) return;
    const i = list.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (e.key === "ArrowDown") next = (i + 1) % list.length;
    else if (e.key === "ArrowUp") next = (i - 1 + list.length) % list.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    if (next < 0) return;
    e.preventDefault();
    list[next].focus();
  }

  // Focus moving out of the whole widget (Tab / Shift+Tab past the menu) closes it.
  // A blur with no new target is NOT that: Safari / Firefox on macOS do not focus a
  // button on mouse-down, so pressing "Sign out" blurs the open item to null and
  // closing here would unmount the menu before the click lands. Outside presses
  // are the mousedown listener's job.
  function onBlur(e: FocusEvent<HTMLDivElement>) {
    const next = e.relatedTarget as Node | null;
    if (open && next && !menuRef.current?.contains(next)) setOpen(false);
  }

  const handleSignOut = useCallback(async () => {
    setSigningOut(true);
    try {
      // Use the browser Supabase client for sign-out — simplest correct approach.
      // Loaded on demand so @supabase/ssr + supabase-js aren't in the shell's
      // initial chunk.
      const { createClient } = await import("@/lib/supabase/client");
      const supabase = createClient();
      await supabase.auth.signOut();
      router.push("/login");
    } catch {
      setSigningOut(false);
    }
  }, [router]);

  const displayName = identity?.label ?? "User";
  const role = identity?.role ?? "";

  return (
    <>
      <div className="relative" ref={menuRef} onBlur={onBlur}>
        <IconButton
          ref={triggerRef}
          onClick={() => setOpen((v) => !v)}
          label="Account menu"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          className={cn("rounded-full", open && "ring-2 ring-accent")}
        >
          <Avatar name={displayName} size="sm" />
        </IconButton>

        {open && (
          <div
            id={menuId}
            ref={listRef}
            role="menu"
            aria-label="Account"
            onKeyDown={onMenuKeyDown}
            className={cn(
              "absolute right-0 top-[calc(100%+6px)] z-40 w-60 rounded-xl border border-border-subtle",
              "bg-canvas shadow-lg shadow-black/10",
            )}
          >
            {/* identity header */}
            <div className="flex items-center gap-3 border-b border-border-subtle px-4 py-3">
              <Avatar name={displayName} size="md" />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-ink">{displayName}</p>
                {role && (
                  <p className="truncate text-xs capitalize text-ink-muted">{role}</p>
                )}
              </div>
            </div>

            {/* menu items */}
            <ul className="py-1.5" role="group">
              <MenuItem
                icon={<User size={14} />}
                label="Profile"
                onClick={() => {
                  setOpen(false);
                  router.push("/settings");
                }}
              />
              <MenuItem
                icon={<Settings size={14} />}
                label="Settings"
                onClick={() => {
                  setOpen(false);
                  router.push("/settings");
                }}
              />
              <MenuItem
                icon={<Keyboard size={14} />}
                label="Keyboard shortcuts"
                onClick={() => {
                  setOpen(false);
                  setShortcutsOpen(true);
                }}
              />
              <MenuItem
                icon={<Rocket size={14} />}
                label="Getting started"
                onClick={() => {
                  setOpen(false);
                  router.push("/start");
                }}
              />
              <MenuItem
                icon={<LifeBuoy size={14} />}
                label="Support / Docs"
                onClick={() => {
                  setOpen(false);
                  router.push("/case-study");
                }}
              />
            </ul>

            {/* sign out — separated */}
            <ul className="border-t border-border-subtle py-1.5" role="group">
              <MenuItem
                icon={<LogOut size={14} />}
                label={signingOut ? "Signing out…" : "Sign out"}
                danger
                disabled={signingOut}
                onClick={handleSignOut}
              />
            </ul>
          </div>
        )}
      </div>

      <KeyboardShortcuts open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} returnFocusRef={triggerRef} />
    </>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  danger,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <li role="none">
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        onClick={onClick}
        disabled={disabled}
        className={cn(
          "focus-ring-inset flex min-h-11 w-full items-center gap-2.5 px-4 py-2 text-sm transition-colors sm:min-h-0",
          danger
            ? "text-danger-ink hover:bg-danger/10"
            : "text-ink hover:bg-well",
          "disabled:opacity-50 disabled:pointer-events-none",
        )}
      >
        <span className={cn("shrink-0", danger ? "text-danger-ink" : "text-ink-muted")}>{icon}</span>
        {label}
      </button>
    </li>
  );
}
