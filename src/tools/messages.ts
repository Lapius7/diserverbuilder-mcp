import { Routes } from "discord.js";
import { z } from "zod";
import { rest } from "../discord.ts";
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

/** Mentions are suppressed unless explicitly allowed, so an AI-written message cannot ping @everyone by accident. */
const mentions = (allow?: boolean) => (allow ? undefined : { parse: [] as string[] });
const allowMentions = z.boolean().default(false).describe("Allow @everyone/@role/@user mentions to notify. Default false.");

type Msg = { id: string; content: string; author: { username: string }; pinned?: boolean; embeds?: unknown[] };

def("send_message", {
  description: "Send a message (text and/or embeds) to a channel as the bot. Mentions do not notify unless allowMentions=true. Optionally pin it.",
  inputSchema: {
    channelId: z.string(), content: z.string().max(2000).optional(), embeds: z.array(embed).max(10).optional(),
    pin: z.boolean().default(false), allowMentions,
  },
  annotations: WRITE,
}, async (a) => {
  if (!a.content && !a.embeds?.length) throw new Error("Pass content or embeds.");
  const m = (await rest().post(Routes.channelMessages(a.channelId), {
    body: { content: a.content, embeds: a.embeds?.map(toEmbed), allowed_mentions: mentions(a.allowMentions) },
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
