import { ChannelType, Routes } from "discord.js";
import {
  KIND, KIND_BY_TYPE, buildOverwrites, diffOverwrites, getAllMembers, getChannels, getRoles, norm, permNames, rest, resolveRole,
  type Ch, type Kind, type MemberOverwriteSpec, type OverwriteMode, type OverwriteSpec, type Placed, type Role,
} from "./discord.ts";
import { toDataUri } from "./image.ts";
import { SETTINGS_KEYS, type SnapshotData } from "./snapshot.ts";

type Obj = Record<string, unknown>;

export interface LayoutChannel extends Placed {
  name: string;
  type?: Exclude<Kind, "category">;
  topic?: string;
  nsfw?: boolean;
  slowmode?: number;
  userLimit?: number;
  bitrate?: number;
  forumTags?: string[];
}
export interface LayoutCategory extends Placed {
  name: string;
  channels?: LayoutChannel[];
}
export interface Layout {
  categories: LayoutCategory[];
  /** Channels outside any category, in order. When omitted, uncategorized channels are left alone. */
  uncategorized?: LayoutChannel[];
}
export interface ApplyOpts {
  dryRun: boolean;
  prune: boolean;
  /** off: overwrites apply to new items only. merge/replace: also change existing items (see diffOverwrites). */
  syncPermissions?: "off" | OverwriteMode;
  /** Roles that do not exist yet but will (a dry run of a template that also declares roles). */
  extraRoles?: Role[];
}

const DEFAULT_BITRATE = 64000;
const byPos = (a: Ch, b: Ch) => a.position - b.position || a.id.localeCompare(b.id);
const hasPermSpec = (i: Placed) => i.private !== undefined || !!i.allowRoles || !!i.overwrites || !!i.memberOverwrites;
const sameTags = (a: string[], b: string[]) => a.length === b.length && a.every((t, i) => t.toLowerCase() === b[i]!.toLowerCase());

/** True when keeping only `wanted` IDs, the current order differs from the wanted order. */
function orderDiffers(current: Ch[], wanted: string[]): boolean {
  const set = new Set(wanted);
  const now = [...current].sort(byPos).map((c) => c.id).filter((id) => set.has(id));
  const want = wanted.filter((id) => now.includes(id));
  return now.some((id, i) => id !== want[i]);
}

export async function applyLayout(g: string, layout: Layout, opts: ApplyOpts) {
  const chs = await getChannels(g);
  const roles = [...(await getRoles(g)), ...(opts.extraRoles ?? [])];
  const mode = opts.syncPermissions && opts.syncPermissions !== "off" ? opts.syncPermissions : undefined;
  const plan: string[] = [];
  const keep = new Set<string>();
  const positions: { id: string; position: number }[] = [];
  let orderChanged = false;

  const nameOf = (o: { id: string; type: number }) =>
    o.type === 1 ? `member ${o.id}` : o.id === g ? "@everyone" : roles.find((r) => r.id === o.id)?.name ?? `role ${o.id}`;

  const create = async (body: Record<string, unknown>, label: string): Promise<string> => {
    plan.push(`+ create: ${label}`);
    if (opts.dryRun) return `new:${label}`;
    const c = (await rest().post(Routes.guildChannels(g), { body })) as Ch;
    return c.id;
  };

  const channelFields = (want: LayoutChannel) => ({
    topic: want.topic, nsfw: want.nsfw, rate_limit_per_user: want.slowmode, user_limit: want.userLimit, bitrate: want.bitrate,
    available_tags: want.forumTags?.map((name) => ({ name })),
  });

  /** Make an existing channel match the declaration. parent: the category ID (or null for none). */
  const reconcile = async (ex: Ch, want: LayoutChannel, parent: string | null, parentLabel: string) => {
    if ((ex.parent_id ?? null) !== parent) {
      plan.push(`> move: ${ex.name} -> ${parentLabel}`);
      // Discord allows changing only one channel's parent per bulk call, so move individually.
      if (!opts.dryRun) await rest().patch(Routes.channel(ex.id), { body: { parent_id: parent } });
      orderChanged = true;
    }
    const patch: Record<string, unknown> = {};
    if (want.topic !== undefined && want.topic !== (ex.topic ?? "")) patch.topic = want.topic;
    if (want.nsfw !== undefined && want.nsfw !== !!ex.nsfw) patch.nsfw = want.nsfw;
    if (want.slowmode !== undefined && want.slowmode !== (ex.rate_limit_per_user ?? 0)) patch.rate_limit_per_user = want.slowmode;
    if (want.userLimit !== undefined && want.userLimit !== (ex.user_limit ?? 0)) patch.user_limit = want.userLimit;
    if (want.bitrate !== undefined && want.bitrate !== (ex.bitrate ?? DEFAULT_BITRATE)) patch.bitrate = want.bitrate;
    if (want.forumTags) {
      const have = ex.available_tags ?? [];
      if (!sameTags(have.map((t) => t.name), want.forumTags)) {
        const byName = new Map(have.map((t) => [t.name.toLowerCase(), t]));
        patch.available_tags = want.forumTags.map((n) => byName.get(n.toLowerCase()) ?? { name: n });
      }
    }
    if (Object.keys(patch).length) {
      plan.push(`~ update: ${ex.name} ${JSON.stringify(patch)}`);
      if (!opts.dryRun) await rest().patch(Routes.channel(ex.id), { body: patch });
    }
    if (mode && hasPermSpec(want)) {
      const desired = buildOverwrites(g, roles, want) ?? [];
      const { next, changes } = diffOverwrites(ex.permission_overwrites ?? [], desired, mode, nameOf);
      if (changes.length) {
        plan.push(`# permissions (${mode}): ${ex.name}`, ...changes);
        if (!opts.dryRun) await rest().patch(Routes.channel(ex.id), { body: { permission_overwrites: next } });
      }
    }
  };

  /** Find, or create, the channel a declaration describes. parentId: where a new one goes; undefined = no category. */
  const place = async (want: LayoutChannel, catId: string | undefined, catLabel: string, catExisting: Ch | undefined): Promise<string> => {
    const kind = want.type ?? "text";
    const t = KIND[kind];
    const same = (x: Ch) => x.type === t && norm(x.name, t) === norm(want.name, t) && !keep.has(x.id);
    // Prefer a match inside the same parent; otherwise look server-wide and move it.
    const ex = chs.find((x) => same(x) && (x.parent_id ?? undefined) === catExisting?.id) ?? chs.find(same);
    if (ex) {
      await reconcile(ex, want, catId ?? null, catLabel);
      return ex.id;
    }
    return create(
      {
        name: want.name, type: t,
        parent_id: catId && !catId.startsWith("new:") ? catId : undefined,
        ...channelFields(want),
        permission_overwrites: buildOverwrites(g, roles, want),
      },
      `${kind} ${want.name} (${catLabel})`,
    );
  };

  const rootPositions: { id: string; position: number }[] = [];
  const uncat = layout.uncategorized;
  const rootOffset = uncat?.length ?? 0;

  for (const [j, want] of (uncat ?? []).entries()) {
    const id = await place(want, undefined, "no category", undefined);
    keep.add(id);
    rootPositions.push({ id, position: j });
  }
  if (uncat && orderDiffers(chs.filter((c) => c.type !== ChannelType.GuildCategory && !c.parent_id), rootPositions.map((p) => p.id))) orderChanged = true;

  const catIds: string[] = [];
  for (const [i, cat] of layout.categories.entries()) {
    const c = chs.find((x) => x.type === ChannelType.GuildCategory && norm(x.name, 4) === norm(cat.name, 4));
    let catId: string;
    if (c) {
      catId = c.id;
      if (mode && hasPermSpec(cat)) {
        const desired = buildOverwrites(g, roles, cat) ?? [];
        const { next, changes } = diffOverwrites(c.permission_overwrites ?? [], desired, mode, nameOf);
        if (changes.length) {
          plan.push(`# permissions (${mode}): category ${c.name}`, ...changes);
          if (!opts.dryRun) await rest().patch(Routes.channel(c.id), { body: { permission_overwrites: next } });
        }
      }
    } else {
      catId = await create(
        { name: cat.name, type: ChannelType.GuildCategory, permission_overwrites: buildOverwrites(g, roles, cat) },
        `category ${cat.name}`,
      );
    }
    if (c) keep.add(c.id);
    keep.add(catId);
    catIds.push(catId);
    positions.push({ id: catId, position: i + rootOffset });

    const kids: string[] = [];
    for (const [j, want] of (cat.channels ?? []).entries()) {
      const id = await place(want, catId, cat.name, c);
      keep.add(id);
      kids.push(id);
      positions.push({ id, position: j });
    }
    if (c && orderDiffers(chs.filter((x) => x.parent_id === c.id), kids)) orderChanged = true;
  }
  const existingCats = chs.filter((x) => x.type === ChannelType.GuildCategory);
  if (orderDiffers(existingCats, catIds.filter((id) => existingCats.some((x) => x.id === id)))) orderChanged = true;
  if (catIds.some((id) => id.startsWith("new:"))) orderChanged = true;

  if (orderChanged) {
    // Real IDs of newly created categories are unknown in a dry run, so positions are only patched on a real run.
    if (!opts.dryRun) await rest().patch(Routes.guildChannels(g), { body: [...rootPositions, ...positions] });
    plan.push(`= order: arrange ${layout.categories.length} categories and their channels in the given order`);
  }

  const extra = chs.filter((x) => !keep.has(x.id) && (uncat || x.parent_id || x.type === ChannelType.GuildCategory));
  const untouched = chs.filter((x) => !keep.has(x.id) && !extra.includes(x));
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
  if (!plan.length) plan.push("Nothing to change: the server already matches the layout.");
  if (untouched.length) plan.push(`(uncategorized channels left untouched, since the layout has no "uncategorized" list: ${untouched.map((x) => x.name).join(", ")})`);
  return plan;
}

/**
 * Export the current structure in the same shape apply_layout takes.
 * Member overwrites are included only with includeMembers (user IDs are specific to one server).
 */
export async function exportLayout(g: string, opts: { includeMembers?: boolean } = {}): Promise<{ layout: Layout; notes: string[] }> {
  const [chs, roles] = await Promise.all([getChannels(g), getRoles(g)]);
  const notes: string[] = [];
  const nameCount = new Map<string, number>();
  for (const r of roles) nameCount.set(r.name.toLowerCase(), (nameCount.get(r.name.toLowerCase()) ?? 0) + 1);
  const roleRef = (id: string) => {
    if (id === g) return "@everyone";
    const r = roles.find((x) => x.id === id);
    if (!r) return undefined;
    return (nameCount.get(r.name.toLowerCase()) ?? 0) > 1 ? r.id : r.name; // ambiguous names are exported by ID
  };

  const specs = (c: Ch): { overwrites?: OverwriteSpec[]; memberOverwrites?: MemberOverwriteSpec[] } => {
    const ov: OverwriteSpec[] = [], mem: MemberOverwriteSpec[] = [];
    for (const o of c.permission_overwrites ?? []) {
      const allow = permNames(o.allow), deny = permNames(o.deny);
      const bits = { ...(allow.length ? { allow } : {}), ...(deny.length ? { deny } : {}) };
      if (o.type === 1) {
        if (opts.includeMembers) mem.push({ userId: o.id, ...bits });
        else notes.push(`skipped a member overwrite on ${c.name} (pass includeMembers to export it)`);
        continue;
      }
      const role = roleRef(o.id);
      if (role) ov.push({ role, ...bits });
    }
    return { ...(ov.length ? { overwrites: ov } : {}), ...(mem.length ? { memberOverwrites: mem } : {}) };
  };

  const toChannel = (c: Ch): LayoutChannel | undefined => {
    const kind = KIND_BY_TYPE[c.type];
    if (!kind || kind === "category") {
      notes.push(`unsupported channel type not exported: ${c.name} (type ${c.type})`);
      return undefined;
    }
    const voice = kind === "voice" || kind === "stage";
    return {
      name: c.name,
      ...(kind !== "text" ? { type: kind } : {}),
      ...(c.topic ? { topic: c.topic } : {}),
      ...(c.nsfw ? { nsfw: true } : {}),
      ...(c.rate_limit_per_user ? { slowmode: c.rate_limit_per_user } : {}),
      ...(voice && c.user_limit ? { userLimit: c.user_limit } : {}),
      ...(voice && c.bitrate && c.bitrate !== DEFAULT_BITRATE ? { bitrate: c.bitrate } : {}),
      ...(c.available_tags?.length ? { forumTags: c.available_tags.map((t) => t.name) } : {}),
      ...specs(c),
    };
  };
  const list = (a: Ch[]) => a.sort(byPos).map(toChannel).filter((x): x is LayoutChannel => !!x);

  const categories: LayoutCategory[] = chs
    .filter((c) => c.type === ChannelType.GuildCategory)
    .sort(byPos)
    .map((cat) => ({ name: cat.name, ...specs(cat), channels: list(chs.filter((c) => c.parent_id === cat.id)) }));
  const uncategorized = list(chs.filter((c) => c.type !== ChannelType.GuildCategory && !c.parent_id));
  return { layout: { categories, ...(uncategorized.length ? { uncategorized } : {}) }, notes };
}

export type RestorePart = "settings" | "automod" | "emojis" | "memberRoles";
export interface RestoreOpts { dryRun: boolean; include?: RestorePart[] }

/**
 * Recreate roles and channels from a snapshot that are missing in the target server (matched by name).
 * Existing items are never modified or deleted. Works across servers too, so it doubles as "copy structure".
 * `include` adds optional parts: settings, automod, emojis, memberRoles (same server only).
 */
export async function restoreSnapshot(g: string, snap: SnapshotData, opts: RestoreOpts): Promise<string[]> {
  const dryRun = opts.dryRun;
  const include = new Set(opts.include ?? []);
  const [chs, roles] = await Promise.all([getChannels(g), getRoles(g)]);
  const plan: string[] = [];
  const sameServer = snap.guild === g;
  const roleMap = new Map<string, string>([[snap.guild, g]]); // snapshot role ID -> target role ID

  for (const r of [...snap.roles].sort((a, b) => b.position - a.position)) {
    if (r.id === snap.guild || r.managed) continue;
    if (sameServer && roles.some((x) => x.id === r.id)) { roleMap.set(r.id, r.id); continue; }
    const hits = roles.filter((x) => !x.managed && x.name.toLowerCase() === r.name.toLowerCase());
    if (hits.length === 1) { roleMap.set(r.id, hits[0]!.id); continue; }
    if (hits.length > 1) { plan.push(`! role ${r.name}: ${hits.length} roles share this name in the target, not mapped`); continue; }
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
        available_tags: c.available_tags?.map((t) => ({ name: t.name })),
        permission_overwrites: mapOverwrites(c),
      },
    })) as Ch;
    chanMap.set(c.id, made.id);
    created.push({ id: made.id, position: c.position });
  };

  for (const cat of snapCats) await restoreOne(cat, undefined);
  for (const c of snapRest) await restoreOne(c, c.parent_id ? chanMap.get(c.parent_id) : undefined);
  if (!dryRun && created.length) await rest().patch(Routes.guildChannels(g), { body: created });

  const real = (id: string | undefined | null) => (id && !id.startsWith("new:") ? id : undefined);

  if (include.has("settings")) {
    if (!snap.settings) plan.push("! settings: this snapshot has none");
    else {
      const cur = (await rest().get(Routes.guild(g))) as Obj;
      const patch: Obj = {};
      for (const k of SETTINGS_KEYS) {
        if (k === "features" || (k === "name" && !sameServer)) continue;
        let want = snap.settings[k] ?? null;
        if (k.endsWith("_channel_id") && want) {
          const mapped = chanMap.get(String(want));
          if (!mapped) continue;
          want = mapped;
        }
        if (typeof want === "string" && want.startsWith("new:")) { plan.push(`~ setting ${k}: set to the new channel`); continue; }
        if (JSON.stringify(want) !== JSON.stringify(cur[k] ?? null)) {
          patch[k] = want;
          plan.push(`~ setting ${k}: ${JSON.stringify(cur[k] ?? null)} -> ${JSON.stringify(want)}`);
        }
      }
      if (!dryRun && Object.keys(patch).length) await rest().patch(Routes.guild(g), { body: patch });
    }
  }

  if (include.has("automod")) {
    if (!snap.automod) plan.push("! automod: this snapshot has none");
    else {
      const have = (await rest().get(Routes.guildAutoModerationRules(g))) as Obj[];
      const names = new Set(have.map((r) => String(r.name).toLowerCase()));
      for (const r of snap.automod) {
        if (names.has(String(r.name).toLowerCase())) continue;
        plan.push(`+ automod rule: ${r.name}`);
        if (dryRun) continue;
        const ids = (a: unknown, map: Map<string, string>) => ((a as string[] | undefined) ?? []).map((x) => map.get(x)).filter((x): x is string => !!real(x));
        const actions = ((r.actions as Obj[] | undefined) ?? []).map((a) => {
          const m = a.metadata as Obj | undefined;
          const ch = m?.channel_id ? real(chanMap.get(String(m.channel_id))) : undefined;
          return m?.channel_id && !ch ? undefined : { ...a, metadata: m && ch ? { ...m, channel_id: ch } : m };
        }).filter(Boolean);
        await rest().post(Routes.guildAutoModerationRules(g), {
          body: {
            name: r.name, event_type: r.event_type, trigger_type: r.trigger_type, trigger_metadata: r.trigger_metadata,
            actions, enabled: r.enabled, exempt_roles: ids(r.exempt_roles, roleMap), exempt_channels: ids(r.exempt_channels, chanMap),
          },
        });
      }
    }
  }

  if (include.has("emojis")) {
    if (!snap.emojis) plan.push("! emojis: this snapshot has none");
    else {
      const have = (await rest().get(Routes.guildEmojis(g))) as Obj[];
      const names = new Set(have.map((e) => String(e.name).toLowerCase()));
      for (const e of snap.emojis) {
        if (names.has(String(e.name).toLowerCase())) continue;
        plan.push(`+ emoji: ${e.name}`);
        if (dryRun) continue;
        try {
          const image = await toDataUri(`https://cdn.discordapp.com/emojis/${e.id}.${e.animated ? "gif" : "png"}`);
          await rest().post(Routes.guildEmojis(g), { body: { name: e.name, image } });
        } catch (err) {
          plan.push(`! emoji ${e.name} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  if (include.has("memberRoles")) {
    if (!sameServer) plan.push("! memberRoles: only works on the snapshot's own server (user IDs differ)");
    else if (!snap.memberRoles) plan.push("! memberRoles: this snapshot has none (take it with includeMembers=true)");
    else {
      const members = new Map((await getAllMembers(g)).map((m) => [m.user.id, m]));
      const usable = new Set(roles.filter((r) => !r.managed && r.id !== g).map((r) => r.id));
      let count = 0;
      for (const [uid, rids] of Object.entries(snap.memberRoles)) {
        const m = members.get(uid);
        if (!m) continue;
        for (const rid of rids) {
          if (!usable.has(rid) || m.roles.includes(rid)) continue;
          count++;
          if (!dryRun) await rest().put(Routes.guildMemberRole(g, uid, rid));
        }
      }
      plan.push(`+ member roles: ${count} assignment(s)`);
    }
  }

  if (!plan.length) plan.push("Nothing to restore: everything in the snapshot already exists.");
  return plan;
}
