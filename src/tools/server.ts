import { AuditLogEvent, Routes } from "discord.js";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { z } from "zod";
import { guildOf, rest, snowflakeTime } from "../discord.ts";
import { DESTRUCTIVE, EDIT, READ, WRITE, def, guildId } from "../tool.ts";

type Obj = Record<string, unknown>;

def("list_guilds", {
  description: "List the servers (ID and name) the bot has joined.",
  inputSchema: {},
  annotations: READ,
}, async () => {
  const gs = (await rest().get(Routes.userGuilds())) as { id: string; name: string }[];
  return gs.map((g) => `${g.name} ${g.id}`).join("\n") || "(the bot has not joined any server)";
});

def("get_guild_info", {
  description: "Show server settings: name, owner, member count, verification level, system/rules channels, features, boost tier.",
  inputSchema: { guildId },
  annotations: READ,
}, async (a) => {
  const g = (await rest().get(Routes.guild(guildOf(a.guildId)), { query: new URLSearchParams({ with_counts: "true" }) })) as Obj;
  const pick = ["name", "id", "owner_id", "description", "approximate_member_count", "verification_level",
    "default_message_notifications", "system_channel_id", "rules_channel_id", "public_updates_channel_id",
    "afk_channel_id", "afk_timeout", "preferred_locale", "premium_tier", "features"];
  return pick.map((k) => `${k}: ${JSON.stringify(g[k] ?? null)}`).join("\n");
});

def("edit_guild", {
  description:
    "Change server settings (only the fields you pass). verificationLevel: 0 none, 1 low, 2 medium, 3 high, 4 very high. " +
    "defaultMessageNotifications: 0 all messages, 1 only mentions. Channel settings take channel IDs. Needs Manage Server.",
  inputSchema: {
    guildId, name: z.string().min(2).max(100).optional(), description: z.string().max(120).optional(),
    verificationLevel: z.number().int().min(0).max(4).optional(),
    defaultMessageNotifications: z.number().int().min(0).max(1).optional(),
    systemChannelId: z.string().optional(), rulesChannelId: z.string().optional(),
    publicUpdatesChannelId: z.string().optional(), afkChannelId: z.string().optional(),
    afkTimeout: z.number().int().optional().describe("Seconds: 60, 300, 900, 1800 or 3600"),
  },
  annotations: EDIT,
}, async (a) => {
  const g = (await rest().patch(Routes.guild(guildOf(a.guildId)), {
    body: {
      name: a.name, description: a.description, verification_level: a.verificationLevel,
      default_message_notifications: a.defaultMessageNotifications, system_channel_id: a.systemChannelId,
      rules_channel_id: a.rulesChannelId, public_updates_channel_id: a.publicUpdatesChannelId,
      afk_channel_id: a.afkChannelId, afk_timeout: a.afkTimeout,
    },
  })) as Obj;
  return `Updated: ${g.name}`;
});

// ---------- Emojis ----------

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

/** Read an image from a URL or local path as a data URI. */
async function toDataUri(src: string): Promise<string> {
  if (src.startsWith("data:")) return src;
  let bytes: Buffer, mime: string | undefined;
  if (/^https?:\/\//.test(src)) {
    const r = await fetch(src);
    if (!r.ok) throw new Error(`Could not download the image (${r.status})`);
    bytes = Buffer.from(await r.arrayBuffer());
    mime = r.headers.get("content-type")?.split(";")[0] ?? MIME[extname(new URL(src).pathname).toLowerCase()];
  } else {
    bytes = await readFile(src);
    mime = MIME[extname(src).toLowerCase()];
  }
  if (!mime?.startsWith("image/")) throw new Error("Unsupported image type (use png, jpg, gif or webp)");
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

def("list_emojis", {
  description: "List custom emojis (ID, name, animated).",
  inputSchema: { guildId },
  annotations: READ,
}, async (a) =>
  ((await rest().get(Routes.guildEmojis(guildOf(a.guildId)))) as { id: string; name: string; animated?: boolean }[])
    .map((e) => `${e.name} ${e.id}${e.animated ? " (animated)" : ""}`).join("\n") || "(no custom emojis)");

def("create_emoji", {
  description: "Add a custom emoji from an image URL or local file path (png, jpg, gif, webp; Discord limits the size to 256 KB). Needs Create Expressions.",
  inputSchema: { guildId, name: z.string().min(2).max(32), image: z.string().describe("URL or absolute file path") },
  annotations: WRITE,
}, async (a) => {
  const e = (await rest().post(Routes.guildEmojis(guildOf(a.guildId)), { body: { name: a.name, image: await toDataUri(a.image) } })) as { id: string; name: string };
  return `Created: ${e.name} ${e.id}`;
});

def("delete_emoji", {
  description: "Delete a custom emoji.",
  inputSchema: { guildId, emojiId: z.string() },
  annotations: DESTRUCTIVE,
}, async (a) => {
  await rest().delete(Routes.guildEmoji(guildOf(a.guildId), a.emojiId));
  return "Deleted";
});

// ---------- Invites ----------

def("list_invites", {
  description: "List active invites (code, channel, uses, expiry). Needs Manage Server.",
  inputSchema: { guildId },
  annotations: READ,
}, async (a) =>
  ((await rest().get(Routes.guildInvites(guildOf(a.guildId)))) as { code: string; channel?: { name: string }; uses?: number; max_uses?: number; expires_at?: string | null }[])
    .map((i) => `${i.code} #${i.channel?.name ?? "?"} uses=${i.uses ?? 0}/${i.max_uses || "unlimited"} expires=${i.expires_at ?? "never"}`).join("\n") || "(no invites)");

def("create_invite", {
  description: "Create an invite link for a channel. maxAge in seconds (0 = never expires), maxUses 0 = unlimited.",
  inputSchema: {
    channelId: z.string(), maxAge: z.number().int().min(0).max(604800).default(86400),
    maxUses: z.number().int().min(0).max(100).default(0), temporary: z.boolean().default(false),
  },
  annotations: WRITE,
}, async (a) => {
  const i = (await rest().post(Routes.channelInvites(a.channelId), {
    body: { max_age: a.maxAge, max_uses: a.maxUses, temporary: a.temporary, unique: true },
  })) as { code: string };
  return `https://discord.gg/${i.code}`;
});

def("delete_invite", {
  description: "Revoke an invite by its code.",
  inputSchema: { code: z.string() },
  annotations: DESTRUCTIVE,
}, async (a) => {
  await rest().delete(Routes.invite(a.code));
  return "Revoked";
});

// ---------- Webhooks ----------

def("list_webhooks", {
  description: "List webhooks of a channel, or of the whole server when channelId is omitted. Tokens are not shown. Needs Manage Webhooks.",
  inputSchema: { guildId, channelId: z.string().optional() },
  annotations: READ,
}, async (a) =>
  ((await rest().get(a.channelId ? Routes.channelWebhooks(a.channelId) : Routes.guildWebhooks(guildOf(a.guildId)))) as { id: string; name: string; channel_id: string }[])
    .map((w) => `${w.name} ${w.id} channel=${w.channel_id}`).join("\n") || "(no webhooks)");

def("create_webhook", {
  description: "Create a webhook in a channel. The returned URL contains a secret token: treat it like a password.",
  inputSchema: { channelId: z.string(), name: z.string().min(1).max(80) },
  annotations: WRITE,
}, async (a) => {
  const w = (await rest().post(Routes.channelWebhooks(a.channelId), { body: { name: a.name } })) as { id: string; token: string };
  return `Created: ${w.id}\nhttps://discord.com/api/webhooks/${w.id}/${w.token}`;
});

def("delete_webhook", {
  description: "Delete a webhook.",
  inputSchema: { webhookId: z.string() },
  annotations: DESTRUCTIVE,
}, async (a) => {
  await rest().delete(Routes.webhook(a.webhookId));
  return "Deleted";
});

// ---------- Scheduled events ----------

const EVENT_TYPE = { stage: 1, voice: 2, external: 3 } as const;

def("list_events", {
  description: "List scheduled events (ID, name, start time, status).",
  inputSchema: { guildId },
  annotations: READ,
}, async (a) =>
  ((await rest().get(Routes.guildScheduledEvents(guildOf(a.guildId)))) as { id: string; name: string; scheduled_start_time: string; status: number }[])
    .map((e) => `${e.name} ${e.id} start=${e.scheduled_start_time} status=${e.status}`).join("\n") || "(no events)");

def("create_event", {
  description:
    "Create a scheduled event. kind=voice or stage needs channelId. kind=external needs location and endTime. Times are ISO 8601, e.g. 2026-12-01T19:00:00+09:00. Needs Manage Events.",
  inputSchema: {
    guildId, name: z.string().max(100), kind: z.enum(["voice", "stage", "external"]),
    startTime: z.string(), endTime: z.string().optional(), description: z.string().max(1000).optional(),
    channelId: z.string().optional(), location: z.string().max(100).optional(),
  },
  annotations: WRITE,
}, async (a) => {
  if (a.kind === "external" && (!a.location || !a.endTime)) throw new Error("kind=external needs location and endTime.");
  if (a.kind !== "external" && !a.channelId) throw new Error(`kind=${a.kind} needs channelId.`);
  const e = (await rest().post(Routes.guildScheduledEvents(guildOf(a.guildId)), {
    body: {
      name: a.name, description: a.description, privacy_level: 2, entity_type: EVENT_TYPE[a.kind],
      scheduled_start_time: new Date(a.startTime).toISOString(),
      scheduled_end_time: a.endTime ? new Date(a.endTime).toISOString() : undefined,
      channel_id: a.kind === "external" ? undefined : a.channelId,
      entity_metadata: a.kind === "external" ? { location: a.location } : undefined,
    },
  })) as { id: string; name: string };
  return `Created: ${e.name} ${e.id}`;
});

def("delete_event", {
  description: "Delete a scheduled event.",
  inputSchema: { guildId, eventId: z.string() },
  annotations: DESTRUCTIVE,
}, async (a) => {
  await rest().delete(Routes.guildScheduledEvent(guildOf(a.guildId), a.eventId));
  return "Deleted";
});

// ---------- Audit log ----------

def("get_audit_log", {
  description:
    "Read recent audit log entries (time, who, action, target, reason). Optional filters: userId, actionType (e.g. ChannelCreate, ChannelDelete, RoleUpdate, MemberKick). Needs View Audit Log.",
  inputSchema: { guildId, limit: z.number().int().min(1).max(100).default(20), userId: z.string().optional(), actionType: z.string().optional() },
  annotations: READ,
}, async (a) => {
  const query = new URLSearchParams({ limit: String(a.limit) });
  if (a.userId) query.set("user_id", a.userId);
  if (a.actionType) {
    const t = (AuditLogEvent as unknown as Record<string, number>)[a.actionType];
    if (t === undefined) throw new Error(`Unknown actionType: ${a.actionType}`);
    query.set("action_type", String(t));
  }
  const log = (await rest().get(Routes.guildAuditLog(guildOf(a.guildId)), { query })) as {
    audit_log_entries: { id: string; user_id: string | null; action_type: number; target_id: string | null; reason?: string }[];
    users: { id: string; username: string }[];
  };
  const name = (id: string | null) => log.users.find((u) => u.id === id)?.username ?? id ?? "?";
  return log.audit_log_entries.map((e) =>
    `${snowflakeTime(e.id)} ${name(e.user_id)} ${(AuditLogEvent as unknown as Record<number, string>)[e.action_type] ?? e.action_type}` +
    ` target=${e.target_id ?? "-"}${e.reason ? ` reason="${e.reason}"` : ""}`).join("\n") || "(no entries)";
});
