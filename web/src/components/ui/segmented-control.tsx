"use client";

/**
 * SegmentedControl: accessible single-select switch (view / lens / filter).
 *
 *   <SegmentedControl
 *     label="View"
 *     value={view}
 *     onChange={setView}
 *     options={[{ value: "list", label: "List" }, { value: "board", label: "Board", count: 4 }]}
 *   />
 *
 * Semantics: role="radiogroup" with role="radio" segments, roving tabindex
 * (only the selected segment is in the tab order), Arrow keys + Home/End
 * move and select. `attention` on an option tints its count only when
 * something needs action. Controlled; no internal state. Segments are 44px
 * tall below sm (touch rule) and the compact 28/32px from sm up.
 */
import { useRef, type KeyboardEvent } from "react";
import { cn } from "@/lib/cn";

export interface SegmentOption<T extends string = string> {
  value: T;
  label: string;
  count?: number;
  disabled?: boolean;
  /** Tint the count with the accent. Use only when action is needed. */
  attention?: boolean;
}

export function SegmentedControl<T extends string = string>({
  options,
  value,
  onChange,
  label,
  size = "md",
  className,
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name for the group (required). */
  label: string;
  size?: "sm" | "md";
  className?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);

  function onKeyDown(e: KeyboardEvent, idx: number) {
    if (enabled.length === 0) return;
    const pos = enabled.indexOf(idx);
    let target = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") target = enabled[(pos + 1) % enabled.length];
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp")
      target = enabled[(pos - 1 + enabled.length) % enabled.length];
    else if (e.key === "Home") target = enabled[0];
    else if (e.key === "End") target = enabled[enabled.length - 1];
    if (target < 0) return;
    e.preventDefault();
    refs.current[target]?.focus();
    onChange(options[target].value);
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        "inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-md border border-border-subtle bg-sunken p-0.5",
        className,
      )}
    >
      {options.map((o, i) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={o.disabled}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              "focus-ring inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[5px] font-medium transition-colors",
              size === "sm" ? "h-11 px-2.5 text-xs sm:h-7" : "h-11 px-3 text-sm sm:h-8",
              selected ? "bg-surface text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
              "disabled:pointer-events-none disabled:opacity-50",
            )}
          >
            {o.label}
            {o.count !== undefined && (
              <span
                className={cn(
                  "rounded-full px-1.5 font-mono text-2xs tabular-nums",
                  o.attention ? "bg-accent text-accent-ink" : "bg-sunken text-ink-secondary",
                )}
              >
                {o.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
