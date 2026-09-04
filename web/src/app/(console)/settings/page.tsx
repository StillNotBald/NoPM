"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { PageHeader } from "@/components/ui/page-header";
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
  | "enabled"      // MFA already active
  | "disabling";   // waiting for POST /disable response

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

  useEffect(() => {
    Promise.all([
      fetch("/api/me").then((r) => r.json()).catch(() => null),
      createClient().auth.getUser().then(({ data }) => data.user?.email ?? null).catch(() => null),
    ])
      .then(([json, mail]) => {
        if (json?.data) {
          const id: Identity = {
            label: json.data.label ?? "",
            role: json.data.role ?? null,
            workspaceId: json.data.workspaceId ?? "",
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
      const res = await fetch("/api/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ display_name: displayName.trim() }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not save profile.");
      setIdentity((prev) =>
        prev ? { ...prev, label: json.data.label ?? displayName.trim() } : prev,
      );
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
            <div className="space-y-1.5">
              <label className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
                Display name
              </label>
              <Input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Your name"
                disabled={saving}
                className="h-10"
              />
            </div>

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

            {saveError && (
              <p className="rounded-md bg-danger/15 px-3 py-2 text-sm text-danger">{saveError}</p>
            )}
            {saveSuccess && (
              <p className="rounded-md bg-success/15 px-3 py-2 text-sm text-success">
                Profile saved.
              </p>
            )}

            <Button
              variant="primary"
              size="md"
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

function SegmentedControl<T extends string | number>({
  options,
  labels,
  value,
  onChange,
  columns,
}: {
  options: readonly T[];
  labels: Record<T, string>;
  value: T;
  onChange: (v: T) => void;
  columns: number;
}) {
  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          aria-pressed={value === opt}
          // h-11 (44px) keeps every option a valid touch target at 390px (R-63) —
          // no icon-only compression here the way the per-table density toggle uses.
          className={cn(
            "flex h-11 items-center justify-center rounded-md border px-2 text-sm font-medium transition-colors",
            value === opt
              ? "border-accent bg-accent/10 text-accent"
              : "border-border-subtle bg-surface text-ink-secondary hover:bg-sunken",
          )}
          onClick={() => onChange(opt)}
        >
          {labels[opt]}
        </button>
      ))}
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
          Display-only, never audited. Theme and text size stay on this device (a cookie).
          {dbSynced
            ? " Density and date format also follow your account across devices."
            : " Density and date format follow your account when you're signed in (not on the shared demo login)."}
        </p>

        <div className="space-y-1.5">
          <label className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
            Theme
          </label>
          <SegmentedControl
            options={APPEARANCE_MODES}
            labels={MODE_LABEL}
            value={prefs.mode}
            onChange={(v) => update("mode", v)}
            columns={3}
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
            Text size
          </label>
          <SegmentedControl
            options={FONT_SCALES}
            labels={Object.fromEntries(FONT_SCALES.map((s) => [s, `${s}%`])) as Record<FontScale, string>}
            value={prefs.fontScale}
            onChange={(v) => update("fontScale", v)}
            columns={4}
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
            Density
          </label>
          <SegmentedControl
            options={DENSITIES}
            labels={DENSITY_LABEL}
            value={prefs.density}
            onChange={(v) => update("density", v)}
            columns={2}
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
            Dates
          </label>
          <SegmentedControl
            options={DATE_DISPLAYS}
            labels={DATE_DISPLAY_LABEL}
            value={prefs.dateDisplay}
            onChange={(v) => update("dateDisplay", v)}
            columns={2}
          />
          <p className="text-xs text-ink-muted">
            Relative dates (&quot;In 3d&quot;) always show the exact date on hover.
          </p>
        </div>
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
          Sidebar mode and hint dismissals are display preferences — not governance data, no audit row.
          {prefs.demo
            ? " Saved on this device only — you're on the shared demo login."
            : " Your choice follows this account across devices."}
        </p>

        <div className="space-y-1.5">
          <label className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
            Sidebar
          </label>
          {mode ? (
            <SegmentedControl
              options={["essentials", "all"] as const}
              labels={NAV_MODE_LABEL}
              value={mode}
              onChange={chooseMode}
              columns={2}
            />
          ) : (
            <div className="h-11 animate-pulse rounded-md bg-sunken" />
          )}
        </div>

        <div className="flex items-center justify-between gap-4 border-t border-border-subtle pt-5">
          <div>
            <p className="text-sm text-ink">Page hints</p>
            <p className="text-xs text-ink-muted">Bring back the dismissed &quot;what is this page for&quot; strips.</p>
          </div>
          <Button variant="secondary" size="sm" onClick={resetHints}>
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
          <Button variant="secondary" size="sm" onClick={showStartAgain}>
            {showStartDone ? "Shown" : "Show again"}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

// ── Settings page ──────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const router = useRouter();
  const sessionStatus = useRequireSession();

  // --- global loading ---
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // --- MFA state machine ---
  const [step, setStep] = useState<MfaStep>("idle");
  const [enroll, setEnroll] = useState<EnrollPayload | null>(null);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [copiedBackup, setCopiedBackup] = useState(false);

  const loadMfaStatus = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/auth/mfa");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not load 2FA status.");
      const enabled: boolean = json.data?.enabled ?? false;
      setStep(enabled ? "enabled" : "idle");
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
      const res = await fetch("/api/auth/mfa/enroll", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Enrollment failed.");
      setEnroll({ secret: json.data.secret, otpauth: json.data.otpauth });
      setStep("verify");
    } catch (e) {
      setCodeError(e instanceof Error ? e.message : "Enrollment failed.");
      setStep("idle");
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
      const res = await fetch("/api/auth/mfa/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Verification failed — check your code.");
      setBackupCodes(json.data?.backupCodes ?? []);
      setCode("");
      setStep("backup");
      router.refresh();
    } catch (e) {
      setCodeError(e instanceof Error ? e.message : "Verification failed.");
      setStep("verify");
    }
  };

  const handleDisable = async () => {
    setStep("disabling");
    try {
      const res = await fetch("/api/auth/mfa/disable", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not disable 2FA.");
      setStep("idle");
      router.refresh();
    } catch (e) {
      // revert to enabled, surface message
      setCodeError(e instanceof Error ? e.message : "Could not disable 2FA.");
      setStep("enabled");
    }
  };

  const handleCopyBackup = async () => {
    await navigator.clipboard.writeText(backupCodes.join("\n"));
    setCopiedBackup(true);
    setTimeout(() => setCopiedBackup(false), 2000);
  };

  // Client-safe auth guard — settings is a Client Component (it hosts MFA
  // enrollment) so it can't use the server-component
  // `if (!user) redirect("/login")` pattern. Render nothing until the
  // session check resolves; useRequireSession handles the redirect.
  if (sessionStatus !== "authenticated") return null;

  return (
    <div className="px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
      <div className="mx-auto max-w-xl space-y-8">
        <PageHeader title="Account settings" />

        {/* ── Profile ────────────────────────────────────────────────────────── */}
        <ProfileSection />

        {/* ── Appearance (L-37/L-38/L-42 — display-only, unaudited) ───────────── */}
        <AppearanceSection />

        {/* ── Navigation & help (R-78 — display-only, unaudited) ───────────────── */}
        <NavigationSection />

        {/* ── Invites (L-47/L-48) — admin/manager only ─────────────────────────── */}
        <InvitesCard />

        {/* ── Security ───────────────────────────────────────────────────────── */}
        <div>
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
            Security
          </p>
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
                <p className="rounded-md bg-danger/15 px-3 py-2 text-sm text-danger">{loadError}</p>
              ) : null}

              {/* ── IDLE: not enrolled ── */}
              {!loading && step === "idle" && (
                <div className="space-y-4">
                  <p className="text-sm text-ink-secondary">
                    Two-factor authentication adds a second layer of security to your account. You will
                    need an authenticator app (e.g. Authy, 1Password, or Google Authenticator).
                  </p>
                  <Button variant="primary" size="md" onClick={handleEnroll}>
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
                    Add this to your authenticator app, then enter the 6-digit code it shows to confirm.
                  </p>

                  {/* Secret display */}
                  <div className="rounded-lg border border-border-subtle bg-sunken p-4 space-y-3">
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

                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-ink-secondary uppercase tracking-wide">
                      Verification code
                    </label>
                    <Input
                      type="text"
                      inputMode="numeric"
                      pattern="\d{6}"
                      maxLength={6}
                      placeholder="000000"
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                      disabled={step === "verifying"}
                      className="font-mono tracking-widest text-center h-11 sm:h-10 text-base sm:text-sm"
                    />
                  </div>

                  {codeError && (
                    <p className="rounded-md bg-danger/15 px-3 py-2 text-sm text-danger">{codeError}</p>
                  )}

                  <div className="flex items-center gap-3">
                    <Button
                      variant="primary"
                      size="md"
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
                <div className="space-y-5">
                  <div className="flex items-start gap-3 rounded-lg bg-success/15 border border-border-subtle px-4 py-3">
                    <span className="text-success text-base mt-0.5">✓</span>
                    <p className="text-sm text-ink">
                      <span className="font-medium">2FA is now active.</span> Save these backup codes
                      somewhere secure — they are shown once and can each be used once if you lose
                      access to your authenticator.
                    </p>
                  </div>

                  <div className="rounded-lg border border-border-subtle bg-sunken p-4 space-y-3">
                    <p className="text-xs font-medium text-ink-muted uppercase tracking-wide">
                      Backup codes — shown once
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
                    <Button variant="secondary" size="sm" onClick={handleCopyBackup}>
                      {copiedBackup ? "Copied!" : "Copy all codes"}
                    </Button>
                  </div>

                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-ink-secondary"
                    onClick={() => setStep("enabled")}
                  >
                    Done — I have saved my codes
                  </Button>
                </div>
              )}

              {/* ── ENABLED ── */}
              {step === "enabled" && !loading && (
                <div className="space-y-4">
                  <p className="text-sm text-ink-secondary">
                    Your account is protected with two-factor authentication. Keep your authenticator
                    app accessible.
                  </p>

                  {codeError && (
                    <p className="rounded-md bg-danger/15 px-3 py-2 text-sm text-danger">{codeError}</p>
                  )}

                  <Button
                    variant="secondary"
                    size="md"
                    className="text-danger border-danger/30 hover:bg-danger/10"
                    onClick={handleDisable}
                  >
                    Disable 2FA
                  </Button>
                </div>
              )}

              {/* ── DISABLING ── */}
              {step === "disabling" && (
                <div className="flex items-center gap-3 py-2">
                  <Spinner size="sm" />
                  <span className="text-sm text-ink-secondary">Disabling 2FA…</span>
                </div>
              )}
            </CardBody>
          </Card>
        </div>

        {/* ── About / Support ────────────────────────────────────────────────── */}
        <div>
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
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
                  className="text-sm text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  Case study
                </a>
                <a
                  href="mailto:hello@stillnotbald.com"
                  className="text-sm text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  Contact support
                </a>
              </div>
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}
