"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createDraftSync, type DraftSync } from "@/components/registers/debounced-draft";

/**
 * Local draft for a URL-bound text input: the input is driven by `draft` (never
 * by the URL), `commit` is debounced, and URL changes only overwrite the draft
 * when they did not come from this input (see debounced-draft.ts).
 *
 * Returns `[draft, setDraft, flush]` — wire `setDraft` to onChange and `flush`
 * to onBlur / Enter so tabbing away or pressing Enter applies immediately.
 */
export function useDebouncedDraft(
  external: string,
  commit: (value: string) => void,
  delayMs = 300,
): [string, (value: string) => void, () => void] {
  const [draft, setDraftState] = useState(external);
  const commitRef = useRef(commit);
  const syncRef = useRef<DraftSync | null>(null);

  useEffect(() => {
    commitRef.current = commit;
  });

  // Created once per mount; the effect below owns its lifetime. The commit goes
  // through a ref so a changing router/searchParams identity never rebuilds it.
  useEffect(() => {
    const sync = createDraftSync({
      external,
      delayMs,
      commit: (v) => commitRef.current(v),
      onDraft: setDraftState,
    });
    syncRef.current = sync;
    return () => {
      sync.dispose();
      syncRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only: later `external` values go through receive()
  }, [delayMs]);

  useEffect(() => {
    syncRef.current?.receive(external);
  }, [external]);

  const setDraft = useCallback((value: string) => {
    // Update the input synchronously so the caret never jumps; the controller
    // then schedules the commit.
    setDraftState(value);
    syncRef.current?.type(value);
  }, []);

  const flush = useCallback(() => syncRef.current?.flush(), []);

  return [draft, setDraft, flush];
}
