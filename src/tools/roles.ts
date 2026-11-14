import { Routes } from "discord.js";
import { z } from "zod";
import { getRoles, guildOf, permBits, permNames, rest, type Role } from "../discord.ts";
import { snapshot } from "../discord.ts";
import { DESTRUCTIVE, EDIT, READ, WRITE, def, guildId } from "../tool.ts";

const roleFields = {
  color: z.number().int().optional().describe("Color as a 0xRRGGBB number"),
  permissions: z.array(z.string()).optional().describe("Permission names, e.g. ManageMessages. Replaces the role's permissions."),
  hoist: z.boolean().optional().describe("Show members separately in the member list"),
  mentionable: z.boolean().optional(),
};
const roleBody = (a: { color?: number; permissions?: string[]; hoist?: boolean; mentionable?: boolean }) => ({
  color: a.color, permissions: a.permissions ? permBits(a.permissions) : undefined, hoist: a.hoist, mentionable: a.mentionable,
});

def("list_roles", {
  description: "List roles (ID and name), highest first. showPermissions adds each role's permission names.",
  inputSchema: { guildId, showPermissions: z.boolean().default(false) },
  annotations: READ,
}, async (a) =>
  (await getRoles(guildOf(a.guildId))).sort((x, y) => y.position - x.position)
    .map((r) => `${r.name} ${r.id}${r.managed ? " (managed)" : ""}${a.showPermissions ? `\n  ${permNames(r.permissions).join(", ") || "-"}` : ""}`)
    .join("\n"));

def("create_role", {
  description: "Create a role. The bot cannot grant permissions it does not have itself.",
  inputSchema: { guildId, name: z.string().max(100), ...roleFields },
  annotations: WRITE,
}, async (a) => {
  const r = (await rest().post(Routes.guildRoles(guildOf(a.guildId)), { body: { name: a.name, ...roleBody(a) } })) as Role;
  return `Created: ${r.name} ${r.id}`;
});

def("edit_role", {
  description: "Change a role (only the fields you pass). permissions replaces the whole permission set.",
  inputSchema: { guildId, roleId: z.string(), name: z.string().max(100).optional(), ...roleFields },
  annotations: EDIT,
}, async (a) => {
  const r = (await rest().patch(Routes.guildRole(guildOf(a.guildId), a.roleId), { body: { name: a.name, ...roleBody(a) } })) as Role;
  return `Updated: ${r.name} ${r.id}`;
});

def("delete_role", {
  description: "Delete a role. It is removed from every member. confirmName must exactly match the current name. Take a snapshot first.",
  inputSchema: { guildId, roleId: z.string(), confirmName: z.string() },
  annotations: DESTRUCTIVE,
}, async (a) => {
  const g = guildOf(a.guildId);
  const r = (await getRoles(g)).find((x) => x.id === a.roleId);
  if (!r) throw new Error(`Role ${a.roleId} not found in server ${g}. Nothing deleted.`);
  if (r.name !== a.confirmName) throw new Error(`Name mismatch (actual: ${r.name}). Nothing deleted.`);
  await rest().delete(Routes.guildRole(g, a.roleId));
  return `Deleted: ${r.name}`;
});

def("reorder_roles", {
  description: "Change role positions. Higher position = higher in the list. The bot can only move roles below its own highest role.",
  inputSchema: { guildId, items: z.array(z.object({ id: z.string(), position: z.number().int().min(0) })).min(1) },
  annotations: EDIT,
}, async (a) => {
  await rest().patch(Routes.guildRoles(guildOf(a.guildId)), { body: a.items });
  return `Updated the position of ${a.items.length} role(s)`;
});

def("apply_roles", {
  description:
    "Declare roles and apply them in bulk. Matches existing roles by name: creates missing ones and updates changed fields. " +
    "Never deletes roles and ignores managed (bot/integration) roles. Defaults to dryRun; a real run saves a snapshot first.",
  inputSchema: {
    guildId,
    roles: z.array(z.object({ name: z.string().max(100), ...roleFields })).min(1),
    dryRun: z.boolean().default(true),
  },
  annotations: DESTRUCTIVE,
}, async (a) => {
  const g = guildOf(a.guildId);
  const head = a.dryRun ? "" : `Snapshot: ${await snapshot(g)}\n`;
  const current = await getRoles(g);
  const plan: string[] = [];
  for (const want of a.roles) {
    const ex = current.find((r) => !r.managed && r.id !== g && r.name.toLowerCase() === want.name.toLowerCase());
    if (!ex) {
      plan.push(`+ create: ${want.name}`);
      if (!a.dryRun) await rest().post(Routes.guildRoles(g), { body: { name: want.name, ...roleBody(want) } });
      continue;
    }
    const patch: Record<string, unknown> = {};
    if (want.color !== undefined && want.color !== ex.color) patch.color = want.color;
    if (want.permissions && permBits(want.permissions) !== ex.permissions) patch.permissions = permBits(want.permissions);
    if (want.hoist !== undefined && want.hoist !== !!ex.hoist) patch.hoist = want.hoist;
    if (want.mentionable !== undefined && want.mentionable !== !!ex.mentionable) patch.mentionable = want.mentionable;
    if (!Object.keys(patch).length) { plan.push(`= unchanged: ${ex.name}`); continue; }
    plan.push(`~ update: ${ex.name} ${Object.keys(patch).join(", ")}`);
    if (!a.dryRun) await rest().patch(Routes.guildRole(g, ex.id), { body: patch });
  }
  return `${head}${a.dryRun ? "[dry-run]" : "[applied]"}\n${plan.join("\n")}`;
});

def("search_members", {
  description: "Search members by username or nickname prefix. Returns user IDs and their role IDs. Needs the bot to be able to list members.",
  inputSchema: { guildId, query: z.string(), limit: z.number().int().min(1).max(100).default(10) },
  annotations: READ,
}, async (a) => {
  const ms = (await rest().get(Routes.guildMembersSearch(guildOf(a.guildId)), {
    query: new URLSearchParams({ query: a.query, limit: String(a.limit) }),
  })) as { user: { id: string; username: string; global_name?: string | null }; nick?: string | null; roles: string[] }[];
  return ms.map((m) => `${m.nick ?? m.user.global_name ?? m.user.username} (@${m.user.username}) ${m.user.id} roles=[${m.roles}]`).join("\n") || "(no match)";
});

def("add_member_role", {
  description: "Give a role to a member.",
  inputSchema: { guildId, userId: z.string(), roleId: z.string() },
  annotations: EDIT,
}, async (a) => {
  await rest().put(Routes.guildMemberRole(guildOf(a.guildId), a.userId, a.roleId));
  return "Added";
});

def("remove_member_role", {
  description: "Remove a role from a member.",
  inputSchema: { guildId, userId: z.string(), roleId: z.string() },
  annotations: EDIT,
}, async (a) => {
  await rest().delete(Routes.guildMemberRole(guildOf(a.guildId), a.userId, a.roleId));
  return "Removed";
});
