import { Routes } from "discord.js";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { getAllMembers, getChannels, getRoles, rest, type Ch, type Role } from "./discord.ts";

type Obj = Record<string, unknown>;

/** Directory snapshots are written to. Override with DISERVERBUILDER_SNAPSHOT_DIR. */
export const snapshotDir = () =>
  process.env.DISERVERBUILDER_SNAPSHOT_DIR || join(homedir(), ".diserverbuilder", "snapshots");

export const SNAPSHOT_VERSION = 2;

/** Server settings kept in a snapshot (and the only ones restore_snapshot writes back). */
export const SETTINGS_KEYS = [
  "name", "description", "verification_level", "default_message_notifications", "explicit_content_filter",
  "system_channel_id", "system_channel_flags", "rules_channel_id", "public_updates_channel_id", "afk_channel_id",
  "afk_timeout", "preferred_locale", "premium_progress_bar_enabled", "safety_alerts_channel_id", "features",
] as const;

export interface SnapshotData {
  version?: number;
  savedAt?: string;
  guild: string;
  channels: Ch[];
  roles: Role[];
  settings?: Obj;
  emojis?: Obj[];
  stickers?: Obj[];
  events?: Obj[];
  automod?: Obj[];
  onboarding?: Obj;
  welcomeScreen?: Obj;
  /** user ID to role IDs. Only with includeMembers. */
  memberRoles?: Record<string, string[]>;
  /** Parts that could not be read (missing permission, intent, or feature). */
  notes?: string[];
}

/** Read the server's current state. Optional parts that cannot be read become notes instead of failures. */
export async function collectSnapshot(g: string, opts: { includeMembers?: boolean } = {}): Promise<SnapshotData> {
  const notes: string[] = [];
  const [channels, roles] = await Promise.all([getChannels(g), getRoles(g)]);
  const opt = async <T>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try { return await fn(); } catch (e) {
      const status = (e as { status?: number }).status;
      notes.push(`${label} not saved (${status ? `HTTP ${status}` : e instanceof Error ? e.message : String(e)})`);
      return undefined;
    }
  };
  const [guild, emojis, stickers, events, automod, onboarding, welcomeScreen] = await Promise.all([
    opt("settings", () => rest().get(Routes.guild(g)) as Promise<Obj>),
    opt("emojis", () => rest().get(Routes.guildEmojis(g)) as Promise<Obj[]>),
    opt("stickers", () => rest().get(Routes.guildStickers(g)) as Promise<Obj[]>),
    opt("events", () => rest().get(Routes.guildScheduledEvents(g)) as Promise<Obj[]>),
    opt("automod", () => rest().get(Routes.guildAutoModerationRules(g)) as Promise<Obj[]>),
    opt("onboarding", () => rest().get(Routes.guildOnboarding(g)) as Promise<Obj>),
    opt("welcome screen", () => rest().get(Routes.guildWelcomeScreen(g)) as Promise<Obj>),
  ]);
  let memberRoles: Record<string, string[]> | undefined;
  if (opts.includeMembers) {
    const ms = await opt("member roles", () => getAllMembers(g));
    if (ms) memberRoles = Object.fromEntries(ms.filter((m) => m.roles.length).map((m) => [m.user.id, m.roles]));
  }
  const settings = guild ? Object.fromEntries(SETTINGS_KEYS.map((k) => [k, guild[k] ?? null])) : undefined;
  return {
    version: SNAPSHOT_VERSION, savedAt: new Date().toISOString(), guild: g, channels, roles,
    settings, emojis, stickers, events, automod, onboarding, welcomeScreen, memberRoles, notes,
  };
}

export async function saveSnapshot(g: string, opts: { includeMembers?: boolean } = {}): Promise<{ file: string; data: SnapshotData }> {
  if (!/^\d{5,25}$/.test(g)) throw new Error(`Not a server ID: ${g}`);
  const data = await collectSnapshot(g, opts);
  const dir = snapshotDir();
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${g}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(file, JSON.stringify(data, null, 2));
  return { file, data };
}

/** Save a snapshot and return its path. Used before destructive runs. */
export const snapshot = async (g: string, opts: { includeMembers?: boolean } = {}) => (await saveSnapshot(g, opts)).file;

export async function listSnapshots(): Promise<string[]> {
  try {
    return (await readdir(snapshotDir())).filter((f) => f.endsWith(".json")).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/** Read a snapshot file. Files from before version 2 (only guild, channels, roles) still load. */
export async function readSnapshot(file: string): Promise<SnapshotData> {
  if (!isAbsolute(file) && basename(file) !== file) throw new Error(`Pass a file name from list_snapshots or an absolute path: ${file}`);
  const path = isAbsolute(file) ? file : join(snapshotDir(), file);
  const data = JSON.parse(await readFile(path, "utf8")) as Partial<SnapshotData>;
  if (!data.guild || !Array.isArray(data.channels) || !Array.isArray(data.roles)) {
    throw new Error(`Not a diserverbuilder snapshot: ${path}`);
  }
  return data as SnapshotData;
}

// ---------- Diff ----------

const show = (v: unknown) => (typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v ?? null));
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function diffList(label: string, a: Obj[] | undefined, b: Obj[] | undefined, fields: string[], out: string[]) {
  if (!a || !b) return;
  const nameOf = (o: Obj) => String(o.name ?? o.id);
  const am = new Map(a.map((o) => [String(o.id), o])), bm = new Map(b.map((o) => [String(o.id), o]));
  for (const [id, o] of bm) {
    const before = am.get(id);
    if (!before) { out.push(`+ ${label}: ${nameOf(o)} (${id})`); continue; }
    const changed = fields.filter((f) => !same(before[f], o[f]));
    if (changed.length) out.push(`~ ${label}: ${nameOf(before)} (${id}) ${changed.map((f) => `${f}: ${show(before[f])} -> ${show(o[f])}`).join("; ")}`);
  }
  for (const [id, o] of am) if (!bm.has(id)) out.push(`- ${label}: ${nameOf(o)} (${id})`);
}

/** Describe what changed from `before` to `after`. Parts missing from either side are skipped. */
export function diffSnapshots(before: SnapshotData, after: SnapshotData): string[] {
  const out: string[] = [];
  const ovKey = (c: Ch) => (c.permission_overwrites ?? []).map((o) => `${o.type}:${o.id}:${o.allow}:${o.deny}`).sort((a, b) => a.localeCompare(b));
  const prep = (s: SnapshotData) => s.channels.map((c) => ({ ...c, overwrites: ovKey(c) } as unknown as Obj));
  diffList("role", before.roles as unknown as Obj[], after.roles as unknown as Obj[],
    ["name", "color", "permissions", "hoist", "mentionable", "position", "icon", "unicode_emoji"], out);
  diffList("channel", prep(before), prep(after),
    ["name", "type", "parent_id", "position", "topic", "nsfw", "rate_limit_per_user", "user_limit", "bitrate", "overwrites"], out);
  if (before.settings && after.settings) {
    for (const k of SETTINGS_KEYS) if (!same(before.settings[k], after.settings[k])) out.push(`~ setting ${k}: ${show(before.settings[k])} -> ${show(after.settings[k])}`);
  }
  diffList("emoji", before.emojis, after.emojis, ["name", "roles"], out);
  diffList("sticker", before.stickers, after.stickers, ["name", "description", "tags"], out);
  diffList("event", before.events, after.events, ["name", "scheduled_start_time", "scheduled_end_time", "status"], out);
  diffList("automod rule", before.automod, after.automod, ["name", "enabled", "trigger_type", "trigger_metadata", "actions", "exempt_roles", "exempt_channels"], out);
  if (before.onboarding && after.onboarding && !same(before.onboarding, after.onboarding)) out.push("~ onboarding changed");
  if (before.welcomeScreen && after.welcomeScreen && !same(before.welcomeScreen, after.welcomeScreen)) out.push("~ welcome screen changed");
  if (before.memberRoles && after.memberRoles) {
    let changed = 0;
    for (const id of new Set([...Object.keys(before.memberRoles), ...Object.keys(after.memberRoles)])) {
      if (!same([...(before.memberRoles[id] ?? [])].sort((a, b) => a.localeCompare(b)), [...(after.memberRoles[id] ?? [])].sort((a, b) => a.localeCompare(b)))) changed++;
    }
    if (changed) out.push(`~ roles of ${changed} member(s) changed`);
  }
  return out;
}
