import { noopSink } from "./noop-sink";
import { createPostgresSink } from "./postgres-sink";
import type { AnchorSink } from "./sink";

/** The configured sink: NOPM_ANCHOR_DB_URL set gives the Postgres sink, unset or blank gives the no-op. */
export function getAnchorSink(env: Record<string, string | undefined> = process.env): AnchorSink {
  const url = env.NOPM_ANCHOR_DB_URL?.trim();
  return url ? createPostgresSink(url, env) : noopSink;
}
