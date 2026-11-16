import { Routes } from "discord.js";
import { z } from "zod";
import { guildOf, rest, snowflakeTime, type Ch } from "../discord.ts";
import { EDIT, READ, WRITE, def, guildId } from "../tool.ts";

const FLAG_PINNED = 1 << 1;
const FLAG_REQUIRE_TAG = 1 << 4;

type Thread = Ch & {
  parent_id?: string | null;
  applied_tags?: string[];
  flags?: number;
  message_count?: number;
  thread_metadata?: { archived: boolean; locked?: boolean; auto_archive_duration?: number };
};
type Tag = { id: string; name: string };

/** Turn tag names into IDs using the forum's tag list. Unknown names fail, so a typo never silently drops a tag. */
async function tagIds(forumId: string, names: string[]): Promise<string[]> {
  const forum = (await rest().get(Routes.channel(forumId))) as Ch;
  const tags: Tag[] = forum.available_tags ?? [];
  return names.map((n) => {
    const t = tags.find((x) => x.name.toLowerCase() === n.toLowerCase());
    if (!t) throw new Error(`Tag "${n}" does not exist in this forum (have: ${tags.map((x) => x.name).join(", ") || "none"}). Add it with edit_channel forumTags first.`);
    return t.id;
  });
}

const line = (t: Thread, tags: Tag[] = []) => {
  const m = t.thread_metadata;
  const names = (t.applied_tags ?? []).map((id) => tags.find((x) => x.id === id)?.name ?? id);
  return `${t.name} ${t.id}${m?.archived ? " [archived]" : ""}${m?.locked ? " [locked]" : ""}${(t.flags ?? 0) & FLAG_PINNED ? " [pinned]" : ""}${names.length ? ` tags: ${names.join(", ")}` : ""}`;
};

def("create_forum_post", {
  description:
    "Create a post (thread) in a forum channel with its first message. Tags are given by name and must already exist (see edit_channel forumTags). " +
    "Needs Send Messages (Create Posts) in the forum. Mentions do not notify.",
  inputSchema: {
    channelId: z.string().describe("Forum channel ID"),
    title: z.string().min(1).max(100),
    content: z.string().min(1).max(2000).describe("First message of the post"),
    tags: z.array(z.string()).max(5).optional().describe("Tag names"),
    pin: z.boolean().default(false).describe("Pin the post to the top of the forum (needs Manage Threads)"),
    autoArchiveMinutes: z.union([z.literal(60), z.literal(1440), z.literal(4320), z.literal(10080)]).optional().describe("Inactivity before the post is archived. Default 10080 (7 days)."),
  },
  annotations: WRITE,
}, async (a) => {
  const forum = (await rest().get(Routes.channel(a.channelId))) as Ch;
  if (forum.type !== 15 && forum.type !== 16) throw new Error(`${forum.name} is not a forum or media channel. Use send_message for text channels.`);
  const applied = a.tags?.length ? await tagIds(a.channelId, a.tags) : undefined;
  const t = (await rest().post(Routes.threads(a.channelId), {
    body: {
      name: a.title, auto_archive_duration: a.autoArchiveMinutes ?? 10080, applied_tags: applied,
      message: { content: a.content, allowed_mentions: { parse: [] } },
    },
  })) as Thread;
  if (a.pin) await rest().patch(Routes.channel(t.id), { body: { flags: (t.flags ?? 0) | FLAG_PINNED } });
  return `Created: ${t.name} ${t.id}`;
});

def("create_thread", {
  description:
    "Create a thread in a text or announcement channel. Pass messageId to start it from that message, otherwise it is a public thread not tied to a message. " +
    "For forum channels use create_forum_post. Needs Create Public Threads.",
  inputSchema: {
    channelId: z.string(), name: z.string().min(1).max(100), messageId: z.string().optional(),
    autoArchiveMinutes: z.union([z.literal(60), z.literal(1440), z.literal(4320), z.literal(10080)]).optional(),
  },
  annotations: WRITE,
}, async (a) => {
  const body = { name: a.name, auto_archive_duration: a.autoArchiveMinutes ?? 10080 };
  const t = (await (a.messageId
    ? rest().post(Routes.threads(a.channelId, a.messageId), { body })
    : rest().post(Routes.threads(a.channelId), { body: { ...body, type: 11 } }))) as Thread;
  return `Created: ${t.name} ${t.id}`;
});

def("list_threads", {
  description:
    "List threads (forum posts) of one channel, or every active thread in the server if channelId is omitted. " +
    "Set archived=true to list archived threads of channelId instead (newest first, up to limit).",
  inputSchema: {
    guildId, channelId: z.string().optional(), archived: z.boolean().default(false),
    limit: z.number().int().min(1).max(100).default(50),
  },
  annotations: READ,
}, async (a) => {
  if (a.archived) {
    if (!a.channelId) throw new Error("archived=true needs channelId.");
    const r = (await rest().get(Routes.channelThreads(a.channelId, "public"), { query: new URLSearchParams({ limit: String(a.limit) }) })) as { threads: Thread[] };
    const tags = ((await rest().get(Routes.channel(a.channelId))) as Ch).available_tags ?? [];
    return r.threads.map((t) => line(t, tags)).join("\n") || "(no archived threads)";
  }
  const r = (await rest().get(Routes.guildActiveThreads(guildOf(a.guildId)))) as { threads: Thread[] };
  const ts = r.threads.filter((t) => !a.channelId || t.parent_id === a.channelId);
  const cache = new Map<string, Tag[]>();
  const out: string[] = [];
  for (const t of ts) {
    if (t.parent_id && !cache.has(t.parent_id)) cache.set(t.parent_id, ((await rest().get(Routes.channel(t.parent_id))) as Ch).available_tags ?? []);
    out.push(`${line(t, cache.get(t.parent_id ?? ""))}${a.channelId ? "" : ` in ${t.parent_id}`} (created ${snowflakeTime(t.id).slice(0, 10)})`);
  }
  return out.join("\n") || "(no active threads)";
});

def("edit_thread", {
  description:
    "Change a thread or forum post (only the fields you pass): rename, archive/unarchive, lock/unlock, pin in the forum, set tags by name (replaces the tags). " +
    "Archiving, locking and pinning need Manage Threads.",
  inputSchema: {
    threadId: z.string(), name: z.string().min(1).max(100).optional(),
    archived: z.boolean().optional(), locked: z.boolean().optional(), pinned: z.boolean().optional(),
    tags: z.array(z.string()).max(5).optional().describe("Tag names; [] clears them"),
  },
  annotations: EDIT,
}, async (a) => {
  const t = (await rest().get(Routes.channel(a.threadId))) as Thread;
  if (![10, 11, 12].includes(t.type)) throw new Error(`${t.name} is not a thread.`);
  const body: Record<string, unknown> = { name: a.name, archived: a.archived, locked: a.locked };
  if (a.pinned !== undefined) body.flags = a.pinned ? (t.flags ?? 0) | FLAG_PINNED : (t.flags ?? 0) & ~FLAG_PINNED;
  if (a.tags) body.applied_tags = a.tags.length ? await tagIds(t.parent_id!, a.tags) : [];
  const r = (await rest().patch(Routes.channel(a.threadId), { body })) as Thread;
  return `Updated: ${r.name} ${r.id}`;
});

def("set_forum_options", {
  description:
    "Change forum channel behaviour (only the fields you pass): require a tag on every post, post sort order, default layout, and the default auto-archive time of posts. " +
    "Tags themselves are edited with edit_channel forumTags.",
  inputSchema: {
    channelId: z.string(),
    requireTag: z.boolean().optional(),
    sortOrder: z.enum(["latest_activity", "creation_date"]).optional(),
    layout: z.enum(["not_set", "list", "gallery"]).optional(),
    defaultAutoArchiveMinutes: z.union([z.literal(60), z.literal(1440), z.literal(4320), z.literal(10080)]).optional(),
    postSlowmodeSeconds: z.number().int().min(0).max(21600).optional().describe("Slowmode between creating posts"),
    threadSlowmodeSeconds: z.number().int().min(0).max(21600).optional().describe("Default slowmode inside new posts"),
  },
  annotations: EDIT,
}, async (a) => {
  const f = (await rest().get(Routes.channel(a.channelId))) as Ch & { flags?: number };
  if (f.type !== 15 && f.type !== 16) throw new Error(`${f.name} is not a forum or media channel.`);
  const body: Record<string, unknown> = {
    default_auto_archive_duration: a.defaultAutoArchiveMinutes,
    rate_limit_per_user: a.postSlowmodeSeconds,
    default_thread_rate_limit_per_user: a.threadSlowmodeSeconds,
    default_sort_order: a.sortOrder === undefined ? undefined : a.sortOrder === "latest_activity" ? 0 : 1,
    default_forum_layout: a.layout === undefined ? undefined : { not_set: 0, list: 1, gallery: 2 }[a.layout],
  };
  if (a.requireTag !== undefined) body.flags = a.requireTag ? (f.flags ?? 0) | FLAG_REQUIRE_TAG : (f.flags ?? 0) & ~FLAG_REQUIRE_TAG;
  await rest().patch(Routes.channel(a.channelId), { body });
  return `Updated: ${f.name} ${f.id}`;
});
