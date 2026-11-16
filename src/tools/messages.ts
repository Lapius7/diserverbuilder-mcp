import { Routes } from "discord.js";
import { z } from "zod";
import { rest } from "../discord.ts";
import { chunk, selectPurge, type PurgeMsg } from "../purge.ts";
import { DESTRUCTIVE, EDIT, READ, WRITE, def } from "../tool.ts";

const embed = z.object({
  title: z.string().max(256).optional(),
  description: z.string().max(4096).optional(),
  url: z.string().optional(),
  color: z.number().int().optional().describe("0xRRGGBB"),
  fields: z.array(z.object({ name: z.string().max(256), value: z.string().max(1024), inline: z.boolean().optional() })).max(25).optional(),
  footer: z.string().max(2048).optional(),
  image: z.string().optional().describe("Image URL"),
  thumbnail: z.string().optional().describe("Thumbnail URL"),
  author: z.string().max(256).optional(),
});
const toEmbed = (e: z.infer<typeof embed>) => ({
  title: e.title, description: e.description, url: e.url, color: e.color, fields: e.fields,
  footer: e.footer ? { text: e.footer } : undefined,
  image: e.image ? { url: e.image } : undefined,
  thumbnail: e.thumbnail ? { url: e.thumbnail } : undefined,
  author: e.author ? { name: e.author } : undefined,
});

const poll = z.object({
  question: z.string().max(300),
  answers: z.array(z.object({ text: z.string().max(55), emoji: z.string().optional().describe("A unicode emoji") })).min(1).max(10),
  durationHours: z.number().int().min(1).max(768).default(24),
  allowMultiselect: z.boolean().default(false),
});
const linkButton = z.object({ label: z.string().max(80), url: z.string().url(), emoji: z.string().optional().describe("A unicode emoji") });

/** Only link buttons: the server has no gateway connection, so nothing could receive a click on any other kind. */
const toButtons = (bs?: z.infer<typeof linkButton>[]) =>
  bs?.length ? [{ type: 1, components: bs.map((b) => ({ type: 2, style: 5, label: b.label, url: b.url, emoji: b.emoji ? { name: b.emoji } : undefined })) }] : undefined;
const toPoll = (p?: z.infer<typeof poll>) =>
  p ? {
    question: { text: p.question },
    answers: p.answers.map((x) => ({ poll_media: { text: x.text, emoji: x.emoji ? { name: x.emoji } : undefined } })),
    duration: p.durationHours, allow_multiselect: p.allowMultiselect,
  } : undefined;

/** Mentions are suppressed unless explicitly allowed, so an AI-written message cannot ping @everyone by accident. */
const mentions = (allow?: boolean) => (allow ? undefined : { parse: [] as string[] });
const allowMentions = z.boolean().default(false).describe("Allow @everyone/@role/@user mentions to notify. Default false.");

type Msg = { id: string; content: string; author: { username: string }; pinned?: boolean; embeds?: unknown[] };

def("send_message", {
  description:
    "Send a message to a channel as the bot: text, embeds, a poll, and/or link buttons (buttons that open a URL; other kinds cannot work without a gateway connection). " +
    "replyToMessageId makes it a reply. Mentions do not notify unless allowMentions=true. Optionally pin it.",
  inputSchema: {
    channelId: z.string(), content: z.string().max(2000).optional(), embeds: z.array(embed).max(10).optional(),
    poll: poll.optional(), linkButtons: z.array(linkButton).max(5).optional(), replyToMessageId: z.string().optional(),
    pin: z.boolean().default(false), allowMentions,
  },
  annotations: WRITE,
}, async (a) => {
  if (!a.content && !a.embeds?.length && !a.poll) throw new Error("Pass content, embeds or poll.");
  const m = (await rest().post(Routes.channelMessages(a.channelId), {
    body: {
      content: a.content, embeds: a.embeds?.map(toEmbed), poll: toPoll(a.poll), components: toButtons(a.linkButtons),
      message_reference: a.replyToMessageId ? { message_id: a.replyToMessageId, fail_if_not_exists: false } : undefined,
      allowed_mentions: mentions(a.allowMentions),
    },
  })) as Msg;
  if (a.pin) await rest().put(Routes.channelPin(a.channelId, m.id));
  return `Sent: ${m.id}`;
});

def("edit_message", {
  description: "Edit a message the bot sent. Replaces content and embeds with what you pass.",
  inputSchema: {
    channelId: z.string(), messageId: z.string(), content: z.string().max(2000).optional(),
    embeds: z.array(embed).max(10).optional(), allowMentions,
  },
  annotations: EDIT,
}, async (a) => {
  await rest().patch(Routes.channelMessage(a.channelId, a.messageId), {
    body: { content: a.content, embeds: a.embeds?.map(toEmbed), allowed_mentions: mentions(a.allowMentions) },
  });
  return "Edited";
});

def("delete_message", {
  description: "Delete a message. Cannot be undone.",
  inputSchema: { channelId: z.string(), messageId: z.string() },
  annotations: DESTRUCTIVE,
}, async (a) => {
  await rest().delete(Routes.channelMessage(a.channelId, a.messageId));
  return "Deleted";
});

def("pin_message", {
  description: "Pin or unpin a message.",
  inputSchema: { channelId: z.string(), messageId: z.string(), pinned: z.boolean().default(true) },
  annotations: EDIT,
}, async (a) => {
  await rest()[a.pinned ? "put" : "delete"](Routes.channelPin(a.channelId, a.messageId));
  return a.pinned ? "Pinned" : "Unpinned";
});

def("get_messages", {
  description: "Read recent messages in a channel, newest first (ID, author, text). Needs Read Message History.",
  inputSchema: { channelId: z.string(), limit: z.number().int().min(1).max(50).default(10), before: z.string().optional().describe("Message ID to read older messages from") },
  annotations: READ,
}, async (a) => {
  const query = new URLSearchParams({ limit: String(a.limit) });
  if (a.before) query.set("before", a.before);
  const ms = (await rest().get(Routes.channelMessages(a.channelId), { query })) as Msg[];
  return ms.map((m) => `${m.id} ${m.author.username}${m.pinned ? " (pinned)" : ""}: ${m.content}${m.embeds?.length ? ` [${m.embeds.length} embed(s)]` : ""}`).join("\n") || "(no messages)";
});

// ---------- Reactions ----------

/** Unicode emoji as is, or a custom emoji as name:id (see list_emojis). */
const emojiParam = z.string().describe("A unicode emoji, or name:id for a custom emoji");
const enc = encodeURIComponent;

def("add_reaction", {
  description: "Add a reaction to a message as the bot. Needs Add Reactions and Read Message History.",
  inputSchema: { channelId: z.string(), messageId: z.string(), emoji: emojiParam },
  annotations: EDIT,
}, async (a) => {
  await rest().put(Routes.channelMessageOwnReaction(a.channelId, a.messageId, enc(a.emoji)));
  return `Reacted ${a.emoji}`;
});

def("remove_reaction", {
  description:
    "Remove reactions from a message. With emoji and no userId: the bot's own reaction. With emoji and userId: that user's. " +
    "With emoji and all=true: everyone's reaction of that emoji. With only all=true: every reaction on the message (needs Manage Messages).",
  inputSchema: {
    channelId: z.string(), messageId: z.string(), emoji: emojiParam.optional(), userId: z.string().optional(), all: z.boolean().default(false),
  },
  annotations: DESTRUCTIVE,
}, async (a) => {
  if (!a.emoji) {
    if (!a.all) throw new Error("Pass emoji, or all=true to clear every reaction.");
    await rest().delete(Routes.channelMessageAllReactions(a.channelId, a.messageId));
    return "Removed all reactions";
  }
  if (a.all) await rest().delete(Routes.channelMessageReaction(a.channelId, a.messageId, enc(a.emoji)));
  else await rest().delete(Routes.channelMessageUserReaction(a.channelId, a.messageId, enc(a.emoji), a.userId ?? "@me"));
  return "Removed";
});

// ---------- Purge ----------

def("purge_messages", {
  description:
    "Delete many messages at once. Looks at the newest `scan` messages (up to 500), keeps those matching the filters, and deletes them. " +
    "Discord only bulk-deletes messages under 14 days old; older matches are reported and left. Pinned messages are kept unless includePinned. Needs Manage Messages. " +
    "Defaults to dryRun (counts only). Deleted messages cannot be restored.",
  inputSchema: {
    channelId: z.string(), scan: z.number().int().min(1).max(500).default(100),
    fromUserId: z.string().optional(), contains: z.string().optional().describe("Case-insensitive text the message must contain"),
    onlyBots: z.boolean().default(false), includePinned: z.boolean().default(false), dryRun: z.boolean().default(true),
  },
  annotations: DESTRUCTIVE,
}, async (a) => {
  const msgs: PurgeMsg[] = [];
  let before: string | undefined;
  while (msgs.length < a.scan) {
    const query = new URLSearchParams({ limit: String(Math.min(100, a.scan - msgs.length)) });
    if (before) query.set("before", before);
    const page = (await rest().get(Routes.channelMessages(a.channelId), { query })) as PurgeMsg[];
    if (!page.length) break;
    msgs.push(...page);
    before = page[page.length - 1]!.id;
    if (page.length < Number(query.get("limit"))) break;
  }
  const { recent, old, skippedPinned } = selectPurge(msgs, a);
  const lines = [
    `${a.dryRun ? "[dry-run]" : "[applied]"} scanned ${msgs.length}, matching ${recent.length + old.length}`,
    `deletable: ${recent.length}`,
    old.length ? `skipped (older than 14 days): ${old.length}` : "",
    skippedPinned ? `skipped (pinned): ${skippedPinned}` : "",
  ].filter(Boolean);
  if (!a.dryRun) {
    for (const ids of chunk(recent, 100)) {
      if (ids.length === 1) await rest().delete(Routes.channelMessage(a.channelId, ids[0]!));
      else await rest().post(Routes.channelBulkDelete(a.channelId), { body: { messages: ids } });
    }
  }
  return lines.join("\n");
});
