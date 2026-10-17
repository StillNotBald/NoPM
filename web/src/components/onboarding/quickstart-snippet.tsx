"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Quickstart snippet (R-78, /start) — a read-only, tabbed (CLI / curl) code
 * block showing the 3 commands that create a project, create a task, and
 * list audit rows. No network calls of its own.
 *
 * Commands verified against:
 *   - cli/README.md ("Projects" / "Tasks" / "Audit log & discovery" sections)
 *   - cli/commands/projects.mjs, cli/commands/tasks.mjs, cli/commands/audit.mjs
 *   - web/src/app/api/projects/_schema.ts (createProjectSchema: code, name)
 *   - web/src/app/api/tasks/_schema.ts (TaskCreateSchema: name required)
 *   - web/src/app/api/projects/[id]/tasks/route.ts (POST path)
 *   - web/src/app/api/audit/route.ts (GET, ?limit=)
 */

const CLI_LINES = [
  'nopm projects create --name "Website relaunch" --code WEB-01',
  'nopm tasks create --project <projectId> --name "Cutover dry-run"',
  "nopm audit --limit 5",
];

const CURL_LINES = [
  `curl -X POST https://stillnotbald.com/api/projects \\
  -H "Authorization: Bearer $NOPM_TOKEN" -H "Content-Type: application/json" \\
  -d '{"name":"Website relaunch","code":"WEB-01"}'`,
  `curl -X POST https://stillnotbald.com/api/projects/<projectId>/tasks \\
  -H "Authorization: Bearer $NOPM_TOKEN" -H "Content-Type: application/json" \\
  -d '{"name":"Cutover dry-run"}'`,
  `curl "https://stillnotbald.com/api/audit?limit=5" \\
  -H "Authorization: Bearer $NOPM_TOKEN"`,
];

type Tab = "cli" | "curl";

export function QuickstartSnippet() {
  const [tab, setTab] = useState<Tab>("cli");
  const [copied, setCopied] = useState(false);

  const lines = tab === "cli" ? CLI_LINES : CURL_LINES;
  const text = lines.join("\n\n");

  function handleCopy() {
    if (!navigator?.clipboard) return;
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        // clipboard permission denied / unavailable — fail silently, the text is still selectable
      });
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border-subtle bg-canvas">
      <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2">
        <div className="flex items-center gap-1">
          <TabButton active={tab === "cli"} onClick={() => setTab("cli")}>
            CLI
          </TabButton>
          <TabButton active={tab === "curl"} onClick={() => setTab("curl")}>
            curl
          </TabButton>
        </div>
        <button
          type="button"
          onClick={handleCopy}
          className="flex h-11 items-center gap-1.5 rounded-md px-2 text-xs text-ink-muted hover:bg-sunken hover:text-ink sm:h-7"
        >
          {copied ? <Check size={12} className="text-success-ink" /> : <Copy size={12} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto px-4 py-3 font-mono text-xs leading-relaxed text-ink-secondary">
        {lines.map((line, i) => (
          <div key={i} className={i > 0 ? "mt-3" : undefined}>
            {line}
          </div>
        ))}
      </pre>
      <p className="border-t border-border-subtle px-4 py-2 text-[11px] text-ink-muted">
        Mint a token on the Tokens page first — the agent preset scopes are enough.
      </p>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-11 items-center rounded-md px-2.5 text-xs font-medium transition-colors sm:h-7",
        active ? "bg-accent/10 text-accent" : "text-ink-muted hover:bg-sunken hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}
