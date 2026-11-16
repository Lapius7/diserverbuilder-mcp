import { Routes } from "discord.js";
import { z } from "zod";
import { getRoles, guildOf, permNames, rest } from "../discord.ts";
import { exportLayout, type Layout } from "../layout.ts";
import { snapshot } from "../snapshot.ts";
import { BUILTIN_TEMPLATES, applyTemplate, getTemplate, listSavedTemplates, saveTemplate, templateDir, type Template } from "../templates.ts";
import { DESTRUCTIVE, EDIT, LOCAL, READ, WRITE, def, guildId, withGuildLock } from "../tool.ts";

const count = (l: Layout) => l.categories.length + l.categories.reduce((n, c) => n + (c.channels?.length ?? 0), 0) + (l.uncategorized?.length ?? 0);
const summary = (t: Template, tag: string) => `${t.name} (${tag}): ${t.description} [${t.roles.length} roles, ${count(t.layout)} categories and channels]`;

// ---------- Local templates (files on this computer) ----------

def("list_templates", {
  description:
    "List LOCAL layout templates: the built-in ones (minimal, gaming, study, creator, support) and any you saved with save_template. " +
    "They are roles plus channels stored by this tool, not Discord's own server templates (those are list_guild_templates). Use apply_template to build one.",
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, async () => {
  const saved = await listSavedTemplates();
  return [
    ...Object.values(BUILTIN_TEMPLATES).map((t) => summary(t, "built-in")),
    ...saved.map((t) => summary(t, "saved")),
    ...(saved.length ? [] : [`(no saved templates in ${templateDir()})`]),
  ].join("\n");
});

def("save_template", {
  description:
    "Save a LOCAL layout template (roles plus channels) as a JSON file on this computer, in the config folder's templates directory. Not a Discord server template (see create_guild_template). " +
    "Without categories/roles it copies the current server's roles (without bot-managed roles) and channels. Role names used in permissions must be declared in the roles. " +
    "Name: lowercase letters, digits, - and _. Overwrites a saved template of the same name; built-in names are refused.",
  inputSchema: {
    guildId, name: z.string(), description: z.string().default(""),
    roles: z.array(z.object({ name: z.string(), color: z.number().int().optional(), permissions: z.array(z.string()).optional(), hoist: z.boolean().optional(), mentionable: z.boolean().optional() })).optional(),
    layout: z.object({ categories: z.array(z.any()), uncategorized: z.array(z.any()).optional() }).optional().describe("Same shape as apply_layout's categories and uncategorized"),
  },
  annotations: LOCAL,
}, async (a) => {
  let { roles, layout } = a;
  const notes: string[] = [];
  if (!layout || !roles) {
    const g = guildOf(a.guildId);
    if (!layout) { const ex = await exportLayout(g); layout = ex.layout; notes.push(...ex.notes); }
    if (!roles) {
      roles = (await getRoles(g)).filter((r) => r.id !== g && !r.managed).sort((x, y) => y.position - x.position)
        .map((r) => ({ name: r.name, color: r.color || undefined, hoist: r.hoist || undefined, mentionable: r.mentionable || undefined, permissions: permNames(r.permissions) }));
    }
  }
  const file = await saveTemplate({ name: a.name, description: a.description, roles, layout: layout as Layout });
  return `Saved: ${file}` + (notes.length ? `\nNotes:\n${[...new Set(notes)].join("\n")}` : "");
});

def("apply_template", {
  description:
    "Build a LOCAL template (from list_templates) on a server: creates the template's missing roles, then lays out its channels and categories (matched by name; existing ones are kept, nothing is deleted or removed). " +
    "Safe to repeat: a second run reports nothing to change. Defaults to dryRun; a real run saves a snapshot first. Not the same as Discord's server templates. " +
    "The bot can only give a role permissions it holds itself, so a template whose roles ask for more is refused before anything changes (use the invite link for all tools). Stage channels need a Community server (enable_community); a real run is refused without it.",
  inputSchema: { guildId, name: z.string().describe("A template name from list_templates"), dryRun: z.boolean().default(true) },
  annotations: DESTRUCTIVE,
}, async (a) => {
  const g = guildOf(a.guildId);
  const tpl = await getTemplate(a.name);
  const head = a.dryRun ? "" : `Snapshot: ${await snapshot(g)}\n`;
  const plan = await withGuildLock(g, () => applyTemplate(g, tpl, a.dryRun));
  return `${head}${a.dryRun ? "[dry-run]" : "[applied]"} template ${tpl.name}\n${plan.join("\n")}`;
});

// ---------- Discord's own server templates (discord.new links) ----------

interface GuildTemplate {
  code: string; name: string; description?: string | null; usage_count?: number; is_dirty?: boolean | null;
  created_at?: string; updated_at?: string; source_guild_id?: string; creator?: { username?: string };
}
const show = (t: GuildTemplate) =>
  `${t.name} [${t.code}] https://discord.new/${t.code}\n  ${t.description || "(no description)"}\n  used ${t.usage_count ?? 0} times, updated ${t.updated_at?.slice(0, 10) ?? "?"}` +
  (t.is_dirty ? "\n  UNSYNCED: the server changed since the template was last synced (run sync_guild_template)" : "");

def("list_guild_templates", {
  description:
    "List DISCORD server templates of this server (the discord.new links people can use to start a new server with this one's channels and roles). " +
    "Not the local templates of list_templates. A server has at most one. Needs Manage Server.",
  inputSchema: { guildId },
  annotations: READ,
}, async (a) => {
  const ts = (await rest().get(Routes.guildTemplates(guildOf(a.guildId)))) as GuildTemplate[];
  return ts.map(show).join("\n") || "(this server has no Discord template)";
});

def("get_guild_template", {
  description: "Look up any DISCORD server template by its code (the part after discord.new/). Read-only; works for templates of other servers too.",
  inputSchema: { code: z.string() },
  annotations: READ,
}, async (a) => show((await rest().get(Routes.template(a.code))) as GuildTemplate));

def("create_guild_template", {
  description:
    "Create the DISCORD server template for this server from its current channels and roles (messages and members are not included). " +
    "Discord allows only one template per server (a second create fails with code 30031): use sync_guild_template to refresh it. Needs the Administrator permission.",
  inputSchema: { guildId, name: z.string().min(1).max(100), description: z.string().max(120).optional() },
  annotations: WRITE,
}, async (a) => show((await rest().post(Routes.guildTemplates(guildOf(a.guildId)), { body: { name: a.name, description: a.description } })) as GuildTemplate));

def("sync_guild_template", {
  description: "Update the DISCORD server template to the server's current channels and roles. Needs Manage Server.",
  inputSchema: { guildId, code: z.string() },
  annotations: EDIT,
}, async (a) => show((await rest().put(Routes.guildTemplate(guildOf(a.guildId), a.code))) as GuildTemplate));

def("edit_guild_template", {
  description: "Change the name or description of the DISCORD server template (not its channels; use sync_guild_template for those). Needs Manage Server.",
  inputSchema: { guildId, code: z.string(), name: z.string().min(1).max(100).optional(), description: z.string().max(120).optional() },
  annotations: EDIT,
}, async (a) => show((await rest().patch(Routes.guildTemplate(guildOf(a.guildId), a.code), { body: { name: a.name, description: a.description } })) as GuildTemplate));

def("delete_guild_template", {
  description:
    "Delete the DISCORD server template. The discord.new link stops working and cannot be restored (create a new one for a new code). " +
    "confirmName must match the template's current name. Needs Manage Server.",
  inputSchema: { guildId, code: z.string(), confirmName: z.string() },
  annotations: DESTRUCTIVE,
}, async (a) => {
  const g = guildOf(a.guildId);
  const t = ((await rest().get(Routes.guildTemplates(g))) as GuildTemplate[]).find((x) => x.code === a.code);
  if (!t) throw new Error(`No template with code ${a.code} in this server.`);
  if (t.name !== a.confirmName) throw new Error(`Name mismatch (actual: ${t.name}). Nothing deleted.`);
  await rest().delete(Routes.guildTemplate(g, a.code));
  return `Deleted: ${t.name}`;
});
