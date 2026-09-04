"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Settings, Keyboard, LifeBuoy, LogOut, User, Rocket } from "lucide-react";
import { cn } from "@/lib/cn";
import { KeyboardShortcuts } from "./keyboard-shortcuts";
import { createClient } from "@/lib/supabase/client";

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
        "inline-flex shrink-0 items-center justify-center rounded-full bg-accent/20 font-semibold text-accent",
        size === "sm" ? "h-7 w-7 text-xs" : "h-8 w-8 text-sm",
      )}
    >
      {abbr}
    </span>
  );
}

export function AccountMenu() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

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

  // Close on click-outside and Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onPointer = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
    };
  }, [open]);

  const handleSignOut = useCallback(async () => {
    setSigningOut(true);
    try {
      // Use the browser Supabase client for sign-out — simplest correct approach
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
      <div className="relative" ref={menuRef}>
        <button
          ref={triggerRef}
          onClick={() => setOpen((v) => !v)}
          aria-label="Account menu"
          aria-haspopup="true"
          aria-expanded={open}
          className={cn(
            "grid h-10 w-10 place-items-center rounded-full",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
            open && "ring-2 ring-accent/40",
          )}
        >
          <Avatar name={displayName} size="sm" />
        </button>

        {open && (
          <div
            role="menu"
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
            <div className="border-t border-border-subtle py-1.5">
              <MenuItem
                icon={<LogOut size={14} />}
                label={signingOut ? "Signing out…" : "Sign out"}
                danger
                disabled={signingOut}
                onClick={handleSignOut}
              />
            </div>
          </div>
        )}
      </div>

      <KeyboardShortcuts open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
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
        role="menuitem"
        onClick={onClick}
        disabled={disabled}
        className={cn(
          "flex w-full items-center gap-2.5 px-4 py-2 text-sm transition-colors",
          "focus:outline-none focus-visible:bg-sunken",
          danger
            ? "text-danger hover:bg-danger/10"
            : "text-ink hover:bg-sunken",
          "disabled:opacity-50 disabled:pointer-events-none",
        )}
      >
        <span className={cn("shrink-0", danger ? "text-danger" : "text-ink-muted")}>{icon}</span>
        {label}
      </button>
    </li>
  );
}
