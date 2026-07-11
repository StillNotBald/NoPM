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
}: DemoLoginButtonProps) {
  return (
    <form method="POST" action="/api/auth/demo-login">
      <button
        type="submit"
        className={cn("rounded-md font-medium", variantClasses[variant], className)}
      >
        {label}
      </button>
    </form>
  );
}
