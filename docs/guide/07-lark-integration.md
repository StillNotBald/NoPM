# Connect NoPM to Lark or Feishu

This guide is for the person who owns or administers a NoPM workspace and wants approvals to reach people where they already chat. It covers what the integration does, what it will never do, how to set it up (hosted, or self-hosted with no public address), and what to check when something does not arrive.

Two quick terms:

- **Lark** is the international chat-and-work platform. **Feishu** is the same product family for mainland China. They are separate platforms with separate accounts and separate developer consoles. An app made on one cannot be used on the other.
- A **self-built app** (also called a custom app) is a small app you create inside your own Lark or Feishu organization so NoPM can message people there. Nothing is published to a public store.

## What you get

| Moment | What happens |
|---|---|
| **Approval cards** | When someone raises a deletion request or a change request, each eligible approver who has linked their account gets a Lark direct message with the request details and **Approve** and **Reject** buttons. Reject asks for a reason. |
| **One decision, everywhere** | When the request is decided from any place (the NoPM console, the API, the CLI, an agent, or another card), every card already sent updates in place to show who decided, through which channel, and when. The buttons disappear. |
| **A card never goes stale silently** | A card shows the request as it was when it was sent. If a pending change request is edited afterwards, the old card is retired (it says the request changed and points to the new card) and approvers get a fresh card with the current content. Tapping the old card decides nothing. |
| **No card flood** | An approver is sent at most 20 approval cards an hour. Past that, instead of more cards they get one "N approvals are waiting" message with a link to the Approvals page, so a burst of requests cannot bury anyone in chat. |
| **Weekly digest** | Once a week NoPM posts a status summary (project health, milestones due soon, open high risks, pending approvals) to a group chat you choose. There is also a **Send now** button. |
| **Bot commands** | Message the bot directly: `help`, `link NPL-XXXX-XXXX` (connects your account) and `approvals` (lists what is waiting for you). |

Who counts as an eligible approver: a workspace admin or manager, with a linked Lark account, who is not the person who raised the request.

## The governance guarantees

The integration is built so that adding a chat channel cannot weaken the rules in [guide 03](03-how-governance-works.md).

1. **The decision is made in NoPM, not in Lark.** Lark only draws a card and passes a button click along. NoPM decides, using the same code path as the console, the API, the CLI and the agent tools.
2. **Four-eyes is enforced between people.** A click is mapped to a NoPM account you linked on purpose (see "Link your account"). The person who raised a request can never approve it, whichever channel they use, and a click from a Lark account that is not linked is refused. Only admins and managers can approve, on every channel, not only in chat.
3. **Buttons cannot be passed around.** Each card carries a single-use, expiring (7 days) token that is bound to one recipient and one request. Forward the card to a colleague and their click is refused. Click twice and the second click does nothing.
4. **Every decision is audited once, with its channel.** The audit row records `channel = lark`, which connector, the Lark event id and which Lark user clicked. Filter the Trust Center by channel `lark` to review them. Replays of the same click (a double tap, a Lark retry) return the stored result and write nothing new.
5. **The usual rules still apply at click time.** Role, scopes and project locks are checked when the button is pressed, not when the card was sent. If someone's role changed in between, the click is refused.
6. **You approve what you were shown.** Each card is tied to the version of the request it displayed. If the request was edited after the card was sent (a bigger cost, a different scope), a tap on that card is refused with a "this request changed" message and nothing is decided; the decision itself is also pinned to that version, so an edit that lands a split second after the tap cannot slip through either. A fresh card with the current content follows.
7. **Secrets stay secret.** The app secret and keys are encrypted at rest, never returned by any API, and never logged. The relay secret (self-host only) is stored only as a one-way hash. Single-use button tokens are stored hashed. In the audit trail, which every workspace member can read, the Lark app id, the group chat id and your Lark user and tenant ids appear abbreviated.
8. **The bot listens narrowly.** It reads only one-to-one direct messages sent to it, to recognise three commands. Group chat traffic and messages from other bots are ignored, and the text of a message is not stored.
9. **Chat is best-effort, the record is not.** If Lark is down or a card fails to send, the request and its audit row still exist and the Approvals page in NoPM works as always. A delivery that fails is retried (after 1 minute, 5 minutes, 30 minutes, 2 hours and 12 hours), then marked dead, without ever blocking or rolling back the governed change.
10. **The public addresses are signed and quiet.** In webhook mode every event is signed and encrypted with your Encrypt Key (required, see Step 1). A request that fails verification, and a request for a connector that does not exist, is paused or was revoked, all get the same bare "401 Invalid request", so nobody can use the addresses to find out which connectors exist. Repeated failures are rate-limited.

## Before you start

You need:

- A NoPM account with the **admin** role.
- Someone who can create and publish an app in your Lark or Feishu organization (usually a tenant admin). A self-built app has to be released and approved by a tenant admin before it can message anyone.
- A decision on two things, below.

### Lark or Feishu?

Create the app on the platform your people actually use. The two are not interchangeable, and the choice is stored on the connector as its **region**.

| | **Lark (international)** | **Feishu (China)** |
|---|---|---|
| Developer console | `open.larksuite.com/app` | `open.feishu.cn/app` |
| Typical use | Teams outside mainland China, including Southeast Asia | Teams whose Feishu tenant is in mainland China |
| Where the platform holds data | Singapore, per the vendor's published material | Beijing, per the vendor's published material |
| NoPM setting | Region: **Lark (international)** | Region: **Feishu (China)** |

Residency note: those locations come from public vendor material, and no Malaysia-specific region was found. If you have a data-residency requirement, confirm it with your Lark or Feishu admin before connecting.

### Webhook or long connection?

This is how Lark gets its events (messages and button clicks) to NoPM.

| | **Webhook** | **Long connection** |
|---|---|---|
| Lark reaches NoPM by | Calling a public HTTPS address on your NoPM | Not at all: a small worker you run opens an outbound WebSocket to Lark |
| NoPM must be reachable from the internet | Yes, over HTTPS | No. Works behind a firewall, on a laptop, on a private network |
| Extra process to run | None | One worker (`web/scripts/lark-worker.mjs`) |
| Choose it when | NoPM is hosted, or self-hosted behind a public domain | NoPM is self-hosted with no public address |
| Works for | Self-built apps (and later store apps) | Self-built apps only |

Both modes run the same approval code. The long-connection worker does not decide anything: it receives each event from Lark and forwards it to NoPM over a signed request, and NoPM does the rest.

## Step 1: Create the app in the Lark or Feishu developer console

1. Open the developer console for your platform (table above) and choose **Create custom app** (Feishu: create an enterprise self-built app).
2. Give it a name people will recognise in a chat, for example "NoPM approvals", and a short description and icon.
3. Open **Credentials and basic info** and keep the **App ID** (it starts with `cli_`) and **App Secret** to hand. You will paste both into NoPM. Treat the secret like a password.
4. Open **Events and callbacks**, then **Encryption strategy**. Keep the **Verification Token** to hand. For webhook mode you **must** also have an **Encrypt Key**: generate or copy one on that page and keep it. NoPM will not save a webhook connector without it (see Step 4). You will paste both into NoPM.

## Step 2: Turn on the bot

In the app's **Add features** (or **Features**) area, enable **Bot**. The bot is what sends cards and receives direct messages. Without it, nothing below works.

## Step 3: Add permissions

Open **Permissions and scopes** and add the scopes below. Names differ slightly between console versions, so match them by meaning and use the console's search box.

| What NoPM needs to do | Scope (as named in the console) |
|---|---|
| Send cards and replies as the bot | Send messages as an app: `im:message:send_as_bot` |
| Update a card after it was decided | Update messages sent by the app: `im:message:update` |
| Read direct messages sent to the bot (for `help`, `link`, `approvals`) | Read messages sent to the bot in direct chat: `im:message.p2p_msg:readonly` |

NoPM does not need access to your contacts, documents, calendars or group history, and the integration does not ask for them. Add only the three above. (The three scope keys are confirmed against the official documentation. Only the English display names the console shows for them are not, so match by the key if the wording differs.)

## Step 4: Connect the app in NoPM

1. In NoPM open **Integrations** (`/integrations`) and choose to connect Lark.
2. Fill in the form:
   - **Name**: anything, for example "Lark".
   - **Region**: Lark (international) or Feishu (China), to match where you made the app.
   - **How Lark reaches NoPM**: Webhook or Long connection (see above).
   - **App ID** and **App Secret** from Step 1.
   - **Verification Token** and **Encrypt Key**, from Step 1. **In webhook mode the Encrypt Key is required**: NoPM refuses to save the connector without it (the form marks the field required for a webhook connection). Webhook mode puts your addresses on the public internet, and the verification token alone is only a shared string that sits in clear text in every event and is visible to everyone who collaborates on the Lark app. With the key, NoPM verifies a signature on every call and decrypts the body, so a stranger who learns the token still cannot fake a message. In long-connection mode no public address exists and events arrive over the worker's own outbound connection, so the key is optional and not used for delivery.
3. Save, then choose **Test connection**. NoPM asks Lark for the bot's details with your App ID and secret, so a wrong secret or the wrong region shows up here.

The same rule holds when you edit the connector later: switching a connector to webhook mode, or replacing its credentials while it is in webhook mode, needs an Encrypt Key to be present afterwards, and you cannot clear the key from a webhook connector. Pausing, renaming or changing the digest never asks for it. The App ID itself cannot be changed on an existing connector (the accounts linked to it and the cards it already sent belong to that app): to move to a different Lark app, revoke the connector and create a new one. A connector created before this rule, without a key, keeps working until you next change its mode or credentials.
4. Keep the page open. Depending on the mode it now shows what to do next:
   - **Webhook**: two web addresses (events and card callbacks) to paste into the Lark console in Step 5.
   - **Long connection**: a **relay secret**, **shown only once**. Copy it now. It is stored only as a hash, so if you lose it you create a new connector.

Only one Lark connector can be active per workspace.

## Step 5: Tell Lark where to send events

Open **Events and callbacks** in the Lark developer console.

### Webhook mode

1. Set the subscription method for events to **send events to a developer server** (the wording varies) and paste the events address:

   ```
   https://<your-nopm-host>/api/integrations/lark/<connector-id>/events
   ```

   Lark immediately sends a verification request. It succeeds only if the address is reachable over HTTPS and the Verification Token you saved in NoPM matches the console.
2. Add the event **Message received** (`im.message.receive_v1`).
3. Open **Callback configuration**, choose to send callbacks to a developer server, and paste the card address:

   ```
   https://<your-nopm-host>/api/integrations/lark/<connector-id>/card
   ```

4. Add the callback **Card interaction** (`card.action.trigger`; in the Chinese console 卡片回传交互). This is what makes the Approve and Reject buttons work. Choose this NEW callback, not the older "消息卡片回传交互（旧）" (`card.action.trigger_v1`): NoPM does not handle the old one.

The connector id is shown in NoPM on the Integrations page after Step 4. Both addresses use it, which is why you create the connector in NoPM first. If Lark's verification request fails, check that the Verification Token and Encrypt Key in NoPM match the console exactly, then save again in the console. A connector that is paused or revoked answers Lark's hosted webhook exactly like a wrong signature (a bare 401), so a paused connector shows up here as a failed verification: resume it first. (The self-host relay worker authenticates first and then answers 403 `connector_inactive`.) When you resume a paused connector, approval cards for requests still pending are sent (once each), so nothing raised during the pause is missed.

### Long-connection mode

1. Set the subscription method for **events** to **receive events through persistent connection**. Add **Message received** (`im.message.receive_v1`).
2. Open **Callback configuration**, set the subscription method to **persistent connection** as well, and add **Card interaction** (`card.action.trigger`).
3. Run the worker (Step 6). The console usually refuses to save a long-connection setting until a client has connected at least once, so you may need to start the worker first, then come back and save.

> **Known open question, please read.** The official documentation (open.feishu.cn and open.larksuite.com, checked 2026-10-17) lists `card.action.trigger` as supported over the long connection for self-built apps. In the console it has its own subscription method, under Events and callbacks, Callback configuration, separate from Event configuration: choose the persistent connection there too. The Node SDK's README still says callbacks are not supported; that text is out of date. This has not yet been confirmed on a live tenant: test one approval end to end before telling your team the buttons work (the checklist is in [the first live test runbook](../runbooks/lark-first-live-test.md)). If your console does not offer the persistent-connection method for card callbacks, the buttons will not work in long-connection mode. In that case, approvals still arrive as cards, the card carries a link to the request in NoPM, and the decision can be made there; or use webhook mode with a public HTTPS address.

## Step 6 (long connection only): run the worker

The worker is one Node script. It needs Node 20 or newer, outbound internet access to Lark, and network access to your NoPM. It listens for nothing, so no port has to be opened.

**Run exactly one worker per Lark app.** Lark delivers each event to one randomly chosen connected client. Two workers would each receive roughly half of the clicks, and a click that lands on a stopped or misconfigured copy is lost. The script refuses to start a second copy on the same machine, but it cannot see other machines. Do not run it on a serverless platform, in a cluster mode, or with more than one replica.

### Settings

| Variable | Required | Value |
|---|---|---|
| `LARK_APP_ID` | yes | The `cli_...` App ID from Step 1 |
| `LARK_APP_SECRET` | yes | The App Secret from Step 1 |
| `LARK_REGION` | yes | `lark` or `feishu`, matching the connector |
| `NOPM_APP_URL` | yes | Where the worker reaches NoPM, for example `https://nopm.example.com` or `http://localhost:3000` |
| `NOPM_LARK_CONNECTOR_ID` | yes | Shown on the Integrations page |
| `NOPM_LARK_RELAY_SECRET` | yes | Shown once in Step 4 |
| `LARK_LOG_LEVEL` | no | `error`, `warn` (default) or `info`. Debug is refused on purpose: the SDK's debug output contains message bodies |
| `NOPM_LARK_RELAY_TIMEOUT_MS` | no | 500 to 2800, default 2500. Lark allows 3 seconds in total for a button click |
| `NOPM_LARK_ALLOW_MULTI` | no | `1` skips the same-machine duplicate check. Leave unset |

Put the secrets in a file that only the service user can read, never on a command line (command lines show up in process lists).

### One setting on the NoPM side: `NOPM_TRUSTED_PROXY_HOPS`

The relay endpoint rate-limits unauthenticated callers by their network address before it checks the signature. A self-hosted NoPM cannot see the socket address, and the `X-Forwarded-For` header is written by whoever sends the request, so **by default NoPM trusts no address at all** and skips that per-address cap (the signature check and the per-connector cap still protect the endpoint). If you run NoPM behind your own reverse proxy (nginx, Caddy, a load balancer), set this on the NoPM app (not the worker) to the number of proxies in front of it, for example:

```
NOPM_TRUSTED_PROXY_HOPS=1
```

NoPM then reads the client address from the right-hand end of `X-Forwarded-For`, which only your own proxies write, and uses it for the relay's per-address cap, the invite-accept limiter, the calendar feed's per-address cap and the failed-verification cap on the public webhook addresses. Set it to the real number: too high and a caller can pick its own address, too low and every request looks like it comes from your proxy. Leave it unset if NoPM is exposed directly, or if the worker and NoPM talk over a private network with no proxy. On Vercel nothing needs setting: the platform supplies the address. If the worker and NoPM sit on the same machine, point `NOPM_APP_URL` at `http://localhost:3000` and ignore this.

### Run it by hand first

From the `web/` folder of your NoPM checkout (after `npm install`, which brings in the one dependency the worker needs):

```bash
set -a; . /etc/nopm/lark-worker.env; set +a
node scripts/lark-worker.mjs          # same as: npm run lark:worker
```

On start it checks everything it can before opening the socket: your settings, a signed test call to NoPM (which catches a wrong connector id, a wrong secret, a connector that is paused or still in webhook mode, and a clock that is off by more than five minutes), then it connects to Lark. A healthy start looks like:

```
... info starting region=lark app=cli_... connector=... relay=https://nopm.example.com
... warn single instance only: Lark delivers each event to ONE random connected client. ...
... info relay check ok connector=...
... info connected to Lark region=lark
```

The worker never writes secrets, message text or button tokens to its log. It records only event types, status codes and timings.

| Exit code | Meaning | Should a supervisor restart it? |
|---|---|---|
| `0` | Clean shutdown (Ctrl+C or SIGTERM). In-flight requests are given 5 seconds to finish | no |
| `1` | A runtime failure, such as the connection to Lark giving up after retries, or NoPM staying unreachable at start | yes, with a delay |
| `2` | A configuration or credential error: a missing variable, a connector that is in the wrong mode, or Lark refusing the App ID, secret or region. The message says what to change | no, fix it first |
| `3` | Another worker for this connector is already running on this machine | no |

### Keep it running: systemd

```ini
# /etc/systemd/system/nopm-lark-worker.service
[Unit]
Description=NoPM Lark long-connection worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=nopm
WorkingDirectory=/opt/nopm/web
EnvironmentFile=/etc/nopm/lark-worker.env      # chmod 600, owned by root
ExecStart=/usr/bin/node scripts/lark-worker.mjs
Restart=on-failure
RestartSec=10
RestartPreventExitStatus=2 3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now nopm-lark-worker
journalctl -u nopm-lark-worker -f
```

### Keep it running: pm2

```bash
set -a; . /etc/nopm/lark-worker.env; set +a
cd /opt/nopm/web
pm2 start scripts/lark-worker.mjs --name nopm-lark-worker --instances 1 --exp-backoff-restart-delay 1000
```

Never use `-i max` or cluster mode: that is several workers. pm2 restarts on every exit code, including `2` and `3`, so after a configuration change read `pm2 logs nopm-lark-worker` instead of assuming it is up. pm2 also keeps the environment it was started with in its saved process list (`pm2 save`), which means the secrets end up in a file in the pm2 home folder. Prefer systemd above if that matters to you.

### Keep it running: Docker

The worker is a single file plus one pinned dependency, so its image is tiny. Save this next to your NoPM checkout as `lark-worker.Dockerfile`:

```dockerfile
FROM node:20-alpine
WORKDIR /app
RUN npm install --no-save --no-package-lock @larksuiteoapi/node-sdk@1.74.0
COPY web/scripts/lark-worker.mjs ./lark-worker.mjs
USER node
CMD ["node", "lark-worker.mjs"]
```

Add it to your `docker-compose.yml` next to the `web` service:

```yaml
  lark-worker:
    build:
      context: .
      dockerfile: lark-worker.Dockerfile
    env_file: web/.env.lark-worker       # the six variables above, NOT committed
    environment:
      NOPM_APP_URL: http://web:3000      # the compose service name; plain http is fine on a private network
    depends_on: [web]
    restart: on-failure
    deploy:
      replicas: 1
```

Docker cannot tell a config error from a crash, so a bad setting restart-loops (with Docker's own back-off). Read `docker compose logs lark-worker`: the message names the problem.

### Network allow-list

The worker needs outbound HTTPS and WebSocket access to your platform's open-platform domain (`open.larksuite.com` for Lark, `open.feishu.cn` for Feishu) and the message-gateway hosts it hands out. If your network filters by domain, allow the whole `larksuite.com` (or `feishu.cn`) family; the exact gateway host names are issued by the platform at connect time and have not been listed here. A corporate HTTP proxy is not supported by the worker in this version.

## Step 7: Publish the app

Back in the developer console:

1. Open **Version management and release**, create a version, and submit it. A tenant admin approves it.
2. Set the **availability scope** to include everyone who should receive approval cards or talk to the bot. People outside the scope cannot be messaged.
3. After release, search for the app's name in Lark, open the chat with the bot, and send `help`. A help card means events are flowing. No reply means go to the troubleshooting table.

Changes to permissions, events or callbacks need a new version to take effect.

## Step 8: Link your account

Cards only reach, and clicks only count for, people who have proven which Lark account is theirs. Every approver does this once.

1. In NoPM, on the **Integrations** page, choose **Link my Lark account**. NoPM shows a one-time code that looks like `NPL-XXXX-XXXX`. It works once and expires after 10 minutes.
2. In Lark, send that to the bot as a direct message: `link NPL-XXXX-XXXX`.
3. The bot replies with a confirmation card. The page now shows you as linked.

Why a code and not an email match: an email address says nothing about who controls the chat account. The code proves that the person signed in to NoPM is the same person who can message the bot, and the platform supplies the sender identity itself, not the message text.

You can unlink at any time from the same page. An admin can see and remove every link in the workspace. Linking grants nothing by itself: what a person may approve still follows their NoPM role and scopes. Revoking the connector also revokes every link on it.

Three safeguards you may notice:

- **A code never moves an existing link.** Each person has one active Lark link per connector. If a code is sent from a different Lark account while you are already linked, the bot refuses: "This NoPM account is already linked to another Lark account. Unlink it in NoPM (Integrations) first, then send a new code." The code is spent, the refusal is recorded in the audit trail (`integration.identity.link.blocked`), and your link is untouched, so a leaked or phished code cannot re-point your approvals. To move to a new Lark account, unlink the old one under Integrations, then create a new code and send it from the new account. (If two codes race and a link does get replaced, you still get an in-app notification, "Your Lark account link was changed", and the account that lost the link gets a direct message.)
- **Which Lark organization is trusted is decided by an admin or manager.** The first link made by a workspace **admin or manager** pins the connector to that Lark tenant; after that, codes from any other tenant are refused. A link by anyone else (a member or viewer) never pins the connector, so someone with no approval rights cannot lock your real organization out by linking from a different one. A link from a different tenant than the pinned one is refused for everybody. To move the connector to another tenant, an admin clears the tenant pin on the connector, and the next admin or manager link pins the new one.
- **Guessing is throttled.** A link code is short-lived and single use, and `link` attempts are limited to 8 per Lark account and 120 per connector in any 10 minutes. Past that the bot asks the person to wait a few minutes and send the newest code.

## Using it

### Approving from a card

A card shows the request title, the project, who raised it, a short summary, a link to open it in NoPM, and the two buttons. **Approve** decides at once. **Reject** opens a small form that requires a reason, which is recorded on the request.

After you tap, the card shows the result straight away with a confirmation message, and every other copy of that card is updated. Cards for an edited request carry the version they displayed (see "You approve what you were shown" above), so an old card can never approve new content.

What you can see when a tap does not go through:

| Message | Why | What to do |
|---|---|---|
| Account not linked | This Lark account is not linked to a NoPM user | Do Step 8 |
| Expired | The card is more than 7 days old | Open the request in NoPM |
| Not the recipient | The card was forwarded, or belongs to another person | Ask for your own card, or use NoPM |
| Already decided | Someone decided it elsewhere first | Nothing: the card shows the outcome |
| This request changed | The request was edited after the card was sent (for example a change request's cost). Nothing was decided | Open the new card that follows, or open the request in NoPM and review it as it stands now |
| You raised this request | Four-eyes: the requester cannot approve | Ask another admin or manager |
| Not allowed | Your role or scopes no longer permit the decision, or the project is locked | Check with a workspace admin |

Every one of these leaves the request exactly as it was. The wording on screen may differ slightly from the table.

### The weekly digest

1. Add the bot to the group chat that should receive it, and make sure the group is inside the app's availability scope. On Lark, add the bot from the desktop client (Group settings, then Group bots, then Add bot, and search for the app's name); it cannot be added from the mobile client.
2. You need the group's **chat id**, which starts with `oc_`. The Lark client does not show it. The simplest way is the developer console's API debugger: call the "get the chats the bot is in" request (`GET /open-apis/im/v1/chats`) with your app and copy the group's `chat_id`. That request may need an extra read scope, which you can add temporarily.
3. In NoPM, on the Integrations page, turn on the digest, paste the chat id, and choose a weekday.
4. **Send now** posts it immediately, which is the easiest way to check the setup.

The digest and the retry of failed deliveries are driven by a once-a-day scheduled call (`GET /api/integrations/cron`, protected by a secret). The weekday is evaluated in UTC. If a scheduled call misses that day, the next call later in the same ISO week (Monday to Sunday) posts the digest, unless the connector's settings were changed after that day began: switching the digest on or rescheduling it midweek never fires it at once. On Vercel, including the deploy-button install, the daily call comes from the project's `vercel.json`; set a `CRON_SECRET` value in the project's environment and Vercel sends it for you. Anywhere else, set `CRON_SECRET` in the app's environment and schedule the call yourself, for example:

```cron
# every day at 01:07 UTC (avoid the exact hour and half hour: the platform sheds load then)
7 1 * * *  curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://nopm.example.com/api/integrations/cron
```

A failed delivery is retried on a ladder: after 1 minute, 5 minutes, 30 minutes, 2 hours and 12 hours, and then it is marked dead. The retries advance **whenever your workspace has approval activity** (each new request or decision also drains up to ten of the retries that are due), and the daily scheduled call is the floor underneath. On a busy workspace the retries therefore follow the ladder; on a quiet one nothing triggers them between daily calls, so each attempt may wait for the next call (about a day). The scheduled call is built to finish inside the host's 60-second limit: it queues every digest first, drains connectors a few at a time, stops starting new work at 40 seconds, and leaves anything unfinished queued for the next call. It also deletes old bookkeeping rows (delivery rows 60 days after they finish, spent button tokens two weeks after expiry, and old click records after 90 days). The audit trail is never pruned.

Without this scheduled call, approval cards still go out immediately and retries still advance whenever there is activity, but the weekly digest never sends on its own, nothing is pruned, and on a quiet workspace a delivery that failed once may wait for the next approval request before it is retried. **Send now** still works.

An admin can see how this is going without opening a database. The connector card on the Integrations page shows a health line (Healthy, Retrying, Failing or Idle) with the number of deliveries queued, retrying and failed, when the last message went out, and the last failure's reason. "Failed" is the number to watch: a dead delivery is a card that never reached anyone. The same figures, plus when the scheduler last ran and what it did (`last_cron_at`, `last_cron`), are in the `health` block of the connector in `GET /api/integrations/connectors` (admin only). If the last scheduler run is old or empty, the daily call is not reaching `/api/integrations/cron` (check `CRON_SECRET`).

## If something does not arrive

| What you see | Likely cause | What to do |
|---|---|---|
| Console says "request URL verification failed" (webhook) | The address is not reachable over HTTPS from the internet, the connector id in the URL is wrong, the connector is paused or revoked, or the Verification Token or Encrypt Key differs | Open the events address in a browser from outside your network (a 405 or 401 is fine, a timeout is not). Check the connector is active, then re-copy the token and key into NoPM. A paused, revoked or unknown connector all answer with the same bare 401 on purpose |
| NoPM will not save a webhook connector and mentions `encrypt_key` | Webhook mode requires an Encrypt Key | Copy the Encrypt Key from the Lark app's Events and callbacks page into NoPM, or choose Long connection if NoPM has no public address |
| A card says "This request changed" or the tap answers "this request changed after the card was sent" | The request was edited after that card went out. Nothing was decided | Use the new card that follows, or open the request in NoPM |
| An approver stopped getting cards and instead gets "N approvals are waiting" | They reached the limit of 20 approval cards an hour | Decide them in NoPM; the cards resume the next hour |
| Self-hosted: the relay answers 429 to everything, or the per-address limit never seems to apply | `NOPM_TRUSTED_PROXY_HOPS` is wrong for your proxy layout | See "One setting on the NoPM side" in Step 6. Unset means no per-address cap at all |
| The bot does not answer `help` | App not released, you are outside the availability scope, `im.message.receive_v1` not subscribed, the read-DM scope missing, or (long connection) the worker is not running | Check each in that order. After any permission or event change, publish a new version |
| A button shows a Lark error code instead of a result | The `card.action.trigger` callback is not configured, or NoPM did not answer within 3 seconds | Add the callback and publish. In long-connection mode, check the worker log for a slow or failed relay |
| Tapping Approve says "account not linked" | You skipped Step 8, or the link was removed | Link again |
| A tap shows a Lark client error code, for example 200340, 200341, 200671, 200672, 200673, 200830 or 200530 | These come from Lark, not from NoPM: **200340** the callback address is not configured or invalid (on a long connection, the click never reached the handler); **200341** no answer within 3 seconds; **200671** a non-200 status came back; **200672** the response body was malformed; **200673** the returned card was invalid; **200830** a 2.0 card was replaced by a 1.0 card; **200530** a form component has an empty name | 200340: re-check the callback configuration and, for a long connection, that the worker is running. 200341: look at how long NoPM and the relay took. The others: report them, with the code, to whoever maintains the integration |
| No card ever arrives | You are not linked, you raised the request yourself, your role is not admin or manager, the connector is paused, or you are outside the availability scope | Check the Integrations page for the connector's status and the delivery list, then each item |
| Cards arrive, but some buttons seem to do nothing | More than one worker is running, so some clicks go to the wrong one | Stop every worker, start exactly one |
| Worker exits with code `2` | A setting is missing or wrong, or Lark refused the credentials | Read the message: it names the variable or the NoPM setting. If it says Lark rejected the credentials, check the App ID, secret and region together |
| Worker says the relay signature was rejected | `NOPM_LARK_RELAY_SECRET` is wrong, or the machine clock is more than 5 minutes off | Fix the clock (NTP). If the secret was lost, revoke the connector and create a new one |
| Worker says the connector is not in long-connection mode, or has no relay secret | The connector was created for webhook mode | Create a connector in Long connection mode |
| Worker says the connector is paused or revoked | Status changed in NoPM | Resume it, or create a new one |
| Worker exits with code `3` | A worker for this connector is already running on this machine | Stop the other one. If it is a stale lock after a crash, delete the lock file named in the message |
| The digest never sends | Digest off, wrong chat id, the bot is not in the group, or (self-host) no scheduled call | Use **Send now**; if it works, schedule the call |
| Events stop after a Lark outage | The worker reconnects on its own | Watch the log for `reconnected`; if it gave up it exits with code `1` and your supervisor restarts it |

Where to look: the Integrations page (connector status, deliveries and their last error), the Trust Center filtered by channel `lark` (every decision and link), and the worker's own log.

## What is not in this version

- **Sign in with Lark.** You still sign in to NoPM as before. Lark is only a notification and approval channel.
- **Link previews.** Pasting a NoPM address into a chat does not expand into a card.
- **Writing to Lark Calendar.** Milestone dates are available as a calendar subscription instead (a read-only feed any calendar app, including Lark Calendar, can subscribe to).
- **Mirroring requests into the Lark Approval inbox.** The decision always lives in NoPM; there is no second approval record inside Lark.
- **Group-chat approval cards.** Approval cards are direct messages to each eligible person.
- **Richer bot commands.** Only `help`, `link` and `approvals`.
- **Store listing.** Each organization creates its own self-built app. A shared, store-listed app (which must use webhooks) is later work.
- **Mapping people by email, or syncing the contact directory.** Linking is by one-time code only.

## For developers: the relay protocol

The worker talks to NoPM with one signed request per event. This is the whole contract, in case you want to write your own relay.

```
POST {NOPM_APP_URL}/api/integrations/lark/{connectorId}/relay
X-NoPM-Relay-Timestamp: <unix seconds>
X-NoPM-Relay-Signature: v1=<hex(HMAC-SHA256(key, timestamp + "." + rawBody))>
{ "type": "event" | "card" | "ping", "payload": <the Lark v2 event envelope> }
```

- `key` is the lowercase hex SHA-256 of the raw relay secret, which is exactly what NoPM stores as the connector's relay secret hash. The worker derives it from the secret it was given; NoPM never needs the raw secret again.
- The timestamp must be within five minutes of NoPM's clock. The signature covers the exact bytes of the body.
- A `card` response is passed back to Lark unchanged as the callback response (a toast and a replacement card). A `ping` verifies URL, connector id, secret and mode without changing anything.
- Errors use NoPM's usual `{ "error", "code" }` shape: 401 (`invalid_relay_signature`, `stale_relay_timestamp`, `no_relay_secret`), 403 (`connector_inactive`, `wrong_mode`; only ever shown to a caller whose signature was valid), 404 (`connector_not_found`; a malformed connector id only), 413, 422, 429, 503 (`connector_unavailable`; the connector's stored secrets cannot be decrypted, an operator fault). A connector id that does not exist gets the same `401 invalid_relay_signature` as a wrong signature, after the same work, so the endpoint does not reveal which connectors exist.
- Before the signature is checked, callers are rate-limited per network address (120 a minute) using the address your own proxy appended to `X-Forwarded-For`, never the caller's own first entry. Set `NOPM_TRUSTED_PROXY_HOPS` for that (Step 6); with it unset the per-address cap is skipped and the signature plus the per-connector cap (600 a minute) are the guards. A rate-limited card click is answered with a normal 200 toast, not an error.
- A replayed request is harmless: decisions are idempotent on the Lark event id, and button tokens and link codes are single use.

The signing code is in `web/src/lib/integrations/lark/relay.ts` (server) and `web/scripts/lark-worker.mjs` (worker), kept byte-identical by a test.
