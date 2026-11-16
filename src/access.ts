import { ChannelType, PermissionFlagsBits as P } from "discord.js";
import { permNames, type Ch, type Overwrite, type Role } from "./discord.ts";

export const ALL_PERMS = Object.values(P).reduce((a, b) => a | b, 0n);

export interface AccessInput {
  guildId: string;
  ownerId?: string;
  roles: Role[];
  /** Role IDs the member has (without @everyone). For a role-only check, pass that one role. */
  roleIds: string[];
  /** Omit for a role-only check: member overwrites then do not apply. */
  userId?: string;
  channel?: Pick<Ch, "type" | "permission_overwrites">;
  /** A timed-out member keeps only View Channel and Read Message History. */
  timedOut?: boolean;
}

const TEXT_LIKE = new Set<number>([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
/** Bits that Discord removes from a text channel when Send Messages is missing. */
const NEEDS_SEND = P.MentionEveryone | P.SendTTSMessages | P.AttachFiles | P.EmbedLinks;

/** The permissions a member (or role) really has, in a channel or server-wide, in the order Discord documents. */
export function computePermissions(i: AccessInput): bigint {
  if (i.userId && i.userId === i.ownerId) return ALL_PERMS;
  const everyone = i.roles.find((r) => r.id === i.guildId);
  let perms = BigInt(everyone?.permissions ?? "0");
  for (const id of i.roleIds) {
    const r = i.roles.find((x) => x.id === id);
    if (r) perms |= BigInt(r.permissions);
  }
  if (perms & P.Administrator) return ALL_PERMS;
  if (i.channel) {
    const ows: Overwrite[] = i.channel.permission_overwrites ?? [];
    const apply = (o?: Overwrite) => { if (o) perms = (perms & ~BigInt(o.deny)) | BigInt(o.allow); };
    apply(ows.find((o) => o.type === 0 && o.id === i.guildId));
    let allow = 0n, deny = 0n;
    for (const o of ows) if (o.type === 0 && i.roleIds.includes(o.id)) { allow |= BigInt(o.allow); deny |= BigInt(o.deny); }
    perms = (perms & ~deny) | allow;
    if (i.userId) apply(ows.find((o) => o.type === 1 && o.id === i.userId));
    if (!(perms & P.ViewChannel)) return 0n;
    if (TEXT_LIKE.has(i.channel.type) && !(perms & P.SendMessages)) perms &= ~NEEDS_SEND;
  }
  if (i.timedOut) perms &= P.ViewChannel | P.ReadMessageHistory;
  return perms;
}

export const can = (perms: bigint, ...names: (keyof typeof P)[]) => names.every((n) => (perms & P[n]) === P[n]);

// ---------- Audit ----------

const HIGH = P.Administrator;
const MEDIUM = P.ManageGuild | P.ManageRoles | P.ManageChannels | P.ManageWebhooks | P.BanMembers | P.KickMembers | P.ModerateMembers | P.ManageMessages | P.MentionEveryone | P.ManageGuildExpressions | P.ManageNicknames | P.ViewAuditLog;

export interface AuditInput {
  guildId: string;
  roles: Role[];
  channels: Ch[];
  /** The bot's own role IDs (its member record), when known. */
  botRoleIds?: string[];
}

/** Things worth a human look. Each line starts with [high], [medium] or [info]; an empty list means nothing was found. */
export function auditPermissions(i: AuditInput): string[] {
  const out: { rank: number; line: string }[] = [];
  const add = (rank: number, tag: string, line: string) => out.push({ rank, line: `[${tag}] ${line}` });
  const roleName = (id: string) => (id === i.guildId ? "@everyone" : i.roles.find((r) => r.id === id)?.name ?? `role ${id}`);

  for (const r of i.roles) {
    const bits = BigInt(r.permissions);
    const high = bits & HIGH, mid = bits & MEDIUM;
    const who = r.id === i.guildId ? "@everyone" : `role ${r.name} (${r.id})`;
    if (r.managed) { if (high) add(2, "info", `${who} is managed by an integration and has Administrator`); continue; }
    if (r.id === i.guildId && (high || mid)) add(0, "high", `${who} grants ${permNames(high | mid).join(", ")} to every member`);
    else if (high) add(0, "high", `${who} has Administrator (bypasses every channel permission)`);
    else if (mid) add(1, "medium", `${who} can ${permNames(mid).join(", ")}`);
  }

  const byName = new Map<string, Role[]>();
  for (const r of i.roles) if (r.id !== i.guildId && !r.managed) byName.set(r.name.toLowerCase(), [...(byName.get(r.name.toLowerCase()) ?? []), r]);
  for (const rs of byName.values()) if (rs.length > 1) add(1, "medium", `${rs.length} roles share the name "${rs[0]!.name}" (${rs.map((r) => r.id).join(", ")}); tools that take names will ask for an ID`);

  const known = new Set(i.roles.map((r) => r.id));
  const cat = new Map(i.channels.map((c) => [c.id, c]));
  const viewDenied = (c?: Ch) => !!c?.permission_overwrites?.some((o) => o.type === 0 && o.id === i.guildId && (BigInt(o.deny) & P.ViewChannel));
  for (const c of i.channels) {
    for (const o of c.permission_overwrites ?? []) {
      if (o.type === 0 && o.id !== i.guildId && !known.has(o.id)) add(1, "medium", `#${c.name} has an overwrite for a role that no longer exists (${o.id}); clear_permissions removes it`);
    }
    const parent = c.parent_id ? cat.get(c.parent_id) : undefined;
    const own = c.permission_overwrites?.find((o) => o.type === 0 && o.id === i.guildId);
    if (parent && viewDenied(parent) && own && (BigInt(own.allow) & P.ViewChannel)) add(0, "high", `#${c.name} lets @everyone view it inside the private category ${parent.name}`);
  }

  if (i.botRoleIds) {
    const mine = i.roles.filter((r) => i.botRoleIds!.includes(r.id));
    const top = Math.max(0, ...mine.map((r) => r.position));
    const perms = mine.reduce((a, r) => a | BigInt(r.permissions), BigInt(i.roles.find((r) => r.id === i.guildId)?.permissions ?? "0"));
    if (!(perms & (P.Administrator | P.ManageRoles))) add(1, "medium", "the bot lacks Manage Roles, so it cannot create or edit roles");
    const above = i.roles.filter((r) => r.id !== i.guildId && !r.managed && r.position > top);
    if (above.length) add(2, "info", `${above.length} role(s) sit above the bot's highest role, so it cannot edit them or give them out: ${above.map((r) => r.name).join(", ")}`);
  }
  return out.sort((a, b) => a.rank - b.rank).map((o) => o.line);
}
