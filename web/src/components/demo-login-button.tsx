"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import {
  marketingButtonClass,
  type MarketingButtonSize,
  type MarketingButtonVariant,
} from "@/components/marketing/button-link";

export type DemoLoginButtonProps = {
  /** Extra classes on the button (sizing comes from `size` / `block`). */
  className?: string;
  /** Button label. One wording everywhere: the demo is "Try the live demo". */
  label?: string;
  /** Color treatment. Defaults to the filled accent button. */
  variant?: Exclude<MarketingButtonVariant, "link">;
  /** `sm` is the header size. */
  size?: MarketingButtonSize;
  /** Full width below `sm` so it matches the CTAs stacked with it. */
  block?: boolean;
  /**
   * Optional one-line disclaimer rendered under the button (e.g. flagging
   * the shared-account nature of the demo). Omitted entirely when not
   * passed — every existing caller keeps its current appearance untouched.
   */
  caption?: string;
};

/**
 * Demo entry button — a plain HTML form, so it works without JS: POST
 * /api/auth/demo-login sets the session cookies server-side and redirects to
 * /dashboard (or back to /login?error=… when the demo cannot sign in).
 *
 * The only client code is the pending state: sign-in takes a beat, and a
 * button that does nothing visible invites a second click. The label changes,
 * further submits are ignored, and a back/forward-cache restore resets it.
 */
export function DemoLoginButton({
  className,
  label = "Try the live demo",
  variant = "primary",
  size = "md",
  block = false,
  caption,
}: DemoLoginButtonProps) {
  const [pending, setPending] = useState(false);

  useEffect(() => {
    // Coming back to a bfcache-restored page must not leave the button stuck.
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) setPending(false);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  return (
    <div className={cn("flex flex-col gap-1.5", block && "w-full sm:w-auto", caption && "items-center")}>
      <form
        method="POST"
        action="/api/auth/demo-login"
        className={block ? "w-full sm:w-auto" : undefined}
        onSubmit={(e) => {
          if (pending) {
            e.preventDefault();
            return;
          }
          setPending(true);
        }}
      >
        <button
          type="submit"
          aria-busy={pending}
          className={cn(
            marketingButtonClass({ variant, size, block }),
            pending && "cursor-progress opacity-80",
            className,
          )}
        >
          {pending ? "Signing you in…" : label}
        </button>
      </form>
      {caption && <p className="text-xs text-ink-muted">{caption}</p>}
    </div>
  );
}
