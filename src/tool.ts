import { DiscordAPIError } from "discord.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };
import { GROUP_OF, enabledGroups } from "./groups.ts";

export const server = new McpServer({ name: "diserverbuilder", version: pkg.version });

/** DISERVERBUILDER_READONLY=1 registers only tools that cannot change anything on Discord. */
export const READONLY = /^(1|true|yes)$/i.test(process.env.DISERVERBUILDER_READONLY ?? "");

const GROUPS_ON = enabledGroups();
/** Names of every tool a module asked to register (before read-only and group filtering). Used by tests. */
export const registered: string[] = [];

export const guildId = z.string().optional().describe("Server (guild) ID. Defaults to DISCORD_GUILD_ID if omitted.");
export const kindEnum = z.enum(["text", "voice", "announcement", "stage", "forum", "media"]);
export const overwriteSpec = z.object({
  role: z.string().describe('Role name, or "@everyone"'),
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
});

export const READ = { readOnlyHint: true, openWorldHint: true } as const;
export const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
export const EDIT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
export const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;
/** Writes only to the local snapshot directory. */
export const LOCAL = { readOnlyHint: false, destructiveHint: false, idempotentHint: false } as const;

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
/** Flatten Discord's nested validation errors into "path: message" lines. */
function fieldErrors(node: unknown, path = ""): string[] {
  if (!node || typeof node !== "object") return [];
  const n = node as Record<string, unknown>;
  if (Array.isArray(n._errors)) {
    const msgs = (n._errors as { message?: string }[]).map((x) => x.message).filter(Boolean);
    if (msgs.length) return [`${path || "(body)"}: ${msgs.join("; ")}`];
  }
  return Object.entries(n).flatMap(([k, v]) => (k === "_errors" ? [] : fieldErrors(v, path ? `${path}.${k}` : k)));
}

/** Turn an error into a short message that says what went wrong and what to do about it. */
export function explain(e: unknown): string {
  if (e instanceof DiscordAPIError) {
    // Webhook URLs carry a secret token in the path: never print it.
    const where = `${e.method} ${new URL(e.url).pathname.replace(/^\/api\/v\d+/, "").replace(/^(\/webhooks\/\d+)\/[^/]+/, "$1/<token>")}`;
    const hint: string =
      e.status === 401 ? "The bot token is invalid or was reset. Run `npx diserverbuilder-mcp auth` to save a new one (Developer Portal, Bot, Reset Token), or fix DISCORD_BOT_TOKEN if you set it."
      : e.code === 50001 ? "Discord says the bot has no access. Check that it was invited to the server and can view the channel. Some actions (Discord templates, turning Community on or off) need the Administrator permission."
      : e.code === 50013 || e.status === 403
        ? "The bot lacks a permission for this. Grant it, and move the bot's role above any role it edits (Discord does not let a bot edit roles above its own)."
      : e.code === 50035 ? "Discord rejected a value:\n" + (fieldErrors((e.rawError as { errors?: unknown }).errors).map((l) => `  ${l}`).join("\n") || `  ${e.message}`)
      : [10003, 10004, 10008, 10011, 10013, 10014, 10015, 10026, 10062].includes(e.code as number) || e.status === 404
        ? "Not found. Check the ID (use get_structure, list_roles or list_guilds to look it up) and that it belongs to this server."
      : e.status === 429 ? "Rate limited by Discord. Wait a moment and try again."
      : e.status >= 500 ? "Discord had a problem on its side. Try again shortly."
      : e.message;
    return `Discord API error (${e.status}${e.code ? `, code ${e.code}` : ""}) on ${where}\n${hint}`;
  }
  if (e instanceof Error) {
    const code = (e as { code?: string }).code;
    if (code === "ConnectionRefused" || code === "ENOTFOUND" || code === "ECONNRESET" || code === "ETIMEDOUT" || /Unable to connect|fetch failed/.test(e.message))
      return "Could not reach Discord. Check the network connection and try again.";
    return e.message;
  }
  return String(e);
}

const queues = new Map<string, Promise<unknown>>();
/**
 * Run changes to one server one after another. A client that times out and retries would otherwise start a second run while the first
 * is still going, and both create the same missing channels (seen on a live server: three copies of one category).
 */
export function withGuildLock<T>(g: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(g) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => undefined);
  queues.set(g, tail);
  void tail.then(() => { if (queues.get(g) === tail) queues.delete(g); });
  return run;
}

const fail = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: explain(e) }] });

interface Config<S extends z.ZodRawShape> {
  description: string;
  inputSchema: S;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

/** Register a tool. Errors become MCP error results; in read-only mode, tools that change Discord are skipped, and so are tools outside DISERVERBUILDER_TOOLS. */
export function def<S extends z.ZodRawShape>(
  name: string,
  cfg: Config<S>,
  fn: (a: z.infer<z.ZodObject<S>>) => Promise<string>,
) {
  registered.push(name);
  const changesDiscord = cfg.annotations.openWorldHint && !cfg.annotations.readOnlyHint;
  if (READONLY && changesDiscord) return;
  if (GROUPS_ON && !GROUPS_ON.has(GROUP_OF[name] ?? "")) return;
  server.registerTool(name, cfg as never, (async (a: z.infer<z.ZodObject<S>>) => {
    try { return ok(await fn(a)); } catch (e) { return fail(e); }
  }) as never);
}
