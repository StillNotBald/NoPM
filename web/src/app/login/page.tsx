"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DemoLoginButton } from "@/components/demo-login-button";
import { cn } from "@/lib/cn";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const supabase = createClient();
      const { error: authError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (authError) {
        setError(authError.message);
        return;
      }

      router.push("/dashboard");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm">
        {/* Wordmark */}
        <div className="mb-8 text-center">
          <Link href="/" className="text-2xl font-semibold tracking-tight text-ink">
            No<span className="text-accent">PM</span>
          </Link>
          <p className="mt-1 text-sm text-ink-muted">Project intelligence for operators</p>
        </div>

        <Card className="mb-4">
          <CardBody className="p-6 text-center">
            <p className="text-sm font-medium text-ink">One-click demo — no password needed</p>
            <p className="mt-1 text-xs text-ink-muted">
              Sign in instantly as the pre-seeded demo user.
            </p>
            <div className="mt-4 flex justify-center">
              <DemoLoginButton className="w-full px-5 py-2.5" label="Try the live demo →" />
            </div>
          </CardBody>
        </Card>

        <div className="mb-4 flex items-center gap-3 text-xs text-ink-muted">
          <span className="h-px flex-1 bg-border-subtle" />
          or sign in manually
          <span className="h-px flex-1 bg-border-subtle" />
        </div>

        <Card>
          <CardBody className="p-6">
            <h1 className="mb-6 text-base font-medium text-ink">Sign in to your workspace</h1>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <label htmlFor="email" className="text-xs font-medium uppercase tracking-wide text-ink-muted">
                  Email
                </label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  disabled={loading}
                />
              </div>

              <div className="space-y-1.5">
                <label htmlFor="password" className="text-xs font-medium uppercase tracking-wide text-ink-muted">
                  Password
                </label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  disabled={loading}
                />
              </div>

              {error && (
                <p className={cn("rounded-md border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger")}>
                  {error}
                </p>
              )}

              <Button
                type="submit"
                variant="primary"
                size="md"
                className="w-full"
                disabled={loading}
              >
                {loading ? "Signing in…" : "Sign in"}
              </Button>
            </form>

            <p className="mt-5 text-center text-xs text-ink-muted">
              demo: admin@stillnotbald.com
            </p>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
