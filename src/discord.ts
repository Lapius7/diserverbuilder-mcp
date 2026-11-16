import { REST, Routes, ChannelType, PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { resolveToken } from "./config.ts";

let _rest: REST | null = null;
/** Replace the REST client (tests inject an in-memory fake here). */
export function setRest(r: unknown) { _rest = r as REST | null; }
export function rest(): REST {
  if (_rest) return _rest;
  const t = resolveToken();
  if (!t) throw new Error("No bot token. Run `npx diserverbuilder-mcp auth` in a terminal, or set DISCORD_BOT_TOKEN in the MCP server's env.");
  return (_rest = new REST({ version: "10" }).setToken(t.token));
}

export function guildOf(id?: string): string {
  const g = id || process.env.DISCORD_GUILD_ID;
  if (!g) throw new Error("Pass guildId or set DISCORD_GUILD_ID.");
  return g;
}

export const KIND = {
  text: ChannelType.GuildText,
  voice: ChannelType.GuildVoice,
  announcement: ChannelType.GuildAnnouncement,
  stage: ChannelType.GuildStageVoice,
  forum: ChannelType.GuildForum,
  media: ChannelType.GuildMedia,
  category: ChannelType.GuildCategory,
} as const;
export type Kind = keyof typeof KIND;
export const KIND_BY_TYPE = Object.fromEntries(Object.entries(KIND).map(([k, v]) => [v, k])) as Record<number, Kind>;

export interface Overwrite { id: string; type: number; allow: string; deny: string }
export interface Ch {
  id: string;
  type: number;
  name: string;
  position: number;
  guild_id?: string;
  parent_id?: string | null;
  topic?: string | null;
  nsfw?: boolean;
  rate_limit_per_user?: number;
  user_limit?: number;
  bitrate?: number;
  available_tags?: { id: string; name: string }[];
  last_message_id?: string | null;
  permission_overwrites?: Overwrite[];
}
export interface Role {
  id: string; name: string; position: number; permissions: string;
  color?: number; hoist?: boolean; mentionable?: boolean; managed?: boolean;
}

export const getChannels = (g: string) => rest().get(Routes.guildChannels(g)) as Promise<Ch[]>;
export const getRoles = (g: string) => rest().get(Routes.guildRoles(g)) as Promise<Role[]>;

/** Permission names (e.g. ViewChannel) to a bitfield string. Throws on unknown names. */
export function permBits(names: string[] = []): string {
  let v = 0n;
  for (const n of names) {
    const b = (PermissionFlagsBits as Record<string, bigint>)[n];
    if (b === undefined) throw new Error(`Unknown permission name: ${n} (e.g. ViewChannel, SendMessages, Connect)`);
    v |= b;
  }
  return v.toString();
}

/** Bitfield string to permission names. */
export const permNames = (bits: string | bigint): string[] => new PermissionsBitField(BigInt(bits)).toArray();

/** Normalize names the way Discord does so they can be compared (text-like channels: lowercase, spaces to hyphens). */
export const norm = (name: string, kind: number) =>
  kind === ChannelType.GuildCategory || kind === ChannelType.GuildVoice || kind === ChannelType.GuildStageVoice
    ? name.toLowerCase()
    : name.toLowerCase().replace(/\s+/g, "-");

/** Time encoded in a Discord snowflake ID. */
export const snowflakeTime = (id: string) => new Date(Number(BigInt(id) >> 22n) + 1420070400000).toISOString();

/** Render the structure as short text in display order (category, then its children). */
export function render(chs: Ch[]): string {
  const sorted = (a: Ch[]) => [...a].sort((x, y) => x.position - y.position || x.id.localeCompare(y.id));
  const cats = sorted(chs.filter((c) => c.type === ChannelType.GuildCategory));
  const line = (c: Ch, pad: string) =>
    `${pad}${c.name} [${KIND_BY_TYPE[c.type] ?? c.type}] ${c.id}` +
    (c.topic ? ` - ${c.topic}` : "") +
    (c.permission_overwrites?.length ? ` (${c.permission_overwrites.length} permission overwrites)` : "");
  const out: string[] = [];
  const top = sorted(chs.filter((c) => c.type !== ChannelType.GuildCategory && !c.parent_id));
  if (top.length) out.push("(no category)", ...top.map((c) => line(c, "  ")));
  for (const cat of cats) {
    out.push(line(cat, ""));
    out.push(...sorted(chs.filter((c) => c.parent_id === cat.id)).map((c) => line(c, "  ")));
  }
  return out.join("\n");
}

// ---------- Permission overwrites ----------

export interface OverwriteSpec { role: string; allow?: string[]; deny?: string[] }
export interface MemberOverwriteSpec { userId: string; allow?: string[]; deny?: string[] }
export interface Placed {
  private?: boolean; allowRoles?: string[]; overwrites?: OverwriteSpec[]; memberOverwrites?: MemberOverwriteSpec[];
}

/** Resolve a role reference (ID, name, or "@everyone") to an ID. A name shared by several roles is an error, never a guess. */
export function resolveRole(g: string, roles: Role[], ref: string): string {
  if (ref.toLowerCase() === "@everyone") return g;
  if (/^\d{15,25}$/.test(ref) && (ref === g || roles.some((r) => r.id === ref))) return ref;
  const hits = roles.filter((r) => r.name.toLowerCase() === ref.toLowerCase());
  if (hits.length === 1) return hits[0]!.id;
  if (hits.length > 1) throw new Error(`Role name "${ref}" matches ${hits.length} roles (${hits.map((r) => r.id).join(", ")}). Pass the role ID instead.`);
  throw new Error(`Role not found: ${ref}`);
}

/** Build overwrites from `private`, `allowRoles` and explicit per-role / per-member specs. "@everyone" means the everyone role. */
export function buildOverwrites(g: string, roles: Role[], item: Placed): Overwrite[] | undefined {
  const slots = new Map<string, { id: string; type: number; allow: bigint; deny: bigint }>();
  const slot = (id: string, type: number) => {
    const key = `${type}:${id}`;
    let s = slots.get(key);
    if (!s) slots.set(key, (s = { id, type, allow: 0n, deny: 0n }));
    return s;
  };
  const view = PermissionFlagsBits.ViewChannel;
  if (item.private) {
    slot(g, 0).deny |= view;
    for (const rn of item.allowRoles ?? []) slot(resolveRole(g, roles, rn), 0).allow |= view;
  }
  for (const o of item.overwrites ?? []) {
    const s = slot(resolveRole(g, roles, o.role), 0);
    s.allow |= BigInt(permBits(o.allow));
    s.deny |= BigInt(permBits(o.deny));
  }
  for (const o of item.memberOverwrites ?? []) {
    const s = slot(o.userId, 1);
    s.allow |= BigInt(permBits(o.allow));
    s.deny |= BigInt(permBits(o.deny));
  }
  if (!slots.size) return undefined;
  return [...slots.values()].map((s) => ({ id: s.id, type: s.type, allow: s.allow.toString(), deny: s.deny.toString() }));
}

export type OverwriteMode = "merge" | "replace";

/**
 * Work out the overwrites a channel should end up with.
 * merge: each declared target gets its declared bits added on top of what it has (declared bits win); other overwrites stay.
 * replace: declared targets are set exactly, role overwrites that were not declared are removed; member overwrites that were not declared stay.
 * Returns the full new list and human-readable change lines (empty when nothing changes).
 */
export function diffOverwrites(
  current: Overwrite[], desired: Overwrite[], mode: OverwriteMode, nameOf: (o: { id: string; type: number }) => string,
): { next: Overwrite[]; changes: string[] } {
  const changes: string[] = [];
  const key = (o: { id: string; type: number }) => `${o.type}:${o.id}`;
  const fmt = (allow: bigint, deny: bigint) =>
    [allow ? `allow [${permNames(allow).join(", ")}]` : "", deny ? `deny [${permNames(deny).join(", ")}]` : ""].filter(Boolean).join(" ") || "(empty)";
  const cur = new Map(current.map((o) => [key(o), o]));
  const out = new Map<string, Overwrite>();
  for (const o of current) out.set(key(o), o);

  for (const d of desired) {
    const c = cur.get(key(d));
    const da = BigInt(d.allow), dd = BigInt(d.deny);
    let allow = da, deny = dd;
    if (mode === "merge" && c) {
      allow = (BigInt(c.allow) | da) & ~dd;
      deny = (BigInt(c.deny) | dd) & ~da;
    }
    if (!c) {
      changes.push(`    + ${nameOf(d)}: ${fmt(allow, deny)}`);
    } else if (BigInt(c.allow) !== allow || BigInt(c.deny) !== deny) {
      changes.push(`    ~ ${nameOf(d)}: ${fmt(BigInt(c.allow), BigInt(c.deny))} -> ${fmt(allow, deny)}`);
    } else continue;
    out.set(key(d), { id: d.id, type: d.type, allow: allow.toString(), deny: deny.toString() });
  }
  if (mode === "replace") {
    const want = new Set(desired.map(key));
    for (const o of current) {
      if (o.type === 0 && !want.has(key(o))) {
        changes.push(`    - ${nameOf(o)}: ${fmt(BigInt(o.allow), BigInt(o.deny))}`);
        out.delete(key(o));
      }
    }
  }
  return { next: [...out.values()], changes };
}

// ---------- Members ----------

export interface Member { user: { id: string; username: string; global_name?: string | null; bot?: boolean }; nick?: string | null; roles: string[]; communication_disabled_until?: string | null; joined_at?: string }

/** Every member of the server. Needs the Server Members privileged intent (enable it in the Developer Portal, Bot page). */
export async function getAllMembers(g: string): Promise<Member[]> {
  const out: Member[] = [];
  let after = "0";
  try {
    for (;;) {
      const page = (await rest().get(Routes.guildMembers(g), { query: new URLSearchParams({ limit: "1000", after }) })) as Member[];
      out.push(...page);
      if (page.length < 1000) break;
      after = page[page.length - 1]!.user.id;
    }
  } catch (e) {
    if ((e as { status?: number }).status === 403) {
      throw new Error("Listing members was refused. Turn on the Server Members Intent for the bot (Developer Portal, Bot, Privileged Gateway Intents) and try again.");
    }
    throw e;
  }
  return out;
}
