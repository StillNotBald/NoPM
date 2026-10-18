import Link from "next/link";
import { Disclosure } from "./shared";

/**
 * "How approvals from chat stay governed" — collapsed by default (governance
 * is invisible in the flow, explained on request). A plain server-renderable
 * component; the disclosure is a native <details>.
 */
export function GovernanceNote() {
  return (
    <Disclosure summary="How approvals from chat stay governed">
      <ul className="list-disc space-y-2 pl-5 text-sm text-ink-secondary">
        <li>
          <span className="font-medium text-ink">A different person decides.</span> The approver must not be the
          person who raised the request, including requests raised by an agent token that person created.
        </li>
        <li>
          <span className="font-medium text-ink">Every button is personal and single-use.</span> It works only for
          the member it was sent to, once, and stops working after 7 days or once the request is decided anywhere.
        </li>
        <li>
          <span className="font-medium text-ink">One decision, one record.</span> It is written once to the{" "}
          <Link href="/trust" className="focus-ring rounded-sm text-accent hover:underline">
            Trust Center
          </Link>{" "}
          with channel &ldquo;lark&rdquo;, the same as a decision made in NoPM, the CLI or an agent.
        </li>
      </ul>
    </Disclosure>
  );
}
