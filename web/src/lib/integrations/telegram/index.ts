/**
 * Telegram connector for the Integration Hub (ADR 0020).
 *
 * Pure translation + transport: parse an update, render a reply, call the Bot
 * API. Persistence, identity, retries and governance live in the hub core and
 * the REST routes. Deliberately does NOT import ./wiring (which imports the hub
 * core): nothing here may create an import cycle with it.
 */

export { handleTelegramUpdate, type TelegramContext, type TelegramDeps, type TelegramHttpResult } from "./handlers";
export { handleTelegramWebhook, type TelegramWebhookDeps } from "./webhook";
export { parseInput, menuFor, commandList, canUse, MENU, type Input, type Role } from "./commands";
export { defaultAskAssistant, type AskAssistant, type AssistantActor } from "./assistant-seam";
export { redact, isPlausibleBotToken } from "./http";
