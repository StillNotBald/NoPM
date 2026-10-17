"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiPost } from "@/lib/api-client";

const MIN_PASSWORD_LENGTH = 12;

/**
 * Public accept form (L-47/L-48). `token` is only ever sent inside the POST
 * body to /api/invites/accept — it is NEVER rendered in the DOM (it already
 * lives in the URL the user arrived on).
 */
export function AcceptInviteForm({ token, email }: { token: string; email: string }) {
  const router = useRouter();
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!displayName.trim()) {
      setError("Enter your name.");
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setSubmitting(true);
    try {
      await apiPost("/api/invites/accept", {
        token,
        password,
        display_name: displayName.trim(),
      });
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not accept this invite.");
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="space-y-4 text-center">
        <p className="text-sm text-ink">
          <span className="font-medium">Your account is ready.</span> Sign in to get started.
        </p>
        <Button
          variant="primary"
          size="md"
          className="w-full"
          onClick={() => router.push(`/login?email=${encodeURIComponent(email)}`)}
        >
          Go to sign in →
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <label htmlFor="display_name" className="text-xs font-medium uppercase tracking-wide text-ink-muted">
          Your name
        </label>
        <Input
          id="display_name"
          type="text"
          autoComplete="name"
          placeholder="Jordan Lee"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          required
          disabled={submitting}
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="password" className="text-xs font-medium uppercase tracking-wide text-ink-muted">
          Password
        </label>
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={MIN_PASSWORD_LENGTH}
          disabled={submitting}
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="confirm_password" className="text-xs font-medium uppercase tracking-wide text-ink-muted">
          Confirm password
        </label>
        <Input
          id="confirm_password"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          required
          minLength={MIN_PASSWORD_LENGTH}
          disabled={submitting}
        />
      </div>

      {error && (
        <p className="rounded-md border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger-ink">
          {error}
        </p>
      )}

      <Button type="submit" variant="primary" size="md" className="w-full" disabled={submitting}>
        {submitting ? "Creating your account…" : "Accept invite"}
      </Button>
    </form>
  );
}
