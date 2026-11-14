import { z } from "zod";
import { guildOf, listSnapshots, readSnapshot, snapshot, snapshotDir } from "../discord.ts";
import { applyLayout, exportLayout, restoreSnapshot } from "../layout.ts";
import { DESTRUCTIVE, LOCAL, READ, WRITE, def, guildId, kindEnum, overwriteSpec } from "../tool.ts";

const placed = {
  private: z.boolean().optional(),
  allowRoles: z.array(z.string()).optional(),
  overwrites: z.array(overwriteSpec).optional(),
};
const layoutChannel = z.object({
  name: z.string(), type: kindEnum.optional(), topic: z.string().optional(), nsfw: z.boolean().optional(), ...placed,
});

def("snapshot", {
  description:
    "Save the current structure (channels, roles, permission overwrites) as JSON. " +
    "Saved to DISERVERBUILDER_SNAPSHOT_DIR, default ~/.diserverbuilder/snapshots. Use before deletions or large changes. Messages are not included.",
  inputSchema: { guildId },
  annotations: LOCAL,
}, async (a) => `Saved: ${await snapshot(guildOf(a.guildId))}`);

def("list_snapshots", {
  description: "List saved snapshot files (the file name is the server ID plus a timestamp).",
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, async () => {
  const files = await listSnapshots();
  return files.length ? `${snapshotDir()}\n${files.join("\n")}` : `(no snapshots in ${snapshotDir()})`;
});

def("restore_snapshot", {
  description:
    "Recreate roles and channels from a snapshot that are missing in the target server (matched by name). " +
    "Existing items are never changed or deleted, and messages cannot be restored. " +
    "Roles are matched by name, so with a different target guildId this copies the structure to another server. Defaults to dryRun.",
  inputSchema: {
    guildId: guildId.describe("Target server. Defaults to the snapshot's own server."),
    file: z.string().describe("Snapshot file name (from list_snapshots) or absolute path"),
    dryRun: z.boolean().default(true),
  },
  annotations: WRITE,
}, async (a) => {
  const snap = await readSnapshot(a.file);
  const g = a.guildId || process.env.DISCORD_GUILD_ID || snap.guild;
  const plan = await restoreSnapshot(g, snap, a.dryRun);
  return `${a.dryRun ? "[dry-run]" : "[applied]"} snapshot of ${snap.guild} -> ${g}\n${plan.join("\n")}`;
});

def("export_layout", {
  description:
    "Export the current categories and channels as JSON in the same shape apply_layout takes (including permission overwrites by role name). " +
    "Use it to edit a structure and apply it back, or to reuse it on another server. Member overwrites, uncategorized channels and unsupported channel types are skipped, so do not apply an export with prune=true: it would delete those.",
  inputSchema: { guildId },
  annotations: READ,
}, async (a) => {
  const { layout, notes } = await exportLayout(guildOf(a.guildId));
  return JSON.stringify(layout, null, 2) + (notes.length ? `\n\nNotes:\n${notes.join("\n")}` : "");
});

def("apply_layout", {
  description:
    "Declare the desired structure and apply it in bulk. Matches existing items by name, creates missing ones, moves and updates topics of existing ones, and orders everything as given. " +
    "Defaults to dryRun (shows the plan only). Channels not in the layout are deleted only when prune=true and dryRun=false (a snapshot is saved automatically before a real run). " +
    "private/allowRoles/overwrites apply only to newly created items; use set_permissions for existing ones.",
  inputSchema: {
    guildId,
    categories: z.array(z.object({ name: z.string(), ...placed, channels: z.array(layoutChannel).optional() })),
    dryRun: z.boolean().default(true),
    prune: z.boolean().default(false),
  },
  annotations: DESTRUCTIVE,
}, async (a) => {
  const g = guildOf(a.guildId);
  const head = a.dryRun ? "" : `Snapshot: ${await snapshot(g)}\n`;
  const plan = await applyLayout(g, { categories: a.categories }, { dryRun: a.dryRun, prune: a.prune });
  return `${head}${a.dryRun ? "[dry-run]" : "[applied]"}\n${plan.join("\n")}`;
});
