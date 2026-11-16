import { ChannelType, PermissionFlagsBits, Routes } from "discord.js";
import { z } from "zod";
import { auditPermissions, can, computePermissions } from "../access.ts";
import { KIND_BY_TYPE, getChannels, getRoles, guildOf, permNames, resolveRole, rest, type Ch, type Member } from "../discord.ts";
import { READ, def, guildId } from "../tool.ts";

const VOICE = new Set<number>([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);
const names = (bits: bigint) => permNames(bits).join(", ") || "-";

def("check_access", {
  description:
    "Work out what a member or a role can really do, following Discord's rules: server owner and Administrator bypass everything, " +
    "then @everyone and role permissions, then the channel's overwrites (@everyone, then roles, then the member). " +
    "Pass userId for a member (their roles, owner status and timeout are looked up; no Server Members Intent needed) or role (name or ID) to test @everyone plus that one role. " +
    "With channelId it lists the effective permissions in that channel. Without it, it checks `permissions` (default: ViewChannel and SendMessages for text, ViewChannel, Connect and Speak for voice) in every channel. " +
    "Overwrites on a category are not inherited by its channels here: each channel's own overwrites are what Discord applies, so sync_permissions copies them.",
  inputSchema: {
    guildId,
    userId: z.string().optional().describe("A member's user ID"),
    role: z.string().optional().describe("A role name or ID, instead of userId"),
    channelId: z.string().optional(),
    permissions: z.array(z.string()).optional().describe("Permission names to check in every channel, e.g. ManageMessages"),
  },
  annotations: READ,
}, async (a) => {
  const g = guildOf(a.guildId);
  if (!!a.userId === !!a.role) throw new Error("Pass exactly one of userId or role.");
  for (const p of a.permissions ?? []) if (!(p in PermissionFlagsBits)) throw new Error(`Unknown permission name: ${p}`);
  const roles = await getRoles(g);
  const head: string[] = [];
  let input: { roleIds: string[]; userId?: string; ownerId?: string; timedOut?: boolean };
  if (a.userId) {
    const [guild, m] = await Promise.all([rest().get(Routes.guild(g)) as Promise<{ owner_id?: string }>, rest().get(Routes.guildMember(g, a.userId)) as Promise<Member>]);
    const until = m.communication_disabled_until ? Date.parse(m.communication_disabled_until) : 0;
    input = { roleIds: m.roles, userId: a.userId, ownerId: guild.owner_id, timedOut: until > Date.now() };
    head.push(`member ${m.nick ?? m.user.global_name ?? m.user.username} (${a.userId})`);
    if (a.userId === guild.owner_id) head.push("server owner: every permission, overwrites do not apply");
    if (input.timedOut) head.push(`timed out until ${m.communication_disabled_until}: only ViewChannel and ReadMessageHistory work`);
  } else {
    const id = resolveRole(g, roles, a.role!);
    input = { roleIds: id === g ? [] : [id] };
    head.push(`role ${id === g ? "@everyone" : roles.find((r) => r.id === id)?.name} (${id}), plus @everyone`);
  }
  const base = { guildId: g, roles, ...input };
  if (a.channelId) {
    const c = (await rest().get(Routes.channel(a.channelId))) as Ch;
    if (c.guild_id !== g) throw new Error(`Channel ${a.channelId} does not belong to server ${g}.`);
    const p = computePermissions({ ...base, channel: c });
    return [...head, `in #${c.name} [${KIND_BY_TYPE[c.type] ?? c.type}]:`, p ? names(p) : "no access (cannot view the channel)"].join("\n");
  }
  const server = computePermissions(base);
  const lines = (await getChannels(g)).filter((c) => c.type !== ChannelType.GuildCategory)
    .sort((x, y) => x.position - y.position || x.id.localeCompare(y.id)).map((c) => {
      const p = computePermissions({ ...base, channel: c });
      const want = (a.permissions ?? (VOICE.has(c.type) ? ["ViewChannel", "Connect", "Speak"] : ["ViewChannel", "SendMessages"])) as (keyof typeof PermissionFlagsBits)[];
      return `#${c.name} [${KIND_BY_TYPE[c.type] ?? c.type}] ${c.id}: ` + want.map((n) => `${n} ${can(p, n) ? "yes" : "no"}`).join(", ");
    });
  return [...head, `server-wide: ${names(server)}`, "", ...lines].join("\n");
});

def("audit_permissions", {
  description:
    "Read-only security review of roles and channel permissions. Reports, most serious first: @everyone or roles that hold Administrator or other powerful permissions " +
    "(Manage Server/Roles/Channels/Webhooks, Ban/Kick/Timeout, Manage Messages, Mention Everyone, ...), roles that share a name, overwrites pointing at deleted roles, " +
    "channels made public inside a private category, and whether the bot's role can manage the others. An empty result means nothing was found. Changes nothing.",
  inputSchema: { guildId },
  annotations: READ,
}, async (a) => {
  const g = guildOf(a.guildId);
  const [roles, channels] = await Promise.all([getRoles(g), getChannels(g)]);
  let botRoleIds: string[] | undefined;
  let note = "";
  try {
    const me = (await rest().get(Routes.user())) as { id: string };
    botRoleIds = ((await rest().get(Routes.guildMember(g, me.id))) as Member).roles;
  } catch { note = "\n(The bot's own roles could not be read, so the role-order check was skipped.)"; }
  const found = auditPermissions({ guildId: g, roles, channels, botRoleIds });
  return (found.length ? found.join("\n") : "Nothing found.") + note;
});
