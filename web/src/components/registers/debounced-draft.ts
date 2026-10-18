/**
 * Draft-first text input state for URL-bound filters.
 *
 * A search box whose `value` is read straight back from the URL loses
 * keystrokes: each character triggers a navigation, the navigation lags the
 * next keystroke, and the late echo of an older URL overwrites what the user
 * has typed since. The fix is a LOCAL draft that the user edits freely, a
 * debounced commit to the URL, and a rule for which URL changes are allowed to
 * overwrite the draft.
 *
 * That rule is the whole point of this module:
 *   - a URL value we committed ourselves (and haven't seen echoed yet) is an
 *     ECHO — ignore it, however late or out of order it lands;
 *   - any other URL value (Clear filters, Back/Forward, applying a saved view)
 *     is a genuine EXTERNAL change — the draft adopts it and drops anything
 *     still pending.
 *
 * Pure + timer-injectable (no React, no DOM) so the typing behaviour is
 * unit-testable in a node environment; `use-debounced-draft.ts` wraps it as a
 * hook.
 */

export interface DraftSyncOptions {
  /** URL value at mount. */
  external: string;
  /** Quiet period after the last keystroke before the URL is written. */
  delayMs: number;
  /** Write the value to the URL. */
  commit: (value: string) => void;
  /** The draft changed (typing, or adopting an external change) — update the input. */
  onDraft: (value: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface DraftSync {
  readonly draft: string;
  /** The user typed. */
  type(value: string): void;
  /** Commit now if a commit is pending (Enter / blur). */
  flush(): void;
  /** The URL-derived value was (re)read. Safe to call every render. */
  receive(external: string): void;
  /** Cancel any pending commit (unmount). */
  dispose(): void;
}

export function createDraftSync(options: DraftSyncOptions): DraftSync {
  const { delayMs, commit, onDraft } = options;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let draft = options.external;
  let lastExternal = options.external;
  /** Values committed to the URL whose echo hasn't been seen yet, oldest first. */
  let inflight: string[] = [];
  let timer: unknown = null;

  function cancelTimer() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  function send() {
    const settled = inflight.length > 0 ? inflight[inflight.length - 1] : lastExternal;
    if (draft === settled) return; // URL already is (or is about to be) this value
    inflight.push(draft);
    commit(draft);
  }

  return {
    get draft() {
      return draft;
    },
    type(value) {
      draft = value;
      onDraft(value);
      cancelTimer();
      timer = setTimer(() => {
        timer = null;
        send();
      }, delayMs);
    },
    flush() {
      if (timer === null) return;
      cancelTimer();
      send();
    },
    receive(external) {
      if (external === lastExternal) return;
      lastExternal = external;
      const echoed = inflight.indexOf(external);
      if (echoed >= 0) {
        // Our own write landed (or a later one skipped past earlier ones).
        inflight = inflight.slice(echoed + 1);
        return;
      }
      inflight = [];
      cancelTimer();
      if (draft !== external) {
        draft = external;
        onDraft(external);
      }
    },
    dispose() {
      cancelTimer();
    },
  };
}
