"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export type SessionGuardStatus = "checking" | "authenticated" | "unauthenticated";

type SessionCheckOutcome = { ok: true; hasUser: boolean } | { ok: false };

/**
 * Pure decision logic for the client-side session guard — given the
 * settled outcome of a `supabase.auth.getUser()` call, decide whether the
 * caller is authenticated. Extracted so it can be unit tested without
 * mounting React or touching the network.
 *
 * Fails closed: an errored/rejected check is treated the same as "no user"
 * (→ redirect), mirroring the server-component pattern
 * `if (!user) redirect("/login")` used by every other (console) page.
 */
export function decideSessionGuardStatus(
  outcome: SessionCheckOutcome,
): Exclude<SessionGuardStatus, "checking"> {
  if (!outcome.ok) return "unauthenticated";
  return outcome.hasUser ? "authenticated" : "unauthenticated";
}

/**
 * Client-safe auth guard for (console) pages that must be Client Components
 * (settings — hosts MFA enrollment — and tokens) and therefore can't use the
 * `if (!user) redirect("/login")` pattern the other 18 (console) pages use
 * as Server Components. Checks the Supabase session client-side and
 * `router.replace("/login")`s when there is none. Does NOT touch
 * middleware.ts or any server component.
 *
 * Usage:
 *   const sessionStatus = useRequireSession();
 *   ...(after all other hooks)...
 *   if (sessionStatus !== "authenticated") return null; // or a skeleton
 */
export function useRequireSession(): SessionGuardStatus {
  const router = useRouter();
  const [status, setStatus] = useState<SessionGuardStatus>("checking");

  useEffect(() => {
    let cancelled = false;

    createClient()
      .auth.getUser()
      .then(({ data, error }) => {
        if (cancelled) return;
        const next = decideSessionGuardStatus({ ok: true, hasUser: !!data.user && !error });
        setStatus(next);
        if (next === "unauthenticated") router.replace("/login");
      })
      .catch(() => {
        if (cancelled) return;
        setStatus(decideSessionGuardStatus({ ok: false }));
        router.replace("/login");
      });

    return () => {
      cancelled = true;
    };
  }, [router]);

  return status;
}
