import { PermissionFlagsBits, Routes } from "discord.js";
import { z } from "zod";
import { planDisableCommunity, planEnableCommunity, type GuildCfg } from "../community.ts";
import { getChannels, getRoles, guildOf, resolveRole, rest } from "../discord.ts";
import { botPermissions } from "../roles.ts";
import { DESTRUCTIVE, EDIT, READ, def, guildId } from "../tool.ts";

type Obj = Record<string, unknown>;

const optionSchema = z.object({
  title: z.string().max(50),
  description: z.string().max(100).optional(),
  emoji: z.string().optional().describe("A unicode emoji, e.g. 🎮"),
  roleIds: z.array(z.string()).max(20).optional().describe("Roles to give (names or IDs)"),
  channelIds: z.array(z.string()).max(20).optional().describe("Channels to show"),
});
const promptSchema = z.object({
  title: z.string().max(100),
  type: z.enum(["multiple_choice", "dropdown"]).default("multiple_choice"),
  singleSelect: z.boolean().default(false),
  required: z.boolean().default(false),
  inOnboarding: z.boolean().default(true).describe("Ask during onboarding (false = only in Channels & Roles)"),
  options: z.array(optionSchema).min(1).max(50),
});

def("get_onboarding", {
  description: "Show the server's onboarding: on/off, mode, default channels, and every question with its options.",
  inputSchema: { guildId },
  annotations: READ,
}, async (a) => {
  const g = guildOf(a.guildId);
  const [o, roles] = await Promise.all([rest().get(Routes.guildOnboarding(g)) as Promise<Obj>, getRoles(g)]);
  const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? id;
  const prompts = ((o.prompts as Obj[]) ?? []).map((p) =>
    `- ${p.title} [${p.type === 1 ? "dropdown" : "multiple_choice"}${p.single_select ? ", single" : ""}${p.required ? ", required" : ""}${p.in_onboarding ? "" : ", not in onboarding"}]\n` +
    ((p.options as Obj[]) ?? []).map((op) =>
      `    * ${(op.emoji as Obj | undefined)?.name ?? ""} ${op.title}${op.description ? ` (${op.description})` : ""}` +
      `${(op.role_ids as string[])?.length ? ` roles=[${(op.role_ids as string[]).map(roleName)}]` : ""}` +
      `${(op.channel_ids as string[])?.length ? ` channels=[${op.channel_ids}]` : ""}`).join("\n"));
  return [
    `enabled: ${o.enabled}`, `mode: ${o.mode === 1 ? "advanced" : "default"}`,
    `default channels: ${(o.default_channel_ids as string[])?.join(", ") || "-"}`, ...prompts,
  ].join("\n");
});

def("edit_onboarding", {
  description:
    "Change the server's onboarding (only the fields you pass). prompts replaces ALL questions (read them with get_onboarding first and pass the whole list). " +
    "Needs the Community feature. Discord requires default channels (several that @everyone can see) before onboarding can be enabled. Needs Manage Server and Manage Roles.",
  inputSchema: {
    guildId, enabled: z.boolean().optional(), mode: z.enum(["default", "advanced"]).optional(),
    defaultChannelIds: z.array(z.string()).optional(), prompts: z.array(promptSchema).optional(),
  },
  annotations: EDIT,
}, async (a) => {
  const g = guildOf(a.guildId);
  const cur = (await rest().get(Routes.guildOnboarding(g))) as Obj;
  const roles = a.prompts ? await getRoles(g) : [];
  const prompts = a.prompts?.map((p) => ({
    title: p.title, type: p.type === "dropdown" ? 1 : 0, single_select: p.singleSelect, required: p.required, in_onboarding: p.inOnboarding,
    options: p.options.map((o) => ({
      title: o.title, description: o.description ?? null, emoji_name: o.emoji, channel_ids: o.channelIds ?? [],
      role_ids: (o.roleIds ?? []).map((r) => resolveRole(g, roles, r)),
    })),
  }));
  // PUT replaces the whole object, so send back whatever was not changed.
  const body = {
    enabled: a.enabled ?? cur.enabled,
    mode: a.mode ? (a.mode === "advanced" ? 1 : 0) : cur.mode,
    default_channel_ids: a.defaultChannelIds ?? cur.default_channel_ids,
    prompts: prompts ?? cur.prompts,
  };
  const o = (await rest().put(Routes.guildOnboarding(g), { body })) as Obj;
  return `Onboarding updated: enabled=${o.enabled}, ${(o.prompts as unknown[])?.length ?? 0} question(s)`;
});

def("get_welcome_screen", {
  description: "Show the welcome screen: on/off, description and its channels.",
  inputSchema: { guildId },
  annotations: READ,
}, async (a) => {
  const w = (await rest().get(Routes.guildWelcomeScreen(guildOf(a.guildId)))) as Obj;
  const chans = ((w.welcome_channels as Obj[]) ?? []).map((c) => `- ${c.emoji_name ?? ""} ${c.channel_id}: ${c.description}`);
  return [`description: ${w.description ?? "-"}`, ...chans].join("\n") || "(no welcome screen)";
});

def("edit_welcome_screen", {
  description: "Change the welcome screen (only the fields you pass). welcomeChannels replaces the whole list (up to 5). Needs the Community feature and Manage Server.",
  inputSchema: {
    guildId, enabled: z.boolean().optional(), description: z.string().max(140).optional(),
    welcomeChannels: z.array(z.object({
      channelId: z.string(), description: z.string().max(50), emoji: z.string().optional().describe("A unicode emoji"),
    })).max(5).optional(),
  },
  annotations: EDIT,
}, async (a) => {
  const w = (await rest().patch(Routes.guildWelcomeScreen(guildOf(a.guildId)), {
    body: {
      enabled: a.enabled, description: a.description,
      welcome_channels: a.welcomeChannels?.map((c) => ({ channel_id: c.channelId, description: c.description, emoji_name: c.emoji })),
    },
  })) as Obj;
  return `Welcome screen updated (${(w.welcome_channels as unknown[])?.length ?? 0} channel(s))`;
});

def("enable_community", {
  description:
    "Turn the Community features on (needed for onboarding, the welcome screen and server discovery). " +
    "Discord requires a rules channel and a public updates channel (text channels), verification level at least 1 (low) and the explicit content filter set to scan all members; " +
    "this tool sets what is missing, so verification and the content filter can become stricter. Pass the channel IDs if the server has none set. " +
    "Defaults to dryRun, which lists what would change. Keeps every feature the server already has. Needs Administrator: the bot must hold it (a server owner can grant it to the bot role), and a real run is refused without it.",
  inputSchema: {
    guildId,
    rulesChannelId: z.string().optional().describe("Text channel for rules. Defaults to the server's current one."),
    publicUpdatesChannelId: z.string().optional().describe("Text channel for Discord's notices. Defaults to the server's current one."),
    dryRun: z.boolean().default(true),
  },
  annotations: DESTRUCTIVE,
}, async (a) => {
  const g = guildOf(a.guildId);
  const guild = (await rest().get(Routes.guild(g))) as GuildCfg;
  if (guild.features?.includes("COMMUNITY")) return "Already a Community server. Nothing to change.";
  const plan = planEnableCommunity(guild, await getChannels(g), { rulesChannelId: a.rulesChannelId, publicUpdatesChannelId: a.publicUpdatesChannelId });
  const mine = await botPermissions(g, await getRoles(g));
  if (mine !== undefined && !(mine & PermissionFlagsBits.Administrator)) {
    plan.problems.push("the bot does not have Administrator, which Discord requires to turn Community on: give the bot's role Administrator (only the server owner can), then try again");
  }
  if (plan.problems.length) return `Cannot enable Community yet:\n${plan.problems.map((p) => `! ${p}`).join("\n")}`;
  if (!a.dryRun) await rest().patch(Routes.guild(g), { body: plan.body });
  return `${a.dryRun ? "[dry-run]" : "[applied]"}\n${plan.changes.map((c) => `~ ${c}`).join("\n")}`;
});

def("disable_community", {
  description:
    "Turn the Community features off. Server discovery is removed with it, and the community-only features (onboarding, welcome screen) stop working until it is turned on again. " +
    "Channels, roles and settings stay. Defaults to dryRun. Needs Administrator.",
  inputSchema: { guildId, dryRun: z.boolean().default(true) },
  annotations: DESTRUCTIVE,
}, async (a) => {
  const g = guildOf(a.guildId);
  const plan = planDisableCommunity((await rest().get(Routes.guild(g))) as GuildCfg);
  if (!plan.body) return "Not a Community server. Nothing to change.";
  if (!a.dryRun) await rest().patch(Routes.guild(g), { body: plan.body });
  return `${a.dryRun ? "[dry-run]" : "[applied]"}\n${plan.changes.map((c) => `~ ${c}`).join("\n")}`;
});
