import { useId, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/** What a control inside a <Field> must spread to be wired to its label, hint and error. */
export interface FieldA11y {
  id: string;
  "aria-invalid": boolean;
  "aria-describedby"?: string;
  "aria-required"?: true;
}

/**
 * Label + control + hint/error, wired with htmlFor / aria-describedby /
 * aria-invalid. The id comes from `useId` (pass `id` only when something else
 * must address the control, e.g. to focus it on a failed submit).
 *
 *   <Field label="Name" error={errors.name} required>
 *     {(a11y) => <Input {...a11y} value={name} onChange={...} />}
 *   </Field>
 *
 * The error is announced (`role="alert"`) and replaces the hint. Use this
 * instead of a bare sibling <label>, which names nothing.
 */
export function Field({
  id: idProp,
  label,
  optional,
  required,
  hint,
  error,
  className,
  children,
}: {
  id?: string;
  label: string;
  /** Appends "(optional)". Mutually exclusive with `required` in practice. */
  optional?: boolean;
  /** Appends a visual asterisk and sets `aria-required` on the control. */
  required?: boolean;
  hint?: string;
  error?: string;
  className?: string;
  children: (a11y: FieldA11y) => ReactNode;
}) {
  const generated = useId();
  const id = idProp ?? generated;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = error ? errorId : hint ? hintId : undefined;
  return (
    <div className={cn("min-w-0 space-y-1.5", className)}>
      <label htmlFor={id} className="block text-xs font-semibold uppercase tracking-wider text-ink-muted">
        {label}
        {required && (
          <span aria-hidden="true" className="ml-0.5 text-danger-ink">
            *
          </span>
        )}
        {optional && <span className="ml-1 font-normal normal-case tracking-normal">(optional)</span>}
      </label>
      {children({
        id,
        "aria-invalid": Boolean(error),
        "aria-describedby": describedBy,
        ...(required ? { "aria-required": true as const } : {}),
      })}
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-danger-ink">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-xs text-ink-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
