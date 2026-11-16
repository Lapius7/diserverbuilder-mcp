import { z } from "zod";
import { guildOf } from "../discord.ts";
import { applyLayout, exportLayout, restoreSnapshot } from "../layout.ts";
import { diffSnapshots, listSnapshots, readSnapshot, collectSnapshot, saveSnapshot, snapshot, snapshotDir } from "../snapshot.ts";
import { DESTRUCTIVE, LOCAL, READ, WRITE, def, guildId, kindEnum, overwriteSpec } from "../tool.ts";

const placed = {
  private: z.boolean().optional().describe("Deny @everyone from viewing"),
  allowRoles: z.array(z.string()).optional().describe("With private: roles (name or ID) allowed to view"),
  overwrites: z.array(overwriteSpec).optional(),
  memberOverwrites: z.array(z.object({ userId: z.string(), allow: z.array(z.string()).optional(), deny: z.array(z.string()).optional() })).optional(),
};
const layoutChannel = z.object({
  name: z.string(), type: kindEnum.optional(), topic: z.string().optional(), nsfw: z.boolean().optional(),
  slowmode: z.number().int().min(0).max(21600).optional().describe("Slowmode in seconds"),
  userLimit: z.number().int().min(0).max(99).optional(), bitrate: z.number().int().min(8000).optional(),
  forumTags: z.array(z.string().max(20)).optional().describe("Forum/media: the full tag list"),
  ...placed,
});

def("snapshot", {
  description:
    "Save the server's current state as JSON: channels, roles, permission overwrites, server settings, emojis, stickers, events, AutoMod rules, onboarding and welcome screen. " +
    "Parts the bot cannot read are skipped with a note. includeMembers=true also records every member's roles (needs the Server Members Intent). " +
    "Saved to DISERVERBUILDER_SNAPSHOT_DIR, default ~/.diserverbuilder/snapshots. Use before deletions or large changes. Messages are not included.",
  inputSchema: { guildId, includeMembers: z.boolean().default(false) },
  annotations: LOCAL,
}, async (a) => {
  const { file, data } = await saveSnapshot(guildOf(a.guildId), { includeMembers: a.includeMembers });
  return `Saved: ${file}` + (data.notes?.length ? `\nNotes:\n${data.notes.join("\n")}` : "");
});

def("list_snapshots", {
  description: "List saved snapshot files (the file name is the server ID plus a timestamp).",
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, async () => {
  const files = await listSnapshots();
  return files.length ? `${snapshotDir()}\n${files.join("\n")}` : `(no snapshots in ${snapshotDir()})`;
});

def("diff_snapshot", {
  description:
    "Show what changed since a snapshot: roles, channels (incl. permission overwrites), settings, emojis, stickers, events, AutoMod, onboarding. " +
    "Compares the snapshot with the server's current state, or with a second snapshot (fileB) when given. + added, - removed, ~ changed.",
  inputSchema: {
    guildId: guildId.describe("Server to compare against now. Defaults to the snapshot's own server."),
    file: z.string().describe("Snapshot file name (from list_snapshots) or absolute path"),
    fileB: z.string().optional().describe("A later snapshot to compare with, instead of the live server"),
  },
  annotations: { readOnlyHint: true },
}, async (a) => {
  const before = await readSnapshot(a.file);
  const after = a.fileB ? await readSnapshot(a.fileB) : await collectSnapshot(a.guildId || process.env.DISCORD_GUILD_ID || before.guild, { includeMembers: !!before.memberRoles });
  const lines = diffSnapshots(before, after);
  return lines.length ? lines.join("\n") : "No differences.";
});

def("restore_snapshot", {
  description:
    "Recreate roles and channels from a snapshot that are missing in the target server (matched by name or, on the same server, ID). " +
    "Existing items are never changed or deleted, and messages cannot be restored. " +
    "Roles are matched by name, so with a different target guildId this copies the structure to another server. " +
    "include adds optional parts: settings (server settings, channel references mapped), automod (missing rules), emojis (re-downloaded from Discord's CDN), memberRoles (same server only; needs a snapshot taken with includeMembers). Defaults to dryRun.",
  inputSchema: {
    guildId: guildId.describe("Target server. Defaults to the snapshot's own server."),
    file: z.string().describe("Snapshot file name (from list_snapshots) or absolute path"),
    include: z.array(z.enum(["settings", "automod", "emojis", "memberRoles"])).default([]),
    dryRun: z.boolean().default(true),
  },
  annotations: WRITE,
}, async (a) => {
  const snap = await readSnapshot(a.file);
  const g = a.guildId || process.env.DISCORD_GUILD_ID || snap.guild;
  const plan = await restoreSnapshot(g, snap, { dryRun: a.dryRun, include: a.include });
  return `${a.dryRun ? "[dry-run]" : "[applied]"} snapshot of ${snap.guild} -> ${g}\n${plan.join("\n")}`;
});

def("export_layout", {
  description:
    "Export the current categories and channels as JSON in the same shape apply_layout takes: topic, NSFW, slowmode, voice limits, forum tags, permission overwrites by role, and channels outside any category (\"uncategorized\"). " +
    "Use it to edit a structure and apply it back, or to reuse it on another server. Member overwrites are skipped unless includeMembers=true (user IDs only make sense on the same server). Unsupported channel types are skipped and listed in the notes, so prune=true would delete them.",
  inputSchema: { guildId, includeMembers: z.boolean().default(false) },
  annotations: READ,
}, async (a) => {
  const { layout, notes } = await exportLayout(guildOf(a.guildId), { includeMembers: a.includeMembers });
  return JSON.stringify(layout, null, 2) + (notes.length ? `\n\nNotes:\n${[...new Set(notes)].join("\n")}` : "");
});

def("apply_layout", {
  description:
    "Declare the desired structure and apply it in bulk. Matches existing items by name, creates missing ones, moves and updates existing ones (topic, NSFW, slowmode, voice limits, forum tags), and orders everything as given. " +
    "Include \"uncategorized\" to manage channels outside any category too. " +
    "Defaults to dryRun (shows the plan only; an unchanged server reports \"Nothing to change\"). Channels not in the layout are deleted only when prune=true and dryRun=false (a snapshot is saved automatically before a real run). " +
    "private/allowRoles/overwrites/memberOverwrites apply to newly created items; set syncPermissions=merge to also add them to existing items (declared bits win, everything else stays) or replace to make existing role overwrites match exactly (undeclared role overwrites are removed, member overwrites stay).",
  inputSchema: {
    guildId,
    categories: z.array(z.object({ name: z.string(), ...placed, channels: z.array(layoutChannel).optional() })),
    uncategorized: z.array(layoutChannel).optional().describe("Channels outside any category, in order"),
    syncPermissions: z.enum(["off", "merge", "replace"]).default("off"),
    dryRun: z.boolean().default(true),
    prune: z.boolean().default(false),
  },
  annotations: DESTRUCTIVE,
}, async (a) => {
  const g = guildOf(a.guildId);
  const head = a.dryRun ? "" : `Snapshot: ${await snapshot(g)}\n`;
  const plan = await applyLayout(g, { categories: a.categories, uncategorized: a.uncategorized }, { dryRun: a.dryRun, prune: a.prune, syncPermissions: a.syncPermissions });
  return `${head}${a.dryRun ? "[dry-run]" : "[applied]"}\n${plan.join("\n")}`;
});
