import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where `auth` stores the bot token. Override with DISERVERBUILDER_CONFIG_DIR. */
export const configDir = () => process.env.DISERVERBUILDER_CONFIG_DIR || join(homedir(), ".diserverbuilder");
export const configPath = () => join(configDir(), "config.json");

function savedToken(): string | undefined {
  try {
    const t = (JSON.parse(readFileSync(configPath(), "utf8")) as { token?: unknown }).token;
    return typeof t === "string" && t ? t : undefined;
  } catch {
    return undefined;
  }
}

/** The bot token: the DISCORD_BOT_TOKEN environment variable wins, then the file written by `auth`. */
export function resolveToken(): { token: string; source: "env" | "file" } | undefined {
  const env = process.env.DISCORD_BOT_TOKEN?.trim();
  if (env) return { token: env, source: "env" };
  const file = savedToken();
  return file ? { token: file, source: "file" } : undefined;
}

export function saveToken(token: string) {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(configPath(), JSON.stringify({ token }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(configPath(), 0o600); // also tightens a file that already existed
}

/** Returns false when there was nothing to remove. */
export function removeToken(): boolean {
  if (!existsSync(configPath())) return false;
  rmSync(configPath());
  return true;
}
