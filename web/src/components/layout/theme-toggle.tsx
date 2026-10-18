"use client";

import { useEffect, useState } from "react";
import { Sun, Moon } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { readAppearanceCookie, buildAppearanceCookieHeader } from "@/lib/theme/appearance";

/**
 * Light/dark toggle. Default is light. This is now a SHORTCUT onto the
 * appearance cookie (L-37) — it flips only the `mode` field, preserving
 * whatever fontScale/density/dateDisplay the settings page has already
 * set, and writes the SAME `nopm_appearance` cookie the settings page
 * writes. The old bare `theme` cookie is still read once, client-side, as
 * a fallback for sessions that toggled before this change and haven't hit
 * layout.tsx's server-side legacy fallback path since.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    // `.dark` covers explicit dark mode. `.theme-system` + a live OS check
    // covers system mode currently resolving dark (system dark has no
    // `.dark` class — it's a prefers-color-scheme media query — so reading
    // the class alone would under-report).
    const html = document.documentElement;
    const systemDark =
      html.classList.contains("theme-system") &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDark(html.classList.contains("dark") || systemDark);
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.remove("theme-system");
    document.documentElement.classList.toggle("dark", next);
    // Preserve the visitor's other appearance choices (fontScale/density/
    // dateDisplay) — only `mode` changes here.
    const prefs = readAppearanceCookie(document.cookie);
    document.cookie = buildAppearanceCookieHeader({
      ...prefs,
      mode: next ? "dark" : "light",
    });
  };

  return (
    <IconButton
      onClick={toggle}
      label={dark ? "Switch to light theme" : "Switch to dark theme"}
      className={className}
    >
      {dark ? <Sun size={18} /> : <Moon size={18} />}
    </IconButton>
  );
}
