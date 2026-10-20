import { notFound } from "next/navigation";

/**
 * Target of the proxy's rewrite for a console page whose module is switched off
 * (NOPM_MODULES, ADR 0019). Renders the console 404 inside the shell.
 */
export default function ModuleDisabledPage() {
  notFound();
}
