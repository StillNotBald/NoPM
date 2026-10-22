"use client";

import { useEffect, useId, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { PageHeader } from "@/components/ui/page-header";
import { PageContainer } from "@/components/ui/page-container";
import { useModal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { ShowOncePanel } from "@/components/governance/show-once-panel";
import { ConfirmDialog, CopyButton, Field, InlineAlert } from "@/components/integrations/shared";
import { apiGet, apiPatch, apiPost } from "@/lib/api-client";
import { createClient } from "@/lib/supabase/client";
import { useRequireSession } from "@/lib/auth/use-require-session";
import {
  APPEARANCE_MODES,
  FONT_SCALES,
  DENSITIES,
  DATE_DISPLAYS,
  DEFAULT_APPEARANCE,
  readAppearanceCookie,
  buildAppearanceCookieHeader,
  resolveHtmlAttrs,
  mergeAppearanceWithDb,
  type AppearancePrefs,
  type AppearanceMode,
  type FontScale,
  type Density,
  type DateDisplay,
} from "@/lib/theme/appearance";
import { cn } from "@/lib/cn";
import { InvitesCard } from "@/components/invite/invites-card";
import { ApprovalPolicyCard } from "@/components/integrations/approval-policy-card";
import { usePreferences } from "@/lib/prefs/use-preferences";
import {
  type NavMode,
  readNavModeCookie,
  buildNavModeCookieHeader,
  resolveInitialNavMode,
} from "@/lib/nav/nav-mode";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "—";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

// ── Types ──────────────────────────────────────────────────────────────────────

type MfaStep =
  | "idle"         // just loaded, not enrolled
  | "enrolling"    // waiting for POST /enroll response
  | "verify"       // showing QR/secret, waiting for 6-digit code
  | "verifying"    // waiting for POST /verify response
  | "backup"       // showing one-time backup codes
  | "enabled";     // MFA already active

interface EnrollPayload {
  secret: string;
  otpauth: string;
}

interface Identity {
  label: string;
  role: string | null;
  workspaceId: string;
}

// ── Profile section ────────────────────────────────────────────────────────────

function ProfileSection() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [displayName, setDisplayName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const nameId = useId();

  useEffect(() => {
    Promise.all([
      apiGet<{ label?: string; role?: string | null; workspaceId?: string } | null>("/api/me").catch(() => null),
      createClient().auth.getUser().then(({ data }) => data.user?.email ?? null).catch(() => null),
    ])
      .then(([me, mail]) => {
        if (me) {
          const id: Identity = {
            label: me.label ?? "",
            role: me.role ?? null,
            workspaceId: me.workspaceId ?? "",
          };
          setIdentity(id);
          setDisplayName(id.label);
        }
        setEmail(mail);
      })
      .finally(() => setProfileLoading(false));
  }, []);

  const handleSave = async () => {
    if (!displayName.trim()) return;
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);
    try {
      const saved = await apiPatch<{ label?: string } | null>("/api/me", { display_name: displayName.trim() });
      setIdentity((prev) => (prev ? { ...prev, label: saved?.label ?? displayName.trim() } : prev));
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2500);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Could not save profile.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
      </CardHeader>
      <CardBody className="space-y-5">
        {profileLoading ? (
          <div className="flex items-center gap-3 py-2">
            <Spinner size="sm" />
            <span className="text-sm text-ink-secondary">Loading profile…</span>
          </div>
        ) : (
          <>
            {/* Avatar + identity header */}
            <div className="flex items-center gap-4">
              <div className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-accent font-mono text-lg font-semibold text-accent-ink">
                {initials(displayName || identity?.label || "")}
              </div>
              <div className="min-w-0">
                <p className="truncate text-base font-semibold text-ink">
                  {displayName || identity?.label || "—"}
                </p>
                <p className="truncate text-sm text-ink-muted">
                  {email ?? "—"}
                  {identity?.role ? <span className="capitalize"> · {identity.role}</span> : null}
                </p>
              </div>
            </div>

            {/* Display name — editable */}
            <Field id={nameId} label="Display name">
              {(a11y) => (
                <Input
                  {...a11y}
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Your name"
                  disabled={saving}
                  autoComplete="name"
                />
              )}
            </Field>

            {/* Read-only identity */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="space-y-1">
                <p className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
                  Email
                </p>
                <p className="truncate text-sm text-ink">
                  {email ?? <span className="text-ink-muted">—</span>}
                </p>
              </div>
              <div className="space-y-1">
                <p className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
                  Role
                </p>
                <p className="text-sm capitalize text-ink">
                  {identity?.role ?? <span className="text-ink-muted">—</span>}
                </p>
              </div>
              <div className="space-y-1">
                <p className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
                  Workspace
                </p>
                <p className="truncate font-mono text-xs text-ink-muted">
                  {identity?.workspaceId ?? "—"}
                </p>
              </div>
            </div>

            {saveError && <InlineAlert>{saveError}</InlineAlert>}
            {saveSuccess && <InlineAlert tone="success">Profile saved.</InlineAlert>}

            <Button
              variant="primary"
              size="md"
              className="h-11 w-full sm:h-10 sm:w-auto"
              onClick={handleSave}
              disabled={saving || !displayName.trim()}
            >
              {saving ? (
                <>
                  <Spinner size="sm" className="mr-2" /> Saving…
                </>
              ) : (
                "Save changes"
              )}
            </Button>
          </>
        )}
      </CardBody>
    </Card>
  );
}

// ── Appearance section ─────────────────────────────────────────────────────────
//
// L-37/L-38/L-42. Per-user DISPLAY preferences — the constitutional
// carve-out (owner-presented, unobjected; ADR 0009): NOT audited, no DB
// row, no `writeAudit` call. Writes ONE cookie (`nopm_appearance`) and
// applies live by stamping the same classes/style layout.tsx would stamp
// on the next request, so the choice is visible immediately without a
// full reload. Every option here comes from the closed preset registry in
// `@/lib/theme/appearance` — there is no free-form input on this card.

const MODE_LABEL: Record<AppearanceMode, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

const DENSITY_LABEL: Record<Density, string> = {
  comfortable: "Comfortable",
  compact: "Compact",
};

const DATE_DISPLAY_LABEL: Record<DateDisplay, string> = {
  absolute: "Absolute",
  relative: "Relative",
};

/** Applies prefs to the live DOM immediately — same shape layout.tsx applies server-side. */
function applyAppearanceLive(prefs: AppearancePrefs) {
  const html = document.documentElement;
  const { classNames, style } = resolveHtmlAttrs(prefs);
  html.classList.remove("dark", "theme-system", "density-compact");
  for (const c of classNames) html.classList.add(c);
  html.style.fontSize = style.fontSize;
}

/**
 * A captioned group of exclusive options. The caption names the group
 * (`role="group"` + `aria-labelledby`, not a label element over buttons), and each
 * option is a toggle button (`aria-pressed`). The selected option is marked by
 * border, weight and tint together, never by colour alone.
 */
function OptionGroup<T extends string | number>({
  label,
  options,
  labels,
  value,
  onChange,
  columns,
  children,
}: {
  label: string;
  options: readonly T[];
  labels: Record<T, string>;
  value: T;
  onChange: (v: T) => void;
  columns: number;
  children?: React.ReactNode;
}) {
  const captionId = useId();
  return (
    <div role="group" aria-labelledby={captionId} className="space-y-1.5">
      <p id={captionId} className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
        {label}
      </p>
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {options.map((opt) => (
          <button
            key={opt}
            type="button"
            aria-pressed={value === opt}
            // h-11 (44px) keeps every option a valid touch target at 390px (R-63) —
            // no icon-only compression here the way the per-table density toggle uses.
            className={cn(
              "focus-ring flex h-11 items-center justify-center rounded-md border px-2 text-sm transition-colors",
              value === opt
                ? "border-accent bg-accent/10 font-semibold text-ink"
                : "border-border-subtle bg-surface font-medium text-ink-secondary hover:bg-well",
            )}
            onClick={() => onChange(opt)}
          >
            {labels[opt]}
          </button>
        ))}
      </div>
      {children}
    </div>
  );
}

function AppearanceSection() {
  const [prefs, setPrefs] = useState<AppearancePrefs>(DEFAULT_APPEARANCE);
  const dbPrefs = usePreferences();
  // True once the shared store has resolved this as a signed-in, NON-demo
  // user — only then does `update()` PUT density/dateDisplay back to the
  // account (L-39). Stays false for the demo identity (shared login — ADR
  // 0009) or while the store is still loading; either way `update()` keeps
  // behaving exactly as before (cookie/live DOM only, nothing new to break).
  const dbSynced = dbPrefs.ready && !dbPrefs.demo;

  useEffect(() => {
    // Two-pass read (SSR-safe default first, real cookie after mount) —
    // same pattern as ThemeToggle/useDateDisplayPref.
    const cookiePrefs = readAppearanceCookie(document.cookie);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPrefs(cookiePrefs);
  }, []);

  useEffect(() => {
    // L-39 follow-through: merge in the account's DB density/dateDisplay
    // (DB wins for a signed-in non-demo user) — same precedence layout.tsx
    // already applies server-side and use-appearance.ts applies for the
    // date-display hook. R-78: sourced from the shared prefs store instead
    // of a private GET. Best-effort: the store's own fail-soft (empty
    // config on error/anonymous/demo) leaves the cookie-only behavior in
    // place, same as before.
    if (!dbPrefs.ready) return;
    const cookiePrefs = readAppearanceCookie(document.cookie);
    const merged = mergeAppearanceWithDb(cookiePrefs, dbPrefs.config, { isDemo: dbPrefs.demo });
    if (merged.density !== cookiePrefs.density || merged.dateDisplay !== cookiePrefs.dateDisplay) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPrefs(merged);
      document.cookie = buildAppearanceCookieHeader(merged);
      applyAppearanceLive(merged);
    }
  }, [dbPrefs.ready, dbPrefs.config, dbPrefs.demo]);

  function update<K extends keyof AppearancePrefs>(key: K, val: AppearancePrefs[K]) {
    const next = { ...prefs, [key]: val };
    setPrefs(next);
    document.cookie = buildAppearanceCookieHeader(next);
    applyAppearanceLive(next);

    // Mirror density/dateDisplay into the account's DB record so it follows
    // a signed-in non-demo user across devices — mode/fontScale stay
    // cookie/per-device only (outside user_preferences' whitelist, L-39).
    if ((key === "density" || key === "dateDisplay") && dbSynced) {
      void dbPrefs.update({ density: next.density, dateDisplay: next.dateDisplay });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
      </CardHeader>
      <CardBody className="space-y-6">
        <p className="text-sm text-ink-secondary">
          Display only, never audited. Theme and text size stay on this device.
          {dbSynced
            ? " Density and date format follow your account."
            : " Density and date format follow your account when signed in (not on the shared demo login)."}
        </p>

        <OptionGroup
          label="Theme"
          options={APPEARANCE_MODES}
          labels={MODE_LABEL}
          value={prefs.mode}
          onChange={(v) => update("mode", v)}
          columns={3}
        />

        <OptionGroup
          label="Text size"
          options={FONT_SCALES}
          labels={Object.fromEntries(FONT_SCALES.map((s) => [s, `${s}%`])) as Record<FontScale, string>}
          value={prefs.fontScale}
          onChange={(v) => update("fontScale", v)}
          columns={4}
        />

        <OptionGroup
          label="Density"
          options={DENSITIES}
          labels={DENSITY_LABEL}
          value={prefs.density}
          onChange={(v) => update("density", v)}
          columns={2}
        />

        <OptionGroup
          label="Dates"
          options={DATE_DISPLAYS}
          labels={DATE_DISPLAY_LABEL}
          value={prefs.dateDisplay}
          onChange={(v) => update("dateDisplay", v)}
          columns={2}
        >
          <p className="text-xs text-ink-muted">
            Hover a relative date (&quot;In 3d&quot;) for the exact date.
          </p>
        </OptionGroup>
      </CardBody>
    </Card>
  );
}

// ── Navigation & help section (R-78) ───────────────────────────────────────────
//
// Sidebar mode (Essentials/all) writes the SAME cookie + prefs-store path
// as the sidebar's own footer toggle. Page hints and the getting-started
// checklist are display-only bookkeeping (which strips/steps have been
// dismissed) — resetting them never touches governance data.

const NAV_MODE_LABEL: Record<NavMode, string> = {
  essentials: "Essentials (7 core modules)",
  all: "All modules",
};

function NavigationSection() {
  const prefs = usePreferences();
  const [mode, setMode] = useState<NavMode | null>(null);
  const [resetHintsDone, setResetHintsDone] = useState(false);
  const [showStartDone, setShowStartDone] = useState(false);

  useEffect(() => {
    if (!prefs.ready) return;
    const cookieMode = readNavModeCookie(document.cookie);
    const resolved = resolveInitialNavMode({
      cookie: cookieMode,
      dbMode: prefs.config.nav?.mode,
      hasPrefsRow: Boolean(prefs.updatedAt),
      isDemo: prefs.demo,
    });
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMode(resolved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.ready]);

  function chooseMode(next: NavMode) {
    setMode(next);
    document.cookie = buildNavModeCookieHeader(next);
    void prefs.update({ nav: { mode: next } });
  }

  function resetHints() {
    void prefs.update({ hints: { dismissed: [] } });
    setResetHintsDone(true);
    setTimeout(() => setResetHintsDone(false), 2000);
  }

  function showStartAgain() {
    void prefs.update({ start: { dismissed: false, visited: prefs.config.start?.visited ?? [] } });
    setShowStartDone(true);
    setTimeout(() => setShowStartDone(false), 2000);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Navigation &amp; help</CardTitle>
      </CardHeader>
      <CardBody className="space-y-6">
        <p className="text-sm text-ink-secondary">
          Display preferences only, no audit row.
          {prefs.demo
            ? " Saved on this device only (shared demo login)."
            : " Follows your account."}
        </p>

        {mode ? (
          <OptionGroup
            label="Sidebar"
            options={["essentials", "all"] as const}
            labels={NAV_MODE_LABEL}
            value={mode}
            onChange={chooseMode}
            columns={2}
          />
        ) : (
          <div className="space-y-1.5">
            <p className="text-xs font-semibold uppercase tracking-wider text-ink-muted">Sidebar</p>
            <div className="h-11 animate-pulse rounded-md bg-well" />
          </div>
        )}

        <div className="flex items-center justify-between gap-4 border-t border-border-subtle pt-5">
          <div>
            <p className="text-sm text-ink">Page hints</p>
            <p className="text-xs text-ink-muted">Bring back the dismissed &quot;what is this page for&quot; strips.</p>
          </div>
          <Button variant="secondary" size="sm" className="h-11 shrink-0 sm:h-8" onClick={resetHints}>
            {resetHintsDone ? "Reset" : "Reset hints"}
          </Button>
        </div>

        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-ink">Getting started</p>
            <p className="text-xs text-ink-muted">
              Revisit the{" "}
              <a href="/start" className="text-accent hover:underline">
                getting-started checklist
              </a>
              .
            </p>
          </div>
          <Button variant="secondary" size="sm" className="h-11 shrink-0 sm:h-8" onClick={showStartAgain}>
            {showStartDone ? "Shown" : "Show again"}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

// ── Section nav (phones only) ─────────────────────────────────────────────────
//
// Settings is one long single-column scroll (Profile → Appearance →
// Navigation → Invites → Security → About); below sm a horizontally
// scrollable chip row lets a phone user jump straight to a section instead
// of scrolling past MFA/appearance controls to reach it. Anchor links only —
// no client state. scroll-mt-20 on each section target clears the app's
// sticky h-14 top bar.

const SETTINGS_SECTIONS = [
  { id: "settings-profile", label: "Profile" },
  { id: "settings-appearance", label: "Appearance" },
  { id: "settings-navigation", label: "Navigation" },
  { id: "settings-invites", label: "Invites" },
  { id: "settings-security", label: "Security" },
  { id: "settings-about", label: "About" },
] as const;

function SettingsSectionNav() {
  return (
    <nav
      aria-label="Jump to settings section"
      className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:hidden"
    >
      {SETTINGS_SECTIONS.map((s) => (
        <a
          key={s.id}
          href={`#${s.id}`}
          className="flex h-11 shrink-0 items-center rounded-full border border-border-subtle bg-surface px-3.5 text-xs font-medium text-ink-secondary transition-colors hover:bg-well hover:text-ink"
        >
          {s.label}
        </a>
      ))}
    </nav>
  );
}

// ── Turn-off code field ───────────────────────────────────────────────────────
// The API requires the current 6-digit code (or an unused backup code) to turn
// two-step off. The modal body is a snapshot, so the typed value lives in a ref
// the confirm handler reads.
function DisableCodeField({ valueRef }: { valueRef: { current: string } }) {
  const id = useId();
  const [value, setValue] = useState("");
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-ink-secondary">
        Current code or a backup code
      </label>
      <Input
        id={id}
        value={value}
        inputMode="text"
        autoComplete="one-time-code"
        onChange={(e) => {
          setValue(e.target.value);
          valueRef.current = e.target.value;
        }}
      />
    </div>
  );
}

// ── Settings page ──────────────────────────────────────────────────────────────

/**
 * UAT-010: who may approve what lives with the workspace settings, not under Integrations.
 * Admins edit it; managers read it; members and viewers do not see it.
 */
function ApprovalPolicySection() {
  const [role, setRole] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    apiGet<{ role?: string | null } | null>("/api/me")
      .then((me) => {
        if (live) setRole(me?.role ?? null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  if (role !== "admin" && role !== "manager") return null;
  return (
    <div id="settings-approval-policy" className="scroll-mt-20">
      <ApprovalPolicyCard role={role} />
    </div>
  );
}

export default function SettingsPage() {
  const router = useRouter();
  const modal = useModal();
  const toast = useToast();
  const sessionStatus = useRequireSession();
  const codeId = useId();

  // --- global loading ---
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // --- MFA state machine ---
  const [step, setStep] = useState<MfaStep>("idle");
  const [enroll, setEnroll] = useState<EnrollPayload | null>(null);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  // Decision 22: admins and managers must turn two-step on (14-day grace).
  const [mfaNeed, setMfaNeed] = useState<{ mustEnrol: boolean; daysLeft: number | null } | null>(null);

  const loadMfaStatus = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const status = await apiGet<{
        enabled?: boolean;
        required?: boolean;
        must_enrol?: boolean;
        grace_days_left?: number | null;
      } | null>("/api/auth/mfa");
      setStep(status?.enabled ? "enabled" : "idle");
      setMfaNeed(
        status?.required && !status.enabled
          ? { mustEnrol: !!status.must_enrol, daysLeft: status.grace_days_left ?? null }
          : null,
      );
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadMfaStatus();
  }, [loadMfaStatus]);

  const handleEnroll = async () => {
    setStep("enrolling");
    setCodeError(null);
    try {
      const enrolled = await apiPost<EnrollPayload>("/api/auth/mfa/enroll");
      setEnroll({ secret: enrolled.secret, otpauth: enrolled.otpauth });
      setStep("verify");
    } catch (e) {
      // 409 "Two-step is already on. Turn it off first." is shown as sent.
      setCodeError(e instanceof Error ? e.message : "Enrollment failed.");
      if ((e as { status?: number })?.status === 409) {
        toast.error(e instanceof Error ? e.message : "Two-step is already on.");
        setStep("enabled");
      } else {
        setStep("idle");
      }
    }
  };

  const handleVerify = async () => {
    if (code.length !== 6 || !/^\d{6}$/.test(code)) {
      setCodeError("Enter the 6-digit code from your authenticator app.");
      return;
    }
    setStep("verifying");
    setCodeError(null);
    try {
      const verified = await apiPost<{ backupCodes?: string[] } | null>("/api/auth/mfa/verify", { code });
      setBackupCodes(verified?.backupCodes ?? []);
      setCode("");
      setStep("backup");
      router.refresh();
    } catch (e) {
      setCodeError(e instanceof Error ? e.message : "Verification failed.");
      setStep("verify");
    }
  };

  // Turning 2FA off lowers the account's protection, so it asks first; the
  // dialog stays open with the API's message if the call fails.
  const askDisable = () => {
    const typed = { current: "" };
    modal.open(
      <ConfirmDialog
        heading="Turn off two-factor authentication?"
        confirmLabel="Disable 2FA"
        failureFallback="Could not disable 2FA."
        onConfirm={async () => {
          if (!typed.current.trim()) throw new Error("Enter a current code or a backup code to turn two-step off.");
          await apiPost("/api/auth/mfa/disable", { code: typed.current.trim() });
          setCodeError(null);
          setStep("idle");
          toast.success("Two-factor authentication is off.");
          router.refresh();
        }}
      >
        <p>Signing in will only need your password. Your backup codes stop working. You can turn it on again later.</p>
        <DisableCodeField valueRef={typed} />
      </ConfirmDialog>,
      { title: "Disable 2FA", size: "sm" },
    );
  };

  // Client-safe auth guard — settings is a Client Component (it hosts MFA
  // enrollment) so it can't use the server-component
  // `if (!user) redirect("/login")` pattern. Render nothing until the
  // session check resolves; useRequireSession handles the redirect.
  if (sessionStatus !== "authenticated") return null;

  return (
    <PageContainer width="narrow" className="max-w-xl space-y-8">
        <PageHeader title="Account settings" />

        <SettingsSectionNav />

        {/* ── Profile ────────────────────────────────────────────────────────── */}
        <div id="settings-profile" className="scroll-mt-20">
          <ProfileSection />
        </div>

        {/* ── Appearance (L-37/L-38/L-42 — display-only, unaudited) ───────────── */}
        <div id="settings-appearance" className="scroll-mt-20">
          <AppearanceSection />
        </div>

        {/* ── Navigation & help (R-78 — display-only, unaudited) ───────────────── */}
        <div id="settings-navigation" className="scroll-mt-20">
          <NavigationSection />
        </div>

        {/* ── Invites (L-47/L-48) — admin/manager only ─────────────────────────── */}
        <div id="settings-invites" className="scroll-mt-20">
          <InvitesCard />
        </div>

        {/* ── Approval policy (G1-G4, G7) — admins edit, managers read ─────────── */}
        <ApprovalPolicySection />

        {/* ── Security ───────────────────────────────────────────────────────── */}
        <div id="settings-security" className="scroll-mt-20">
          <p className="mb-3 text-2xs font-semibold uppercase tracking-wider text-ink-muted">
            Security
          </p>
          {mfaNeed && step !== "enabled" && (
            <InlineAlert tone={mfaNeed.mustEnrol ? "danger" : "neutral"} className="mb-3">
              {mfaNeed.mustEnrol
                ? "Admins and managers must use two-step sign-in. Turn it on below to keep using the console. API tokens are not affected."
                : `Admins and managers must use two-step sign-in. Turn it on below within ${mfaNeed.daysLeft ?? 14} day${mfaNeed.daysLeft === 1 ? "" : "s"}.`}
            </InlineAlert>
          )}
          <Card>
            <CardHeader>
              <CardTitle>Two-factor authentication (TOTP)</CardTitle>
              {step === "enabled" && (
                <Badge tone="success">Enabled</Badge>
              )}
            </CardHeader>
            <CardBody className="space-y-5">
              {loading ? (
                <div className="flex items-center gap-3 py-2">
                  <Spinner size="sm" />
                  <span className="text-sm text-ink-secondary">Checking 2FA status…</span>
                </div>
              ) : loadError ? (
                <InlineAlert>{loadError}</InlineAlert>
              ) : null}

              {/* ── IDLE: not enrolled ── */}
              {!loading && step === "idle" && (
                <div className="space-y-4">
                  <p className="text-sm text-ink-secondary">
                    Sign-in will ask for a code from your authenticator app (or a backup code).
                  </p>
                  {codeError && <InlineAlert>{codeError}</InlineAlert>}
                  <Button variant="primary" size="md" className="h-11 w-full sm:h-10 sm:w-auto" onClick={handleEnroll}>
                    Enable 2FA
                  </Button>
                </div>
              )}

              {/* ── ENROLLING: waiting ── */}
              {step === "enrolling" && (
                <div className="flex items-center gap-3 py-2">
                  <Spinner size="sm" />
                  <span className="text-sm text-ink-secondary">Setting up…</span>
                </div>
              )}

              {/* ── VERIFY: show secret + code input ── */}
              {(step === "verify" || step === "verifying") && enroll && (
                <div className="space-y-5">
                  <p className="text-sm text-ink-secondary">
                    Add this to your authenticator app, then enter the 6-digit code to confirm.
                  </p>

                  {/* Secret display */}
                  <div className="rounded-lg border border-border-subtle bg-well p-4 space-y-3">
                    <div>
                      <p className="text-xs font-medium text-ink-muted uppercase tracking-wide mb-1">
                        Manual entry secret
                      </p>
                      <code className="block break-all font-mono text-sm text-ink bg-canvas rounded-md border border-border-subtle px-3 py-2">
                        {enroll.secret}
                      </code>
                    </div>
                    <div>
                      <p className="text-xs font-medium text-ink-muted uppercase tracking-wide mb-1">
                        OTPAuth URI (scan or paste into app)
                      </p>
                      <code className="block break-all font-mono text-xs text-ink-secondary bg-canvas rounded-md border border-border-subtle px-3 py-2">
                        {enroll.otpauth}
                      </code>
                    </div>
                  </div>

                  <Field id={codeId} label="Verification code" error={codeError ?? undefined}>
                    {(a11y) => (
                      <Input
                        {...a11y}
                        type="text"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        pattern="\d{6}"
                        maxLength={6}
                        placeholder="000000"
                        value={code}
                        onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                        disabled={step === "verifying"}
                        className="font-mono tracking-widest text-center h-11 sm:h-10 text-base sm:text-sm"
                      />
                    )}
                  </Field>

                  <div className="flex items-center gap-3">
                    <Button
                      variant="primary"
                      size="md"
                      className="h-11 sm:h-10"
                      onClick={handleVerify}
                      disabled={step === "verifying" || code.length !== 6}
                    >
                      {step === "verifying" ? (
                        <>
                          <Spinner size="sm" className="mr-2" /> Verifying…
                        </>
                      ) : (
                        "Verify & activate"
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="md"
                      className="h-11 sm:h-10"
                      disabled={step === "verifying"}
                      onClick={() => {
                        setStep("idle");
                        setEnroll(null);
                        setCode("");
                        setCodeError(null);
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}

              {/* ── BACKUP: one-time codes ── */}
              {step === "backup" && (
                <ShowOncePanel
                  heading="2FA is now active. Save your backup codes"
                  notice="Shown once — save them now."
                  dismissLabel="Done — I have saved my codes"
                  onDismiss={() => {
                    setBackupCodes([]);
                    setStep("enabled");
                  }}
                >
                  <p className="text-sm text-ink-secondary">
                    Keep these safe. Each code works once if you lose your authenticator.
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    {backupCodes.map((bc) => (
                      <code
                        key={bc}
                        className="font-mono text-sm text-ink bg-canvas rounded border border-border-subtle px-2 py-1 text-center"
                      >
                        {bc}
                      </code>
                    ))}
                  </div>
                  <CopyButton value={backupCodes.join("\n")} subject="backup codes" label="Copy all" />
                </ShowOncePanel>
              )}

              {/* ── ENABLED ── */}
              {step === "enabled" && !loading && (
                <div className="space-y-4">
                  <p className="text-sm text-ink-secondary">
                    Two-factor authentication is on.
                  </p>

                  <Button
                    variant="secondary"
                    size="md"
                    className="h-11 w-full border-danger/30 text-danger-ink hover:bg-danger/10 sm:h-10 sm:w-auto"
                    onClick={askDisable}
                  >
                    Disable 2FA
                  </Button>
                </div>
              )}

            </CardBody>
          </Card>
        </div>

        {/* ── About / Support ────────────────────────────────────────────────── */}
        <div id="settings-about" className="scroll-mt-20">
          <p className="mb-3 text-2xs font-semibold uppercase tracking-wider text-ink-muted">
            About
          </p>
          <Card>
            <CardBody className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-ink-secondary">NoPM</span>
                <span className="font-mono text-xs text-ink-muted">v1</span>
              </div>
              <div className="flex items-center gap-4">
                <a
                  href="/case-study"
                  className="text-sm text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  Case study
                </a>
                <a
                  href="mailto:hello@stillnotbald.com"
                  className="text-sm text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  Contact support
                </a>
              </div>
            </CardBody>
          </Card>
        </div>
    </PageContainer>
  );
}
