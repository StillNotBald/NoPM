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
