import { route } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { readBuildInfo } from "./_build";

export const runtime = "nodejs";

// Public liveness probe — also the simplest example of the route() contract.
// DB-free on purpose (it must answer when the database is the thing that is
// down); `build` says which commit is deployed (null when the host exposes none).
export const GET = route(
  async () => ok({ status: "ok", service: "nopm", time: new Date().toISOString(), build: readBuildInfo() }),
  { auth: false },
);
