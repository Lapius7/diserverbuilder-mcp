import { ChannelType, Routes } from "discord.js";
import {
  KIND, KIND_BY_TYPE, buildOverwrites, getChannels, getRoles, norm, permNames, rest,
  type Ch, type Kind, type OverwriteSpec, type Placed, type Role, type SnapshotData,
} from "./discord.ts";

export interface LayoutChannel extends Placed {
  name: string;
  type?: Exclude<Kind, "category">;
  topic?: string;
  nsfw?: boolean;
}
export interface LayoutCategory extends Placed {
  name: string;
  channels?: LayoutChannel[];
}
export interface Layout { categories: LayoutCategory[] }

export async function applyLayout(g: string, layout: Layout, opts: { dryRun: boolean; prune: boolean }) {
  const chs = await getChannels(g);
  const roles = await getRoles(g);
  const plan: string[] = [];
  const keep = new Set<string>();
  const positions: { id: string; position: number }[] = [];

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
          { name: cat.name, type: ChannelType.GuildCategory, permission_overwrites: buildOverwrites(g, roles, cat) },
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
        if (ex.parent_id !== catId) {
          plan.push(`> move: ${ex.name} -> ${cat.name}`);
          // Discord allows changing only one channel's parent per bulk call, so move individually.
          if (!opts.dryRun) await rest().patch(Routes.channel(id), { body: { parent_id: catId } });
        }
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
            permission_overwrites: buildOverwrites(g, roles, want),
          },
          `${kind} ${want.name} (in ${cat.name})`,
        );
      }
      keep.add(id);
      positions.push({ id, position: j });
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

/** Export the current structure in the same shape apply_layout takes. Member overwrites and uncategorized channels are skipped. */
export async function exportLayout(g: string): Promise<{ layout: Layout; notes: string[] }> {
  const [chs, roles] = await Promise.all([getChannels(g), getRoles(g)]);
  const notes: string[] = [];
  const byPos = (a: Ch, b: Ch) => a.position - b.position || a.id.localeCompare(b.id);
  const roleName = (id: string) => (id === g ? "@everyone" : roles.find((r) => r.id === id)?.name);

  const specs = (c: Ch): OverwriteSpec[] | undefined => {
    const out: OverwriteSpec[] = [];
    for (const o of c.permission_overwrites ?? []) {
      if (o.type !== 0) { notes.push(`skipped a member overwrite on ${c.name}`); continue; }
      const role = roleName(o.id);
      if (!role) continue;
      const allow = permNames(o.allow), deny = permNames(o.deny);
      out.push({ role, ...(allow.length ? { allow } : {}), ...(deny.length ? { deny } : {}) });
    }
    return out.length ? out : undefined;
  };

  const uncategorized = chs.filter((c) => c.type !== ChannelType.GuildCategory && !c.parent_id);
  if (uncategorized.length) notes.push(`uncategorized channels not exported: ${uncategorized.map((c) => c.name).join(", ")}`);

  const categories: LayoutCategory[] = chs
    .filter((c) => c.type === ChannelType.GuildCategory)
    .sort(byPos)
    .map((cat) => ({
      name: cat.name,
      overwrites: specs(cat),
      channels: chs.filter((c) => c.parent_id === cat.id).sort(byPos).map((c): LayoutChannel => {
        const kind = KIND_BY_TYPE[c.type];
        return {
          name: c.name,
          ...(kind && kind !== "text" && kind !== "category" ? { type: kind } : {}),
          ...(c.topic ? { topic: c.topic } : {}),
          ...(c.nsfw ? { nsfw: true } : {}),
          overwrites: specs(c),
        };
      }),
    }));
  return { layout: { categories }, notes };
}

/**
 * Recreate roles and channels from a snapshot that are missing in the target server (matched by name).
 * Existing items are never modified or deleted. Works across servers too, so it doubles as "copy structure".
 */
export async function restoreSnapshot(g: string, snap: SnapshotData, dryRun: boolean): Promise<string[]> {
  const [chs, roles] = await Promise.all([getChannels(g), getRoles(g)]);
  const plan: string[] = [];
  const sameServer = snap.guild === g;
  const roleMap = new Map<string, string>([[snap.guild, g]]); // snapshot role ID -> target role ID

  for (const r of [...snap.roles].sort((a, b) => b.position - a.position)) {
    if (r.id === snap.guild || r.managed) continue;
    const ex = roles.find((x) => !x.managed && x.name.toLowerCase() === r.name.toLowerCase());
    if (ex) { roleMap.set(r.id, ex.id); continue; }
    plan.push(`+ role: ${r.name}`);
    if (dryRun) continue;
    const made = (await rest().post(Routes.guildRoles(g), {
      body: { name: r.name, color: r.color, permissions: r.permissions, hoist: r.hoist, mentionable: r.mentionable },
    })) as Role;
    roleMap.set(r.id, made.id);
    roles.push(made);
  }

  const mapOverwrites = (c: Ch) =>
    (c.permission_overwrites ?? []).flatMap((o) => {
      if (o.type === 1) return sameServer ? [o] : [];
      const id = roleMap.get(o.id);
      return id ? [{ ...o, id }] : [];
    });

  const chanMap = new Map<string, string>(); // snapshot channel ID -> target channel ID
  const created: { id: string; position: number }[] = [];
  const snapCats = snap.channels.filter((c) => c.type === ChannelType.GuildCategory);
  const snapRest = snap.channels.filter((c) => c.type !== ChannelType.GuildCategory);

  const restoreOne = async (c: Ch, parent: string | undefined) => {
    const ex = chs.find((x) => x.type === c.type && norm(x.name, c.type) === norm(c.name, c.type) && (x.parent_id ?? undefined) === parent);
    if (ex) { chanMap.set(c.id, ex.id); return; }
    plan.push(`+ ${KIND_BY_TYPE[c.type] ?? c.type}: ${c.name}`);
    if (dryRun) { chanMap.set(c.id, `new:${c.id}`); return; }
    const made = (await rest().post(Routes.guildChannels(g), {
      body: {
        name: c.name, type: c.type, parent_id: parent, topic: c.topic ?? undefined, nsfw: c.nsfw,
        rate_limit_per_user: c.rate_limit_per_user, user_limit: c.user_limit, bitrate: c.bitrate,
        permission_overwrites: mapOverwrites(c),
      },
    })) as Ch;
    chanMap.set(c.id, made.id);
    created.push({ id: made.id, position: c.position });
  };

  for (const cat of snapCats) await restoreOne(cat, undefined);
  for (const c of snapRest) await restoreOne(c, c.parent_id ? chanMap.get(c.parent_id) : undefined);
  if (!dryRun && created.length) await rest().patch(Routes.guildChannels(g), { body: created });
  if (!plan.length) plan.push("Nothing to restore: everything in the snapshot already exists.");
  return plan;
}
