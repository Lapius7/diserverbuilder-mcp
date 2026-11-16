import { Routes } from "discord.js";
import { z } from "zod";
import { inactiveChannels, isWatched, lastActivity, summarizeMessages, topPosters, type MessageLite } from "../analytics.ts";
import { KIND_BY_TYPE, getChannels, guildOf, rest } from "../discord.ts";
import { READ, def, guildId } from "../tool.ts";

const MAX_SAMPLE_CHANNELS = 25;
const label = (k: string) => (k === "never" ? "never had a message" : k === "post" ? "newest post" : "last message");

def("inactive_channels", {
  description:
    "List text, announcement, forum and media channels with no activity for at least `days` days, longest idle first. " +
    "It reads each channel's newest message ID, so it costs one request in total and shows no message content. " +
    "Forum and media channels show their newest post. A channel that never had a message is dated from its creation and marked \"never\". " +
    "Voice and stage channels are not judged. Use it to find channels to archive or delete; it deletes nothing.",
  inputSchema: { guildId, days: z.number().int().min(1).max(3650).default(30) },
  annotations: READ,
}, async (a) => {
  const g = guildOf(a.guildId);
  const chs = await getChannels(g);
  const idle = inactiveChannels(chs, a.days);
  const total = chs.filter(isWatched).length;
  if (!idle.length) return `All ${total} channel(s) had activity in the last ${a.days} day(s).`;
  return [
    `${idle.length} of ${total} channel(s) idle for ${a.days}+ days:`,
    ...idle.map((x) => `#${x.channel.name} [${KIND_BY_TYPE[x.channel.type]}] ${x.channel.id}: ${x.idleDays} days (${label(x.kind)} ${new Date(x.at).toISOString().slice(0, 10)})`),
  ].join("\n");
});

def("activity_report", {
  description:
    "Summarize how active the server is. Always: approximate member and online counts (no intent needed), channel counts, and the most and least recently active channels (from newest message IDs, cheap). " +
    `With sampleDays set it also reads up to the latest 100 messages in each of at most ${MAX_SAMPLE_CHANNELS} of the busiest channels and reports message counts and top posters over that period. ` +
    "That sample is capped, so counts in busy channels are lower bounds. Message text is never returned. Needs Read Message History for the sampled channels; channels the bot cannot read are skipped and listed.",
  inputSchema: {
    guildId,
    sampleDays: z.number().int().min(1).max(90).optional().describe("Also sample messages from the last N days"),
    top: z.number().int().min(1).max(25).default(5).describe("How many channels and posters to list"),
  },
  annotations: READ,
}, async (a) => {
  const g = guildOf(a.guildId);
  const [guild, chs] = await Promise.all([
    rest().get(Routes.guild(g), { query: new URLSearchParams({ with_counts: "true" }) }) as Promise<{ name: string; approximate_member_count?: number; approximate_presence_count?: number }>,
    getChannels(g),
  ]);
  const watched = chs.filter(isWatched).map((c) => lastActivity(c)).sort((x, y) => y.at - x.at);
  const out = [
    `${guild.name}: ${guild.approximate_member_count ?? "?"} members (about ${guild.approximate_presence_count ?? "?"} online), ${chs.length} channels incl. categories`,
    `Most recently active:`, ...watched.filter((x) => x.kind !== "never").slice(0, a.top).map((x) => `  #${x.channel.name}: ${x.idleDays} day(s) ago (${label(x.kind)})`),
    `Least recently active:`, ...[...watched].reverse().slice(0, a.top).map((x) => `  #${x.channel.name}: ${x.kind === "never" ? `never had a message (created ${x.idleDays} day(s) ago)` : `${x.idleDays} day(s) ago (${label(x.kind)})`}`),
  ];
  if (a.sampleDays) {
    const since = Date.now() - a.sampleDays * 86_400_000;
    const pool = watched.filter((x) => x.kind === "message" && x.at >= since).slice(0, MAX_SAMPLE_CHANNELS);
    const posters = new Map<string, { name: string; count: number }>();
    const perChannel: { name: string; n: number; capped: boolean }[] = [];
    const skipped: string[] = [];
    let bots = 0;
    for (const x of pool) {
      try {
        const msgs = (await rest().get(Routes.channelMessages(x.channel.id), { query: new URLSearchParams({ limit: "100" }) })) as MessageLite[];
        const s = summarizeMessages(msgs, since);
        bots += s.bots;
        for (const [id, p] of s.posters) { const cur = posters.get(id); if (cur) cur.count += p.count; else posters.set(id, { ...p }); }
        perChannel.push({ name: x.channel.name, n: s.messages, capped: msgs.length === 100 && s.messages === 100 });
      } catch { skipped.push(x.channel.name); }
    }
    const total = perChannel.reduce((n, c) => n + c.n, 0);
    out.push(
      `Sample, last ${a.sampleDays} day(s), ${pool.length} channel(s), max 100 messages each: ${total} messages (${bots} from bots)`,
      ...perChannel.sort((x, y) => y.n - x.n).slice(0, a.top).map((c) => `  #${c.name}: ${c.n}${c.capped ? "+" : ""}`),
      "Top posters:", ...topPosters(posters, a.top).map(([id, p]) => `  ${p.name} (${id}): ${p.count}`),
    );
    if (watched.filter((x) => x.kind === "message" && x.at >= since).length > MAX_SAMPLE_CHANNELS) out.push(`(Only the ${MAX_SAMPLE_CHANNELS} most recently active channels were sampled.)`);
    if (skipped.length) out.push(`Skipped (no access): ${skipped.join(", ")}`);
  }
  return out.join("\n");
});
