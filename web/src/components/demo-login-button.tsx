import { cn } from "@/lib/cn";

type DemoLoginButtonVariant = "primary" | "secondary";

const variantClasses: Record<DemoLoginButtonVariant, string> = {
  primary: "bg-accent text-white hover:bg-accent-hover",
  secondary: "border border-border-strong text-ink hover:bg-sunken",
};

export type DemoLoginButtonProps = {
  /** Extra classes — typically padding/text-size to fit the surrounding CTA context. */
  className?: string;
  /** Button label. Defaults to the landing-page copy. */
  label?: string;
  /** Color treatment. Defaults to the filled accent button used on the landing page. */
  variant?: DemoLoginButtonVariant;
  /**
   * Optional one-line disclaimer rendered under the button (e.g. flagging
   * the shared-account nature of the demo). Omitted entirely when not
   * passed — every existing caller keeps its current appearance untouched.
   */
  caption?: string;
};

/**
 * Demo entry button — renders as a plain HTML form so it works without JS
 * and avoids any client bundle. POST /api/auth/demo-login sets the session
 * cookies server-side and redirects to /dashboard.
 */
export function DemoLoginButton({
  className = "px-5 py-2.5",
  label = "Try the live demo →",
  variant = "primary",
  caption,
}: DemoLoginButtonProps) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <form method="POST" action="/api/auth/demo-login">
        <button
          type="submit"
          className={cn(
            "inline-flex min-h-[44px] items-center justify-center rounded-md font-medium sm:min-h-0",
            variantClasses[variant],
            className,
          )}
        >
          {label}
        </button>
      </form>
      {caption && <p className="text-xs text-ink-muted">{caption}</p>}
    </div>
  );
}
