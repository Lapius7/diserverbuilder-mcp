import { ChannelType } from "discord.js";
import type { Ch } from "./discord.ts";

const DAY = 86_400_000;
const DISCORD_EPOCH = 1420070400000n;
export const snowflakeMs = (id: string) => Number((BigInt(id) >> 22n) + DISCORD_EPOCH);

/** Channels whose last message tells how active they are. Voice and stage channels are left out: their chat is rarely the point. */
const WATCHED = new Set<number>([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia]);
export const isWatched = (c: Ch) => WATCHED.has(c.type);

export interface Activity {
  channel: Ch;
  /** ms since epoch of the newest message (forum/media: newest post). For a channel that never had one, the time it was created. */
  at: number;
  /** "never" = no message was ever sent, so `at` is the creation time. */
  kind: "message" | "post" | "never";
  idleDays: number;
}

export function lastActivity(c: Ch, now = Date.now()): Activity {
  const forum = c.type === ChannelType.GuildForum || c.type === ChannelType.GuildMedia;
  const never = !c.last_message_id;
  const at = snowflakeMs(never ? c.id : c.last_message_id!);
  return { channel: c, at, kind: never ? "never" : forum ? "post" : "message", idleDays: Math.max(0, Math.floor((now - at) / DAY)) };
}

/** Channels with no activity for at least `days`, longest idle first. */
export function inactiveChannels(chs: Ch[], days: number, now = Date.now()): Activity[] {
  return chs.filter(isWatched).map((c) => lastActivity(c, now)).filter((a) => a.idleDays >= days).sort((a, b) => a.at - b.at);
}

export interface MessageLite { id: string; author: { id: string; username: string; bot?: boolean } }
export interface Sample { messages: number; posters: Map<string, { name: string; count: number }> }

/** Count the messages newer than `sinceMs` and who wrote them. Bots are counted separately and left out of posters. */
export function summarizeMessages(msgs: MessageLite[], sinceMs: number): Sample & { bots: number } {
  const posters = new Map<string, { name: string; count: number }>();
  let messages = 0, bots = 0;
  for (const m of msgs) {
    if (snowflakeMs(m.id) < sinceMs) continue;
    messages++;
    if (m.author.bot) { bots++; continue; }
    const p = posters.get(m.author.id) ?? { name: m.author.username, count: 0 };
    p.count++;
    posters.set(m.author.id, p);
  }
  return { messages, posters, bots };
}

export const topPosters = (posters: Map<string, { name: string; count: number }>, n: number) =>
  [...posters.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0])).slice(0, n);
