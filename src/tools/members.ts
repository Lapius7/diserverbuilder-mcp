import { Routes } from "discord.js";
import { z } from "zod";
import { getAllMembers, getRoles, guildOf, resolveRole, rest, type Member } from "../discord.ts";
import { DESTRUCTIVE, EDIT, READ, def, guildId } from "../tool.ts";

const reason = z.string().max(512).optional().describe("Shown in the server's audit log");
const who = (m: Member) => `${m.nick ?? m.user.global_name ?? m.user.username} (@${m.user.username}) ${m.user.id}`;

def("get_member", {
  description: "Show one member: names, roles, join date, timeout, nickname.",
  inputSchema: { guildId, userId: z.string() },
  annotations: READ,
}, async (a) => {
  const g = guildOf(a.guildId);
  const m = (await rest().get(Routes.guildMember(g, a.userId))) as Member;
  const roles = await getRoles(g);
  const names = m.roles.map((id) => roles.find((r) => r.id === id)?.name ?? id);
  return [
    who(m), `roles: ${names.join(", ") || "-"}`, `joined: ${m.joined_at ?? "?"}`,
    `timeout until: ${m.communication_disabled_until ?? "-"}`, `bot: ${m.user.bot ? "yes" : "no"}`,
  ].join("\n");
});

def("list_role_members", {
  description: "List the members who have a role (name or ID). Needs the Server Members Intent turned on for the bot in the Developer Portal.",
  inputSchema: { guildId, role: z.string().describe("Role name or ID"), limit: z.number().int().min(1).max(500).default(100) },
  annotations: READ,
}, async (a) => {
  const g = guildOf(a.guildId);
  const roleId = resolveRole(g, await getRoles(g), a.role);
  const hits = (await getAllMembers(g)).filter((m) => (roleId === g ? true : m.roles.includes(roleId)));
  const shown = hits.slice(0, a.limit).map(who).join("\n");
  return `${hits.length} member(s)\n${shown}${hits.length > a.limit ? `\n... and ${hits.length - a.limit} more` : ""}`;
});

def("kick_member", {
  description: "Kick a member from the server. They can rejoin with an invite. Needs Kick Members and a role above the member's.",
  inputSchema: { guildId, userId: z.string(), reason },
  annotations: DESTRUCTIVE,
}, async (a) => {
  await rest().delete(Routes.guildMember(guildOf(a.guildId), a.userId), { reason: a.reason });
  return `Kicked ${a.userId}`;
});

def("ban_member", {
  description:
    "Ban a user (they need not be in the server). deleteMessageSeconds also deletes their recent messages (0 to 604800 = 7 days). Needs Ban Members and a role above the member's.",
  inputSchema: { guildId, userId: z.string(), deleteMessageSeconds: z.number().int().min(0).max(604800).default(0), reason },
  annotations: DESTRUCTIVE,
}, async (a) => {
  await rest().put(Routes.guildBan(guildOf(a.guildId), a.userId), {
    body: { delete_message_seconds: a.deleteMessageSeconds }, reason: a.reason,
  });
  return `Banned ${a.userId}`;
});

def("unban_member", {
  description: "Lift a ban.",
  inputSchema: { guildId, userId: z.string(), reason },
  annotations: EDIT,
}, async (a) => {
  await rest().delete(Routes.guildBan(guildOf(a.guildId), a.userId), { reason: a.reason });
  return `Unbanned ${a.userId}`;
});

def("list_bans", {
  description: "List bans (user, reason), 1000 at most per call. Pass after (a user ID from the last row) for the next page.",
  inputSchema: { guildId, limit: z.number().int().min(1).max(1000).default(50), after: z.string().optional() },
  annotations: READ,
}, async (a) => {
  const query = new URLSearchParams({ limit: String(a.limit) });
  if (a.after) query.set("after", a.after);
  const bans = (await rest().get(Routes.guildBans(guildOf(a.guildId)), { query })) as { user: { id: string; username: string }; reason?: string | null }[];
  return bans.map((b) => `@${b.user.username} ${b.user.id}${b.reason ? ` reason="${b.reason}"` : ""}`).join("\n") || "(no bans)";
});

def("timeout_member", {
  description: "Time a member out (they cannot talk, react or join voice) for the given minutes, up to 28 days (40320). minutes=0 lifts the timeout. Needs Moderate Members.",
  inputSchema: { guildId, userId: z.string(), minutes: z.number().int().min(0).max(40320), reason },
  annotations: EDIT,
}, async (a) => {
  const until = a.minutes ? new Date(Date.now() + a.minutes * 60_000).toISOString() : null;
  await rest().patch(Routes.guildMember(guildOf(a.guildId), a.userId), { body: { communication_disabled_until: until }, reason: a.reason });
  return until ? `Timed out ${a.userId} until ${until}` : `Timeout lifted for ${a.userId}`;
});

def("set_nickname", {
  description: "Change a member's nickname (empty string clears it). Use userId \"@me\" for the bot itself. Needs Manage Nicknames.",
  inputSchema: { guildId, userId: z.string(), nickname: z.string().max(32), reason },
  annotations: EDIT,
}, async (a) => {
  await rest().patch(Routes.guildMember(guildOf(a.guildId), a.userId), { body: { nick: a.nickname || null }, reason: a.reason });
  return a.nickname ? `Nickname set to ${a.nickname}` : "Nickname cleared";
});

def("move_member", {
  description: "Move a member who is in a voice channel to another voice channel, or disconnect them (channelId omitted). Needs Move Members.",
  inputSchema: { guildId, userId: z.string(), channelId: z.string().optional().describe("Target voice channel. Omit to disconnect.") },
  annotations: EDIT,
}, async (a) => {
  await rest().patch(Routes.guildMember(guildOf(a.guildId), a.userId), { body: { channel_id: a.channelId ?? null } });
  return a.channelId ? `Moved ${a.userId}` : `Disconnected ${a.userId}`;
});

