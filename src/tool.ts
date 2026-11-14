import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };

export const server = new McpServer({ name: "diserverbuilder", version: pkg.version });

/** DISERVERBUILDER_READONLY=1 registers only tools that cannot change anything on Discord. */
export const READONLY = /^(1|true|yes)$/i.test(process.env.DISERVERBUILDER_READONLY ?? "");

export const guildId = z.string().optional().describe("Server (guild) ID. Defaults to DISCORD_GUILD_ID if omitted.");
export const kindEnum = z.enum(["text", "voice", "announcement", "stage", "forum"]);
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
const fail = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }] });

interface Config<S extends z.ZodRawShape> {
  description: string;
  inputSchema: S;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

/** Register a tool. Errors become MCP error results; in read-only mode, tools that change Discord are skipped. */
export function def<S extends z.ZodRawShape>(
  name: string,
  cfg: Config<S>,
  fn: (a: z.infer<z.ZodObject<S>>) => Promise<string>,
) {
  const changesDiscord = cfg.annotations.openWorldHint && !cfg.annotations.readOnlyHint;
  if (READONLY && changesDiscord) return;
  server.registerTool(name, cfg as never, (async (a: z.infer<z.ZodObject<S>>) => {
    try { return ok(await fn(a)); } catch (e) { return fail(e); }
  }) as never);
}
