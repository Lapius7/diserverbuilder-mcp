#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Routes } from "discord.js";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };
import {
  KIND, applyLayout, getChannels, getRoles, guildOf, permBits, render, rest, snapshot,
  type Ch, type Role,
} from "./discord.ts";

const server = new McpServer({ name: "diserverbuilder", version: pkg.version });

const guildId = z.string().optional().describe("Server (guild) ID. Defaults to DISCORD_GUILD_ID if omitted.");
const kindEnum = z.enum(["text", "voice", "announcement", "stage", "forum"]);
const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }] });

/** Convert thrown errors into MCP error results. */
const tool = <A>(fn: (a: A) => Promise<string>) => async (a: A) => {
  try { return ok(await fn(a)); } catch (e) { return fail(e); }
};

const READ = { readOnlyHint: true, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;

server.registerTool("list_guilds", {
  description: "List the servers (ID and name) the bot has joined.",
  inputSchema: {},
  annotations: READ,
}, tool(async () => {
  const gs = (await rest().get(Routes.userGuilds())) as { id: string; name: string }[];
  return gs.map((g) => `${g.name} ${g.id}`).join("\n") || "(the bot has not joined any server)";
}));

server.registerTool("get_structure", {
  description: "Get categories and channels in display order, with IDs. Call this before reorganizing anything.",
  inputSchema: { guildId },
  annotations: READ,
}, tool(async (a: { guildId?: string }) => render(await getChannels(guildOf(a.guildId)))));

server.registerTool("list_roles", {
  description: "List roles (ID and name), highest first. Needed for permission settings.",
  inputSchema: { guildId },
  annotations: READ,
}, tool(async (a: { guildId?: string }) =>
  (await getRoles(guildOf(a.guildId))).sort((x: Role, y: Role) => y.position - x.position)
    .map((r) => `${r.name} ${r.id}${r.managed ? " (managed)" : ""}`).join("\n")));

server.registerTool("snapshot", {
  description:
    "Save the current structure (channels, roles, permission overwrites) as JSON. " +
    "Saved to DISERVERBUILDER_SNAPSHOT_DIR, default ~/.diserverbuilder/snapshots. Use before deletions or large changes.",
  inputSchema: { guildId },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
}, tool(async (a: { guildId?: string }) => `Saved: ${await snapshot(guildOf(a.guildId))}`));

server.registerTool("create_category", {
  description: "Create a category.",
  inputSchema: { guildId, name: z.string().max(100), private: z.boolean().optional().describe("Deny @everyone from viewing") },
  annotations: WRITE,
}, tool(async (a: { guildId?: string; name: string; private?: boolean }) => {
  const g = guildOf(a.guildId);
  const c = (await rest().post(Routes.guildChannels(g), {
    body: {
      name: a.name, type: KIND.category,
      permission_overwrites: a.private ? [{ id: g, type: 0, allow: "0", deny: permBits(["ViewChannel"]) }] : undefined,
    },
  })) as Ch;
  return `Created: ${c.name} ${c.id}`;
}));

server.registerTool("create_channel", {
  description: "Create a channel. Use parentId to place it under a category.",
  inputSchema: {
    guildId, name: z.string().max(100), type: kindEnum.default("text"),
    parentId: z.string().optional().describe("Category ID"),
    topic: z.string().max(1024).optional(),
    nsfw: z.boolean().optional(),
  },
  annotations: WRITE,
}, tool(async (a: { guildId?: string; name: string; type: z.infer<typeof kindEnum>; parentId?: string; topic?: string; nsfw?: boolean }) => {
  const c = (await rest().post(Routes.guildChannels(guildOf(a.guildId)), {
    body: { name: a.name, type: KIND[a.type], parent_id: a.parentId, topic: a.topic, nsfw: a.nsfw },
  })) as Ch;
  return `Created: ${c.name} ${c.id}`;
}));

server.registerTool("edit_channel", {
  description: "Change a channel or category's name, topic, NSFW flag, or parent (only the fields you pass). Pass an empty string as parentId to remove it from its category.",
  inputSchema: {
    channelId: z.string(), name: z.string().max(100).optional(), topic: z.string().max(1024).optional(),
    nsfw: z.boolean().optional(), parentId: z.string().optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, tool(async (a: { channelId: string; name?: string; topic?: string; nsfw?: boolean; parentId?: string }) => {
  const body: Record<string, unknown> = { name: a.name, topic: a.topic, nsfw: a.nsfw };
  if (a.parentId !== undefined) body.parent_id = a.parentId === "" ? null : a.parentId;
  const c = (await rest().patch(Routes.channel(a.channelId), { body })) as Ch;
  return `Updated: ${c.name} ${c.id}`;
}));

server.registerTool("reorder", {
  description: "Change order and parent for many channels at once. position is the 0-based index within the same parent.",
  inputSchema: {
    guildId,
    items: z.array(z.object({
      id: z.string(), position: z.number().int().min(0),
      parentId: z.string().nullable().optional().describe("Target category. null = no category. Omit to leave unchanged."),
    })).min(1),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, tool(async (a: { guildId?: string; items: { id: string; position: number; parentId?: string | null }[] }) => {
  await rest().patch(Routes.guildChannels(guildOf(a.guildId)), {
    body: a.items.map((i) => ({ id: i.id, position: i.position, parent_id: i.parentId })),
  });
  return `Updated the order of ${a.items.length} item(s)`;
}));

server.registerTool("set_permissions", {
  description:
    "Set a role's or member's permission overwrite on a channel or category (replaces that target's existing overwrite). " +
    "Permission names are discord.js PermissionFlagsBits keys, e.g. ViewChannel, SendMessages, Connect. Use clear_permissions to remove an overwrite.",
  inputSchema: {
    channelId: z.string(), targetId: z.string().describe("Role ID or user ID (the @everyone role ID equals the server ID)"),
    targetType: z.enum(["role", "member"]).default("role"),
    allow: z.array(z.string()).default([]), deny: z.array(z.string()).default([]),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
}, tool(async (a: { channelId: string; targetId: string; targetType: "role" | "member"; allow: string[]; deny: string[] }) => {
  await rest().put(Routes.channelPermission(a.channelId, a.targetId), {
    body: { type: a.targetType === "role" ? 0 : 1, allow: permBits(a.allow), deny: permBits(a.deny) },
  });
  return `Set: allow=[${a.allow}] deny=[${a.deny}]`;
}));

server.registerTool("clear_permissions", {
  description: "Remove a target's permission overwrite from a channel or category.",
  inputSchema: { channelId: z.string(), targetId: z.string() },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
}, tool(async (a: { channelId: string; targetId: string }) => {
  await rest().delete(Routes.channelPermission(a.channelId, a.targetId));
  return "Removed";
}));

server.registerTool("create_role", {
  description: "Create a role. The bot cannot grant permissions it does not have itself.",
  inputSchema: {
    guildId, name: z.string().max(100), color: z.number().int().optional().describe("Color as a 0xRRGGBB number"),
    permissions: z.array(z.string()).optional(), hoist: z.boolean().optional(), mentionable: z.boolean().optional(),
  },
  annotations: WRITE,
}, tool(async (a: { guildId?: string; name: string; color?: number; permissions?: string[]; hoist?: boolean; mentionable?: boolean }) => {
  const r = (await rest().post(Routes.guildRoles(guildOf(a.guildId)), {
    body: { name: a.name, color: a.color, permissions: a.permissions ? permBits(a.permissions) : undefined, hoist: a.hoist, mentionable: a.mentionable },
  })) as Role;
  return `Created: ${r.name} ${r.id}`;
}));

server.registerTool("delete_channel", {
  description:
    "Delete a channel or category. Messages go with it and cannot be restored. " +
    "confirmName must exactly match the current name, and the channel must belong to the given server. Take a snapshot first. " +
    "Deleting a category keeps its channels (they become uncategorized).",
  inputSchema: { guildId, channelId: z.string(), confirmName: z.string() },
  annotations: DESTRUCTIVE,
}, tool(async (a: { guildId?: string; channelId: string; confirmName: string }) => {
  const g = guildOf(a.guildId);
  const c = (await rest().get(Routes.channel(a.channelId))) as Ch;
  if (c.guild_id !== g) throw new Error(`Channel ${a.channelId} does not belong to server ${g}. Nothing deleted.`);
  if (c.name !== a.confirmName) throw new Error(`Name mismatch (actual: ${c.name}). Nothing deleted.`);
  await rest().delete(Routes.channel(a.channelId));
  return `Deleted: ${c.name}`;
}));

const layoutChannel = z.object({
  name: z.string(), type: kindEnum.optional(), topic: z.string().optional(), nsfw: z.boolean().optional(),
  private: z.boolean().optional(), allowRoles: z.array(z.string()).optional(),
});

server.registerTool("apply_layout", {
  description:
    "Declare the desired structure and apply it in bulk. Matches existing items by name, creates missing ones, moves and updates topics of existing ones, and orders everything as given. " +
    "Defaults to dryRun (shows the plan only). Channels not in the layout are deleted only when prune=true and dryRun=false (a snapshot is saved automatically before a real run). " +
    "private/allowRoles apply only to newly created items.",
  inputSchema: {
    guildId,
    categories: z.array(z.object({
      name: z.string(), private: z.boolean().optional(), allowRoles: z.array(z.string()).optional(),
      channels: z.array(layoutChannel).optional(),
    })),
    dryRun: z.boolean().default(true),
    prune: z.boolean().default(false),
  },
  annotations: DESTRUCTIVE,
}, tool(async (a: { guildId?: string; categories: Parameters<typeof applyLayout>[1]["categories"]; dryRun: boolean; prune: boolean }) => {
  const g = guildOf(a.guildId);
  let head = "";
  if (!a.dryRun) head = `Snapshot: ${await snapshot(g)}\n`;
  const plan = await applyLayout(g, { categories: a.categories }, { dryRun: a.dryRun, prune: a.prune });
  return `${head}${a.dryRun ? "[dry-run]" : "[applied]"}\n${plan.join("\n")}`;
}));

await server.connect(new StdioServerTransport());
