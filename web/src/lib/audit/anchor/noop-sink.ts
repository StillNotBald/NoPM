import type { AnchorSink } from "./sink";

/** Used when NOPM_ANCHOR_DB_URL is unset: writes nothing, reads nothing, throws nothing. */
export const noopSink: AnchorSink = {
  kind: "none",
  async put() {
    return { status: "disabled" };
  },
  async latest() {
    return { ok: true, records: new Map() };
  },
};
