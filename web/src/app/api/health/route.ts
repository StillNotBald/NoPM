import { route } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";

export const runtime = "nodejs";

// Public liveness probe — also the simplest example of the route() contract.
export const GET = route(
  async () => ok({ status: "ok", service: "nopm", time: new Date().toISOString() }),
  { auth: false },
);
