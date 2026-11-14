import { ChannelType, Routes } from "discord.js";
import { z } from "zod";
import {
  KIND, KIND_BY_TYPE, buildOverwrites, getChannels, getRoles, guildOf, permBits, permNames, render, rest,
  type Ch, type Overwrite,
} from "../discord.ts";
import { DESTRUCTIVE, EDIT, READ, WRITE, def, guildId, kindEnum, overwriteSpec } from "../tool.ts";

const extra = {
  rateLimitPerUser: z.number().int().min(0).max(21600).optional().describe("Slowmode in seconds (0 = off)"),
  userLimit: z.number().int().min(0).max(99).optional().describe("Voice: max users (0 = unlimited)"),
  bitrate: z.number().int().min(8000).optional().describe("Voice: bitrate in bps"),
};
const extraBody = (a: { rateLimitPerUser?: number; userLimit?: number; bitrate?: number }) => ({
  rate_limit_per_user: a.rateLimitPerUser, user_limit: a.userLimit, bitrate: a.bitrate,
});

def("get_structure", {
  description: "Get categories and channels in display order, with IDs. Call this before reorganizing anything.",
  inputSchema: { guildId },
  annotations: READ,
}, async (a) => render(await getChannels(guildOf(a.guildId))));

def("create_category", {
  description: "Create a category.",
  inputSchema: {
    guildId, name: z.string().max(100), private: z.boolean().optional().describe("Deny @everyone from viewing"),
    allowRoles: z.array(z.string()).optional().describe("With private: role names allowed to view"),
    overwrites: z.array(overwriteSpec).optional(),
  },
  annotations: WRITE,
}, async (a) => {
  const g = guildOf(a.guildId);
  const c = (await rest().post(Routes.guildChannels(g), {
    body: { name: a.name, type: KIND.category, permission_overwrites: buildOverwrites(g, await getRoles(g), a) },
  })) as Ch;
  return `Created: ${c.name} ${c.id}`;
});

def("create_channel", {
  description: "Create a channel. Use parentId to place it under a category.",
  inputSchema: {
    guildId, name: z.string().max(100), type: kindEnum.default("text"),
    parentId: z.string().optional().describe("Category ID"),
    topic: z.string().max(1024).optional(),
    nsfw: z.boolean().optional(),
    private: z.boolean().optional().describe("Deny @everyone from viewing"),
    allowRoles: z.array(z.string()).optional().describe("With private: role names allowed to view"),
    overwrites: z.array(overwriteSpec).optional(),
    ...extra,
  },
  annotations: WRITE,
}, async (a) => {
  const g = guildOf(a.guildId);
  const c = (await rest().post(Routes.guildChannels(g), {
    body: {
      name: a.name, type: KIND[a.type], parent_id: a.parentId, topic: a.topic, nsfw: a.nsfw, ...extraBody(a),
      permission_overwrites: buildOverwrites(g, await getRoles(g), a),
    },
  })) as Ch;
  return `Created: ${c.name} ${c.id}`;
});

def("edit_channel", {
  description:
    "Change a channel or category (only the fields you pass): name, topic, NSFW, parent, slowmode, voice limits, forum tags. " +
    "Pass an empty string as parentId to remove it from its category. forumTags replaces the tag list by name (existing tags keep their IDs).",
  inputSchema: {
    channelId: z.string(), name: z.string().max(100).optional(), topic: z.string().max(1024).optional(),
    nsfw: z.boolean().optional(), parentId: z.string().optional(),
    forumTags: z.array(z.string().max(20)).optional(), ...extra,
  },
  annotations: EDIT,
}, async (a) => {
  const body: Record<string, unknown> = { name: a.name, topic: a.topic, nsfw: a.nsfw, ...extraBody(a) };
  if (a.parentId !== undefined) body.parent_id = a.parentId === "" ? null : a.parentId;
  if (a.forumTags) {
    const cur = (await rest().get(Routes.channel(a.channelId))) as Ch;
    const have = new Map((cur.available_tags ?? []).map((t) => [t.name.toLowerCase(), t]));
    body.available_tags = a.forumTags.map((n) => have.get(n.toLowerCase()) ?? { name: n });
  }
  const c = (await rest().patch(Routes.channel(a.channelId), { body })) as Ch;
  return `Updated: ${c.name} ${c.id}`;
});

def("reorder", {
  description: "Change order and parent for many channels at once. position is the 0-based index within the same parent. Discord allows changing the parent of only one channel per call; use edit_channel or apply_layout for several moves.",
  inputSchema: {
    guildId,
    items: z.array(z.object({
      id: z.string(), position: z.number().int().min(0),
      parentId: z.string().nullable().optional().describe("Target category. null = no category. Omit to leave unchanged."),
    })).min(1),
  },
  annotations: EDIT,
}, async (a) => {
  await rest().patch(Routes.guildChannels(guildOf(a.guildId)), {
    body: a.items.map((i) => ({ id: i.id, position: i.position, parent_id: i.parentId })),
  });
  return `Updated the order of ${a.items.length} item(s)`;
});

def("clone_channel", {
  description:
    "Duplicate a channel or category with its settings and permission overwrites. " +
    "For a category, withChildren=true also duplicates the channels inside it. The copy is added at the end.",
  inputSchema: { channelId: z.string(), name: z.string().max(100).optional().describe("Defaults to the same name"), withChildren: z.boolean().default(false) },
  annotations: WRITE,
}, async (a) => {
  const src = (await rest().get(Routes.channel(a.channelId))) as Ch;
  const g = src.guild_id!;
  const copy = async (c: Ch, name: string, parent?: string | null) =>
    (await rest().post(Routes.guildChannels(g), {
      body: {
        name, type: c.type, parent_id: parent ?? undefined, topic: c.topic ?? undefined, nsfw: c.nsfw,
        rate_limit_per_user: c.rate_limit_per_user, user_limit: c.user_limit, bitrate: c.bitrate,
        permission_overwrites: c.permission_overwrites,
      },
    })) as Ch;
  const made = await copy(src, a.name ?? src.name, src.type === ChannelType.GuildCategory ? undefined : src.parent_id);
  const out = [`Created: ${made.name} ${made.id}`];
  if (a.withChildren && src.type === ChannelType.GuildCategory) {
    const kids = (await getChannels(g)).filter((c) => c.parent_id === src.id).sort((x, y) => x.position - y.position);
    for (const k of kids) {
      const c = await copy(k, k.name, made.id);
      out.push(`  Created: ${c.name} ${c.id}`);
    }
  }
  return out.join("\n");
});

def("get_permissions", {
  description: "Show a channel or category's permission overwrites in readable form (role names, allowed and denied permissions).",
  inputSchema: { channelId: z.string() },
  annotations: READ,
}, async (a) => {
  const c = (await rest().get(Routes.channel(a.channelId))) as Ch;
  const roles = c.guild_id ? await getRoles(c.guild_id) : [];
  const who = (o: Overwrite) =>
    o.type === 1 ? `member ${o.id}` : o.id === c.guild_id ? "@everyone" : roles.find((r) => r.id === o.id)?.name ?? `role ${o.id}`;
  const lines = (c.permission_overwrites ?? []).map((o) =>
    `${who(o)} (${o.id})\n  allow: ${permNames(o.allow).join(", ") || "-"}\n  deny: ${permNames(o.deny).join(", ") || "-"}`);
  return `${c.name} [${KIND_BY_TYPE[c.type] ?? c.type}]\n${lines.join("\n") || "(no overwrites)"}`;
});

def("set_permissions", {
  description:
    "Set a role's or member's permission overwrite on a channel or category (replaces that target's existing overwrite). " +
    "Permission names are discord.js PermissionFlagsBits keys, e.g. ViewChannel, SendMessages, Connect. Use clear_permissions to remove an overwrite.",
  inputSchema: {
    channelId: z.string(), targetId: z.string().describe("Role ID or user ID (the @everyone role ID equals the server ID)"),
    targetType: z.enum(["role", "member"]).default("role"),
    allow: z.array(z.string()).default([]), deny: z.array(z.string()).default([]),
  },
  annotations: DESTRUCTIVE,
}, async (a) => {
  await rest().put(Routes.channelPermission(a.channelId, a.targetId), {
    body: { type: a.targetType === "role" ? 0 : 1, allow: permBits(a.allow), deny: permBits(a.deny) },
  });
  return `Set: allow=[${a.allow}] deny=[${a.deny}]`;
});

def("clear_permissions", {
  description: "Remove a target's permission overwrite from a channel or category.",
  inputSchema: { channelId: z.string(), targetId: z.string() },
  annotations: DESTRUCTIVE,
}, async (a) => {
  await rest().delete(Routes.channelPermission(a.channelId, a.targetId));
  return "Removed";
});

def("sync_permissions", {
  description:
    "Make channels inside a category use the category's permission overwrites (replacing their own). " +
    "Defaults to dryRun. Pass channelIds to limit which children are synced.",
  inputSchema: {
    categoryId: z.string(), channelIds: z.array(z.string()).optional(), dryRun: z.boolean().default(true),
  },
  annotations: DESTRUCTIVE,
}, async (a) => {
  const cat = (await rest().get(Routes.channel(a.categoryId))) as Ch;
  if (cat.type !== ChannelType.GuildCategory) throw new Error(`${cat.name} is not a category.`);
  const kids = (await getChannels(cat.guild_id!)).filter((c) => c.parent_id === cat.id && (!a.channelIds || a.channelIds.includes(c.id)));
  const out: string[] = [a.dryRun ? "[dry-run]" : "[applied]"];
  for (const k of kids) {
    out.push(`~ ${k.name}: ${k.permission_overwrites?.length ?? 0} -> ${cat.permission_overwrites?.length ?? 0} overwrites`);
    if (!a.dryRun) await rest().patch(Routes.channel(k.id), { body: { permission_overwrites: cat.permission_overwrites ?? [] } });
  }
  if (!kids.length) out.push("(no channels to sync)");
  return out.join("\n");
});

def("delete_channel", {
  description:
    "Delete a channel or category. Messages go with it and cannot be restored. " +
    "confirmName must exactly match the current name, and the channel must belong to the given server. Take a snapshot first. " +
    "Deleting a category keeps its channels (they become uncategorized).",
  inputSchema: { guildId, channelId: z.string(), confirmName: z.string() },
  annotations: DESTRUCTIVE,
}, async (a) => {
  const g = guildOf(a.guildId);
  const c = (await rest().get(Routes.channel(a.channelId))) as Ch;
  if (c.guild_id !== g) throw new Error(`Channel ${a.channelId} does not belong to server ${g}. Nothing deleted.`);
  if (c.name !== a.confirmName) throw new Error(`Name mismatch (actual: ${c.name}). Nothing deleted.`);
  await rest().delete(Routes.channel(a.channelId));
  return `Deleted: ${c.name}`;
});
