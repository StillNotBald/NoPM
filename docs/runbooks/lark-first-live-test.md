# Lark first live-tenant test

**Status: DRAFT.** This has not been run against a real Lark or Feishu tenant yet. The adapter is proven against the pinned SDK source, the official docs (checked 2026-10-17) and a local fake Lark server, but not a live organisation. Change the status to **ACTIVE** after the first successful run, once it has a `testing-log/` entry.

The full setup reference is [`docs/guide/07-lark-integration.md`](../guide/07-lark-integration.md). This file is the step-by-step script for the first end-to-end run. Its job is to settle the questions only a real tenant can answer (listed at the end).

**Label key.** Menu labels marked *EN* are quoted from an English Lark page. Labels marked *tr* are translations of a Chinese-only official page, so the console may word them differently. If your console is in Chinese, match by position or by the Chinese text shown.

**Recommended first run.** Use long connection, with NoPM and the worker both on your own machine. It needs no public address and avoids the webhook signature questions. Test webhook mode second.

## 0. Prepare

- Use a real Lark organisation where you are a tenant admin, so you can approve your own app version. A personal-edition account won't do.
- Create two NoPM users in one workspace, both admin or manager. One raises a request and the other approves it, because a requester can never approve their own request.
- Use the console that matches your NoPM connector's region:
  - Lark: https://open.larksuite.com/app
  - Feishu: https://open.feishu.cn/app

## 1. Create the app (*EN*: "Create Custom App")

1. Choose **Create Custom App**, enter a name (for example "NoPM approvals"), a description and an icon, then click **Create**.
2. Open **Basic Info > Credentials & Basic Info** (*EN*).
3. Copy the **App ID** (`cli_` followed by 16 hex characters) and the **App Secret**.

## 2. Turn on the bot (*EN*: Features > "Add Features" > Bot > Add)

Without the Bot capability, sending fails with `230006` and NoPM's **Test connection** fails.

## 3. Add scopes (*tr*: "Permissions & Scopes"; search by scope key)

| Scope | Why |
|---|---|
| `im:message:send_as_bot` | Send approval cards and digests as the bot, and patch them afterwards |
| `im:message.p2p_msg:readonly` | Read direct messages sent to the bot (`help`, `link`, `approvals`) |
| `im:message:update` | Optional; `send_as_bot` already allows patching a card |
| `im:chat:readonly` | Temporary, and only for looking up the digest chat id in step 10 |

Do not add contact, group-message or document scopes. NoPM never uses them.

## 4. Events & Callbacks (*EN*; 事件与回调)

1. On the **Encryption Strategy** tab (*tr*, 加密策略), copy the **Verification Token**.
2. Generate or copy an **Encrypt Key**. It is required for webhook mode and recommended for long connection.
3. Don't save the subscription methods yet. The console won't save a long-connection method until a client is online (step 6a).

## 5. Connect the app in NoPM

Go to `/integrations` and choose **Connect**. Fill in:

| Field | Value |
|---|---|
| Region | Lark (international) or Feishu (China), matching step 1 |
| How Lark reaches NoPM | Long connection (first run) or Webhook |
| App ID and App Secret | From step 1 |
| Verification Token | From step 4. The form asks for it in both modes. |
| Encrypt Key | From step 4. Required for webhook mode. |
| What to turn on | Approvals on, Digest off for now |

Then press **Test connection**. A wrong secret or the wrong region fails here; success shows the bot's name.
- **Long connection:** copy the relay secret now, because it is shown only once. Also copy the connector id.
- **Webhook:** copy the two addresses, events and card. Both contain the connector id.

## 6a. Long connection: start the worker, then switch the console

1. In `web/`, set these environment variables, then run `node scripts/lark-worker.mjs`:
   - `LARK_APP_ID` and `LARK_APP_SECRET`
   - `LARK_REGION` (`lark` or `feishu`)
   - `NOPM_APP_URL` (for example `http://localhost:3000`)
   - `NOPM_LARK_CONNECTOR_ID` and `NOPM_LARK_RELAY_SECRET`
   - `LARK_LOG_LEVEL=info`

   You should see `relay check ok`, then `connected to Lark`. Run exactly one worker per app.
2. On **Event Configuration** (*tr*, 事件配置), edit the subscription method and choose **Receive events through persistent connection** (*tr*, 使用长连接接收事件). Save. This only saves while the worker is connected.
3. Add the event **Message received**, `im.message.receive_v1`. Check that it is version 2.0.
4. On **Callback Configuration** (*tr*, 回调配置), edit the subscription method and choose **Receive callbacks through persistent connection** (*tr*, 使用长连接接收回调). Save, and keep the worker running while you do.
5. Under subscribed callbacks, choose **Add callback** and pick the NEW card callback: `card.action.trigger` (卡片回传交互). Do NOT pick the one marked "(old)" / 旧 (`card.action.trigger_v1`), which NoPM does not handle.

## 6b. Webhook (second run): give Lark the addresses

1. NoPM must be reachable over public HTTPS, on a host that resolves over IPv4. From a laptop, use a tunnel.
2. On **Event Configuration**:
   - choose **Send events to the developer's server** (*tr*, 将事件发送至开发者服务器);
   - paste `https://<host>/api/integrations/lark/<connector-id>/events` and save;
   - Lark sends a handshake and expects the challenge back within 1 second;
   - then add `im.message.receive_v1`.
3. On **Callback Configuration**:
   - choose **Send callbacks to the developer's server** (*tr*, 将回调发送至开发者服务器);
   - paste `https://<host>/api/integrations/lark/<connector-id>/card` and save;
   - add the new card callback.

## 7. Publish a version (*EN*: App Versions > "Version Management & Release" > "Create a version")

1. Fill in a version number and update notes, set the **availability scope**, save, and choose **Submit for release**.
2. The availability scope must include everyone who will chat with the bot or receive cards, including both approvers. Anyone outside it cannot be messaged (`230013`).
3. A tenant admin approves the version.

Scopes, events and callbacks take effect only after the approved release. Every later change needs a new version.

## 8. Smoke test, in this order

1. **Bot reply.** In Lark, search for the app, open the 1:1 chat and send `help`. A help card means events and the direct-message scope both work.

   If nothing comes back, check:
   - the release and its availability scope;
   - the `im:message.p2p_msg:readonly` scope;
   - the event subscription;
   - that the worker is running.
2. **Link both approvers.** In NoPM, choose **Integrations > Link my account**, copy the `NPL-XXXX-XXXX` code, and send `link NPL-XXXX-XXXX` to the bot. A confirmation card comes back. Do this for both approvers.
3. **Approve from a card.** As user A, raise a change request or a task deletion. User B gets an approval card. Press **Approve**. Expect:
   - the toast "Approved. Recorded in NoPM.";
   - the card turning into the decided card;
   - one Trust Center row with channel `lark`.

   If the worker logs no `relayed card click` line, look for a `ws frame with a non-event type` warning. That means clicks arrive as a frame type the SDK ignores (see the open questions).
4. **Reject from a card.** Repeat with **Reject**. The form needs a reason, and an empty reason sends no callback.
5. **Decide in the console.** Decide a request in the NoPM console while its card is open in Lark. The card should turn into the decided card within seconds. If it doesn't, read the connector's delivery list for the error.
6. **Self-approval.** Have user A tap a card for their own request. NoPM must refuse it.

## 9. Lark client errors

| Code | Meaning |
|---|---|
| 200340 | Callback address not configured or invalid; on long connection, the click never reached the handler |
| 200341 | No answer within 3 s |
| 200671 | Non-200 status |
| 200672 | Malformed response body |
| 200673 | Returned card invalid |
| 200830 | A 2.0 card was replaced by a 1.0 card |
| 200530 | A form component has an empty name |

## 10. Weekly digest (optional)

1. Add the bot to a group from the **desktop** Lark client: **Group settings > Group bots > Add bot**, then search for the app name. The mobile client can't add bots. The group must be inside the availability scope.
2. Get the group's `chat_id` (`oc_…`). In the developer console's API debugger, call `GET /open-apis/im/v1/chats` with a tenant token; this needs `im:chat:readonly`. Add the scope, publish a version, look up the id, then remove the scope and publish again.
3. In NoPM Integrations, turn the digest on, paste the chat id, pick a weekday, and press **Send now**.

## Open questions this run settles

Record the answer to each in the `testing-log/` entry:
- whether a card click reaches the worker as a frame the pinned SDK accepts (the `non-event type` warning);
- whether saving the callback subscription method also needs the worker online;
- whether `PATCH /open-apis/im/v1/messages/{id}` accepts a schema 2.0 card (step 8.5);
- whether patching the card that was just clicked is refused as "card locked during interaction" (`230099`);
- in webhook mode, whether card callbacks carry signature headers, and whether the URL handshake does;
- whether the handshake is answered inside Lark's 1-second budget;
- the English console wording for the *tr* labels above, and where in the Lark Admin console a tenant admin approves an app version.
