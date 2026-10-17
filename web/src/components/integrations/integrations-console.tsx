"use client";

import { fetchConnector, fetchIdentities, fetchMe } from "./api";
import { CalendarFeedsCard } from "./calendar-feeds-card";
import { GovernanceNote } from "./governance-note";
import { useApiResource, type ResourceState } from "./hooks";
import { LarkAccountCard } from "./lark-account-card";
import { LarkConnectorCard } from "./lark-connector-card";
import type { IdentityView } from "./model";

/**
 * The Integrations page body. Owns the three reads the cards share — who I am
 * (role), the workspace's Lark connector, and the Lark links — so the cards
 * stay consistent (the account card knows whether a connector exists; the
 * connector card shows how many members have linked) and a change in one
 * refreshes the others.
 *
 * Governance and secrets live in the API; this page only renders state and
 * relays the admin's and member's explicit actions.
 */
export function IntegrationsConsole() {
  const me = useApiResource(fetchMe);
  const connector = useApiResource(fetchConnector);
  const identities = useApiResource(fetchIdentities);

  // undefined while /api/me is loading (so the calendar card doesn't guess); null if it failed or has no role.
  const role = me.state.status === "loading" ? undefined : me.state.status === "ready" ? me.state.data.role : null;
  const myId = me.state.status === "ready" ? me.state.data.id : null;
  // A failed /api/me degrades to the read-only view rather than a card stuck loading.
  const isAdmin = me.state.status === "loading" ? null : me.state.status === "ready" ? role === "admin" : false;

  const activeLinks =
    identities.state.status === "ready" ? identities.state.data.filter((i: IdentityView) => !i.revoked).length : null;

  // The identities read is "mine" for members; hold it back until /api/me
  // resolves so "is this link mine?" is never answered with an unknown id.
  const accountIdentities: ResourceState<IdentityView[]> =
    me.state.status === "loading" ? { status: "loading" } : identities.state;

  const refreshLinks = identities.reload;
  const refreshConnector = connector.reload;

  // Two columns once the page itself is wide enough (a container query, so a collapsed or open
  // sidebar both work): the Lark cards on the left, the calendar feed (the one integration every
  // role can use with no setup) beside them, on screen instead of below the fold. One column
  // otherwise, in reading order. The governance note spans both.
  return (
    <div className="@container">
    <div className="grid grid-cols-1 items-start gap-6 @4xl:grid-cols-2">
      <div className="min-w-0 space-y-6">
        <LarkConnectorCard
          isAdmin={isAdmin}
          resource={connector.state}
          // Only admins receive the workspace-wide list, so only they get a meaningful total.
          linkedTotal={isAdmin ? activeLinks : null}
          onRetry={connector.retry}
          onChanged={() => {
            refreshConnector();
            refreshLinks();
          }}
        />

        <LarkAccountCard
          isAdmin={isAdmin === true}
          myProfileId={myId}
          connector={connector.state.status === "ready" ? connector.state.data : null}
          connectorKnown={connector.state.status === "ready"}
          identities={accountIdentities}
          onRetry={identities.retry}
          onReload={refreshLinks}
        />
      </div>

      <div className="min-w-0">
        <CalendarFeedsCard role={role} />
      </div>

      <div className="min-w-0 @4xl:col-span-2">
        <GovernanceNote />
      </div>
    </div>
    </div>
  );
}
