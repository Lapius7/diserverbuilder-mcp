import { REST, Routes, ChannelType, PermissionFlagsBits } from "discord.js";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

let _rest: REST | null = null;
export function rest(): REST {
  if (_rest) return _rest;
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("DISCORD_BOT_TOKEN is not set. Pass it through the MCP server's env.");
  return (_rest = new REST({ version: "10" }).setToken(token));
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
const KIND_BY_TYPE = Object.fromEntries(Object.entries(KIND).map(([k, v]) => [v, k])) as Record<number, Kind>;

export interface Ch {
  id: string;
  type: number;
  name: string;
  position: number;
  guild_id?: string;
  parent_id?: string | null;
  topic?: string | null;
  nsfw?: boolean;
  permission_overwrites?: { id: string; type: number; allow: string; deny: string }[];
}
export interface Role { id: string; name: string; position: number; managed?: boolean; permissions: string }

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

/** Normalize names the way Discord does so they can be compared (text-like channels: lowercase, spaces to hyphens). */
const norm = (name: string, kind: number) =>
  kind === ChannelType.GuildCategory || kind === ChannelType.GuildVoice || kind === ChannelType.GuildStageVoice
    ? name.toLowerCase()
    : name.toLowerCase().replace(/\s+/g, "-");

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

/** Directory snapshots are written to. Override with DISERVERBUILDER_SNAPSHOT_DIR. */
export const snapshotDir = () =>
  process.env.DISERVERBUILDER_SNAPSHOT_DIR || join(homedir(), ".diserverbuilder", "snapshots");

export async function snapshot(g: string): Promise<string> {
  const [channels, roles] = await Promise.all([getChannels(g), getRoles(g)]);
  const dir = snapshotDir();
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${g}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(file, JSON.stringify({ guild: g, channels, roles }, null, 2));
  return file;
}

// ---------- Declarative layout ----------

export interface LayoutChannel {
  name: string;
  type?: Exclude<Kind, "category">;
  topic?: string;
  nsfw?: boolean;
  /** If true, deny @everyone from viewing (applied only when the channel is created). */
  private?: boolean;
  /** Role names allowed to view when private (applied only when the channel is created). */
  allowRoles?: string[];
}
export interface LayoutCategory {
  name: string;
  private?: boolean;
  allowRoles?: string[];
  channels?: LayoutChannel[];
}
export interface Layout { categories: LayoutCategory[] }

function overwrites(g: string, roles: Role[], item: { private?: boolean; allowRoles?: string[] }) {
  if (!item.private) return undefined;
  const view = permBits(["ViewChannel"]);
  const ow = [{ id: g, type: 0, allow: "0", deny: view }];
  for (const rn of item.allowRoles ?? []) {
    const r = roles.find((x) => x.name.toLowerCase() === rn.toLowerCase());
    if (!r) throw new Error(`Role not found: ${rn}`);
    ow.push({ id: r.id, type: 0, allow: view, deny: "0" });
  }
  return ow;
}

export async function applyLayout(g: string, layout: Layout, opts: { dryRun: boolean; prune: boolean }) {
  const chs = await getChannels(g);
  const roles = await getRoles(g);
  const plan: string[] = [];
  const keep = new Set<string>();
  const positions: { id: string; position: number; parent_id?: string | null }[] = [];

  const create = async (body: Record<string, unknown>, label: string): Promise<string> => {
    plan.push(`+ create: ${label}`);
    if (opts.dryRun) return `new:${label}`;
    const c = (await rest().post(Routes.guildChannels(g), { body })) as Ch;
    return c.id;
  };

  for (const [i, cat] of layout.categories.entries()) {
    const c = chs.find((x) => x.type === ChannelType.GuildCategory && norm(x.name, 4) === norm(cat.name, 4));
    const catId = c
      ? c.id
      : await create(
          { name: cat.name, type: ChannelType.GuildCategory, permission_overwrites: overwrites(g, roles, cat) },
          `category ${cat.name}`,
        );
    if (c) keep.add(c.id);
    keep.add(catId);
    positions.push({ id: catId, position: i });

    for (const [j, want] of (cat.channels ?? []).entries()) {
      const kind = want.type ?? "text";
      const t = KIND[kind];
      const same = (x: Ch) => x.type === t && norm(x.name, t) === norm(want.name, t) && !keep.has(x.id);
      // Prefer a match inside the same category; otherwise look server-wide and move it.
      const ex = chs.find((x) => same(x) && x.parent_id === c?.id) ?? chs.find(same);
      let id: string;
      if (ex) {
        id = ex.id;
        if (ex.parent_id !== catId) plan.push(`> move: ${ex.name} -> ${cat.name}`);
        const patch: Record<string, unknown> = {};
        if (want.topic !== undefined && want.topic !== (ex.topic ?? "")) patch.topic = want.topic;
        if (want.nsfw !== undefined && want.nsfw !== !!ex.nsfw) patch.nsfw = want.nsfw;
        if (Object.keys(patch).length) {
          plan.push(`~ update: ${ex.name} ${JSON.stringify(patch)}`);
          if (!opts.dryRun) await rest().patch(Routes.channel(id), { body: patch });
        }
      } else {
        id = await create(
          {
            name: want.name,
            type: t,
            parent_id: c ? c.id : catId.startsWith("new:") ? undefined : catId,
            topic: want.topic,
            nsfw: want.nsfw,
            permission_overwrites: overwrites(g, roles, want),
          },
          `${kind} ${want.name} (in ${cat.name})`,
        );
      }
      keep.add(id);
      positions.push({ id, position: j, parent_id: catId.startsWith("new:") ? undefined : catId });
    }
  }

  // Real IDs of newly created categories are unknown in a dry run, so positions are only patched on a real run.
  if (!opts.dryRun) {
    await rest().patch(Routes.guildChannels(g), { body: positions });
  }
  plan.push(`= order: arrange ${layout.categories.length} categories and their channels in the given order`);

  const extra = chs.filter((x) => !keep.has(x.id));
  if (extra.length) {
    if (opts.prune) {
      for (const x of extra) {
        plan.push(`- delete: ${x.name} [${KIND_BY_TYPE[x.type] ?? x.type}]`);
        if (!opts.dryRun) await rest().delete(Routes.channel(x.id));
      }
    } else {
      plan.push(`(not in the layout, left untouched: ${extra.map((x) => x.name).join(", ")})`);
    }
  }
  return plan;
}
