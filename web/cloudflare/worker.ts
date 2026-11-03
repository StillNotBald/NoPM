/**
 * Custom Worker entry for the Cloudflare host (ADR 0021, off by default).
 * Re-exports the OpenNext fetch handler unchanged and adds `scheduled()` so the
 * Cron Triggers in wrangler.jsonc can call the two cron routes that Vercel Cron
 * calls today. Vercel never loads this file.
 *
 * Needs `.open-next/worker.js`, which `npm run cf:build` writes (Linux/WSL only).
 */
import handler from "../.open-next/worker.js";
import { runScheduled, type CronEnv } from "../src/lib/host/cloudflare-cron";

type ScheduledController = { cron: string };
type WorkerCtx = { waitUntil(promise: Promise<unknown>): void };

const worker = {
  fetch: handler.fetch,

  async scheduled(controller: ScheduledController, env: CronEnv, ctx: WorkerCtx): Promise<void> {
    ctx.waitUntil(runScheduled(controller.cron, env, (request) => handler.fetch(request, env, ctx)));
  },
};

export default worker;
