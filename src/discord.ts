import { REST, Routes, ChannelType, PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { resolveToken } from "./config.ts";

let _rest: REST | null = null;
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
export interface Placed { private?: boolean; allowRoles?: string[]; overwrites?: OverwriteSpec[] }

/** Build overwrites from `private`, `allowRoles` and explicit per-role specs. "@everyone" means the everyone role. */
export function buildOverwrites(g: string, roles: Role[], item: Placed): Overwrite[] | undefined {
  const slots = new Map<string, { allow: bigint; deny: bigint }>();
  const slot = (id: string) => {
    let s = slots.get(id);
    if (!s) slots.set(id, (s = { allow: 0n, deny: 0n }));
    return s;
  };
  const roleId = (name: string) => {
    if (name.toLowerCase() === "@everyone") return g;
    const r = roles.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!r) throw new Error(`Role not found: ${name}`);
    return r.id;
  };
  const view = PermissionFlagsBits.ViewChannel;
  if (item.private) {
    slot(g).deny |= view;
    for (const rn of item.allowRoles ?? []) slot(roleId(rn)).allow |= view;
  }
  for (const o of item.overwrites ?? []) {
    const s = slot(roleId(o.role));
    s.allow |= BigInt(permBits(o.allow));
    s.deny |= BigInt(permBits(o.deny));
  }
  if (!slots.size) return undefined;
  return [...slots].map(([id, s]) => ({ id, type: 0, allow: s.allow.toString(), deny: s.deny.toString() }));
}

// ---------- Snapshots ----------

/** Directory snapshots are written to. Override with DISERVERBUILDER_SNAPSHOT_DIR. */
export const snapshotDir = () =>
  process.env.DISERVERBUILDER_SNAPSHOT_DIR || join(homedir(), ".diserverbuilder", "snapshots");

export interface SnapshotData { guild: string; channels: Ch[]; roles: Role[] }

export async function snapshot(g: string): Promise<string> {
  const [channels, roles] = await Promise.all([getChannels(g), getRoles(g)]);
  const dir = snapshotDir();
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${g}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(file, JSON.stringify({ guild: g, channels, roles }, null, 2));
  return file;
}

export async function listSnapshots(): Promise<string[]> {
  try {
    return (await readdir(snapshotDir())).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

export async function readSnapshot(file: string): Promise<SnapshotData> {
  const path = isAbsolute(file) ? file : join(snapshotDir(), file);
  const data = JSON.parse(await readFile(path, "utf8")) as Partial<SnapshotData>;
  if (!data.guild || !Array.isArray(data.channels) || !Array.isArray(data.roles)) {
    throw new Error(`Not a diserverbuilder snapshot: ${path}`);
  }
  return data as SnapshotData;
}
