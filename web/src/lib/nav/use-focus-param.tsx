"use client";

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * Reads a focus query param (e.g. ?risk=<id>) so a register page can auto-open
 * the inspector for a deep-linked record, and returns a clear() that strips the
 * param without a full navigation (so closing the inspector leaves a clean URL).
 *
 * NOTE: a component calling this must be rendered inside a <Suspense> boundary
 * (Next.js requirement for useSearchParams).
 */
export function useFocusParam(name: string): { focusId: string | null; clear: () => void } {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const focusId = sp.get(name);

  const clear = useCallback(() => {
    const next = new URLSearchParams(Array.from(sp.entries()));
    next.delete(name);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [sp, router, pathname, name]);

  return { focusId, clear };
}
