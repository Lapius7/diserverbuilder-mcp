import { ChannelType, Routes } from "discord.js";
import { z } from "zod";
import { getChannels, guildOf, rest, type Ch } from "../discord.ts";
import { DESTRUCTIVE, EDIT, READ, WRITE, def, guildId } from "../tool.ts";

interface Stage { id: string; channel_id: string; topic: string; privacy_level: number; guild_scheduled_event_id?: string | null }

/** The live stage in a channel, or undefined when none is running (Discord answers 404, code 10067). */
async function liveStage(channelId: string): Promise<Stage | undefined> {
  try {
    return (await rest().get(Routes.stageInstance(channelId))) as Stage;
  } catch (e) {
    if ((e as { status?: number }).status === 404) return undefined;
    throw e;
  }
}
const line = (s: Stage, name?: string) => `${name ? `#${name} ` : ""}channel ${s.channel_id}: "${s.topic}" (${s.privacy_level === 2 ? "server members only" : "public"})`;
const MODS = "Needs Manage Channels, Mute Members and Move Members on the stage channel";

def("get_stage", {
  description:
    "Show live stages (a stage channel with a running topic). With channelId it checks that one channel; without, it checks every stage channel in the server, one request each, because Discord has no list endpoint. " +
    "Stage channels with nothing running are listed as not live.",
  inputSchema: { guildId, channelId: z.string().optional() },
  annotations: READ,
}, async (a) => {
  if (a.channelId) {
    const s = await liveStage(a.channelId);
    return s ? line(s) : "Not live: no stage is running in that channel.";
  }
  const stages = (await getChannels(guildOf(a.guildId))).filter((c) => c.type === ChannelType.GuildStageVoice);
  if (!stages.length) return "(no stage channels)";
  const out: string[] = [];
  for (const c of stages) {
    const s = await liveStage(c.id);
    out.push(s ? `LIVE ${line(s, c.name)}` : `not live: #${c.name} ${c.id}`);
  }
  return out.join("\n");
});

def("start_stage", {
  description:
    `Start a live stage in a stage channel with a topic (1-120 characters). Visible to server members only. ${MODS}. ` +
    "notifyEveryone=true pings @everyone and also needs Mention Everyone. Fails if a stage is already running there (use edit_stage).",
  inputSchema: { channelId: z.string(), topic: z.string().min(1).max(120), notifyEveryone: z.boolean().default(false) },
  annotations: WRITE,
}, async (a) => {
  const c = (await rest().get(Routes.channel(a.channelId))) as Ch;
  if (c.type !== ChannelType.GuildStageVoice) throw new Error(`#${c.name} is not a stage channel. Create one with create_channel type "stage".`);
  const s = (await rest().post(Routes.stageInstances(), {
    body: { channel_id: a.channelId, topic: a.topic, privacy_level: 2, send_start_notification: a.notifyEveryone },
  })) as Stage;
  return `Started: ${line(s, c.name)}`;
});

def("edit_stage", {
  description: `Change the topic of a live stage. ${MODS}. Fails if no stage is running there.`,
  inputSchema: { channelId: z.string(), topic: z.string().min(1).max(120) },
  annotations: EDIT,
}, async (a) => {
  if (!(await liveStage(a.channelId))) throw new Error("No stage is running in that channel. Use start_stage.");
  const s = (await rest().patch(Routes.stageInstance(a.channelId), { body: { topic: a.topic } })) as Stage;
  return `Updated: ${line(s)}`;
});

def("end_stage", {
  description: `End a live stage. The channel itself stays. ${MODS}. confirmTopic must match the running topic exactly, so the wrong stage is never ended.`,
  inputSchema: { channelId: z.string(), confirmTopic: z.string() },
  annotations: DESTRUCTIVE,
}, async (a) => {
  const s = await liveStage(a.channelId);
  if (!s) return "Nothing to end: no stage is running in that channel.";
  if (s.topic !== a.confirmTopic) throw new Error(`Topic mismatch (running: "${s.topic}"). Nothing ended.`);
  await rest().delete(Routes.stageInstance(a.channelId));
  return `Ended: "${s.topic}"`;
});
