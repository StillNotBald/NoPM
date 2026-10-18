// cli/commands/auth.mjs — token management
import { loadConfig, saveConfig, die } from "../lib/api.mjs";
import { homedir } from "node:os";
import path from "node:path";

const CFG_FILE = path.join(homedir(), ".nopm", "config.json");

export const describe = "Save a scoped PAT for all subsequent commands";

export const usage = [
  "nopm auth set-token <token> [--url <url>]   save your scoped PAT",
];

export async function run(rest, ctx) {
  const [sub, ...args] = ctx.flags._;
  if (sub !== "set-token") {
    console.log(usage.join("\n"));
    return;
  }
  const token = args[0]; // args = positionals after "set-token"
  if (!token) die("usage: nopm auth set-token <token> [--url <url>]");
  const cfg = loadConfig();
  saveConfig({ url: ctx.flags.url || cfg.url, token });
  console.log(`✓ token saved to ${CFG_FILE} (url: ${ctx.flags.url || cfg.url})`);
}
