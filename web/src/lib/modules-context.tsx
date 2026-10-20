"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { MODULES, filterScopes, type ModuleSet } from "@/lib/modules";
import { ALL_NAV_ITEMS, NAV_SECTIONS, type NavItem, type NavSection } from "@/lib/nav/nav-config";
import { SCOPES, agentPresetScopes, scopeChoices, type Scope } from "@/lib/auth/scopes";

/**
 * Hands the server-resolved module switch (NOPM_MODULES, ADR 0019) to client
 * components. The env var is not readable in the browser, so the console layout
 * reads it once and passes the DISABLED ids here. Without a provider nothing is
 * disabled, so existing renders and tests are unchanged.
 */
const DisabledCtx = createContext<readonly string[]>([]);

export function ModulesProvider({ disabled, children }: { disabled: readonly string[]; children?: ReactNode }) {
  return <DisabledCtx.Provider value={disabled}>{children}</DisabledCtx.Provider>;
}

function useEnabledSet(): ModuleSet {
  const disabled = useContext(DisabledCtx);
  return useMemo(() => new Set(MODULES.map((m) => m.id).filter((id) => !disabled.includes(id))), [disabled]);
}

export function useIsModuleEnabled(id: string): boolean {
  return useEnabledSet().has(id);
}

function hiddenHrefs(enabled: ModuleSet): Set<string> {
  return new Set(MODULES.filter((m) => !enabled.has(m.id)).flatMap((m) => [...m.navHrefs]));
}

/** NAV_SECTIONS minus disabled modules; empty sections are dropped. */
export function useNavSections(): NavSection[] {
  const enabled = useEnabledSet();
  return useMemo(() => {
    const hidden = hiddenHrefs(enabled);
    if (hidden.size === 0) return NAV_SECTIONS;
    return NAV_SECTIONS.map((s) => ({ ...s, items: s.items.filter((i) => !hidden.has(i.href)) })).filter(
      (s) => s.items.length > 0,
    );
  }, [enabled]);
}

export function useAllNavItems(): NavItem[] {
  const enabled = useEnabledSet();
  return useMemo(() => {
    const hidden = hiddenHrefs(enabled);
    return hidden.size === 0 ? ALL_NAV_ITEMS : ALL_NAV_ITEMS.filter((i) => !hidden.has(i.href));
  }, [enabled]);
}

/** Scope checkboxes and agent preset for the token page, minus disabled modules. */
export function useScopeLists(): { choices: string[]; agentPreset: readonly Scope[] } {
  const enabled = useEnabledSet();
  return useMemo(() => {
    const active = filterScopes(SCOPES, enabled);
    return { choices: scopeChoices(active), agentPreset: agentPresetScopes(active) };
  }, [enabled]);
}
