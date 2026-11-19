import path from "node:path"
import { OPENCODE_CHANNEL } from "./version"

declare const LARPCODE_CLI_DISTRIBUTION: string | undefined

// The standalone CLI shares the desktop app's data root, so it must also share
// its database. Desktop releases use the channel-less opencode.db; a CLI built
// from a named channel would otherwise open an empty opencode-<channel>.db and
// lose every session and credential saved by the desktop.
const shared = typeof LARPCODE_CLI_DISTRIBUTION === "string"

export function databasePath(data: string) {
  const filename =
    process.env.OPENCODE_DB ??
    (shared ||
    ["latest", "dev", "beta", "next", "prod"].includes(OPENCODE_CHANNEL) ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "1" ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "true"
      ? "opencode.db"
      : `opencode-${OPENCODE_CHANNEL.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
  return filename === ":memory:" ? filename : path.resolve(data, filename)
}
