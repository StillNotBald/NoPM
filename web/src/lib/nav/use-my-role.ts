"use client";

import { useEffect, useState } from "react";

/** Role + whether /api/me has answered yet. */
export function useMyRoleState(): { role: string | null; ready: boolean } {
  const [state, setState] = useState<{ role: string | null; ready: boolean }>({ role: null, ready: false });
  useEffect(() => {
    let live = true;
    fetch("/api/me")
      .then((r) => r.json())
      .then((j) => live && setState({ role: j?.data?.role ?? null, ready: true }))
      .catch(() => live && setState({ role: null, ready: true }));
    return () => {
      live = false;
    };
  }, []);
  return state;
}

/** The signed-in person's workspace role from /api/me; null until known (or if unknown). */
export function useMyRole(): string | null {
  return useMyRoleState().role;
}
