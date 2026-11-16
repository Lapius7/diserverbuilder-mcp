import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PermissionFlagsBits, Routes } from "discord.js";
import { configDir } from "./config.ts";
import { applyLayout, type Layout, type LayoutChannel } from "./layout.ts";
import { rest } from "./discord.ts";
import { applyRoles, type RoleSpec } from "./roles.ts";

/** A reusable server blueprint: the roles to have and the channels to lay out. Role names in the layout must be declared in `roles` (or be "@everyone"). */
export interface Template {
  name: string;
  description: string;
  roles: RoleSpec[];
  layout: Layout;
}

export const templateDir = () => join(configDir(), "templates");
export const TEMPLATE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// ---------- Built-in templates ----------

const STAFF = ["ManageMessages", "KickMembers", "ModerateMembers", "MoveMembers", "MuteMembers", "ManageNicknames", "ViewAuditLog"];
const ADMIN = ["ManageGuild", "ManageRoles", "ManageChannels", "ManageWebhooks", "ManageEvents", "ManageGuildExpressions", "BanMembers"];
const staffRoles = (extra: RoleSpec[] = []): RoleSpec[] => [
  // Not "Administrator": a bot can only give a role permissions it holds itself, and the invite link in the README does not grant Administrator.
  { name: "Admin", color: 0xe74c3c, hoist: true, permissions: [...ADMIN, ...STAFF] },
  { name: "Moderator", color: 0x3498db, hoist: true, permissions: STAFF },
  ...extra,
];
const t = (name: string, topic?: string, more: Partial<LayoutChannel> = {}): LayoutChannel => ({ name, type: "text", topic, ...more });
const v = (name: string, more: Partial<LayoutChannel> = {}): LayoutChannel => ({ name, type: "voice", ...more });
const readOnly = (name: string, topic: string): LayoutChannel => t(name, topic, { overwrites: [{ role: "@everyone", deny: ["SendMessages"] }] });
const staffOnly = { private: true, allowRoles: ["Moderator", "Admin"] };

export const BUILTIN_TEMPLATES: Record<string, Template> = {
  minimal: {
    name: "minimal",
    description: "Small start: a welcome area, one chat and one voice channel, and a private staff channel.",
    roles: staffRoles(),
    layout: {
      categories: [
        { name: "Welcome", channels: [readOnly("rules", "Read before you chat"), readOnly("announcements", "News from the team")] },
        { name: "Chat", channels: [t("general", "Talk about anything"), v("Lounge")] },
        { name: "Staff", ...staffOnly, channels: [t("staff-chat", "Moderators only")] },
      ],
    },
  },
  gaming: {
    name: "gaming",
    description: "Gaming community: info, general chat, looking-for-group, voice rooms, a stage for events, and staff.",
    roles: staffRoles([
      { name: "Member", color: 0x2ecc71 },
      { name: "Event Host", color: 0xf1c40f, mentionable: true },
    ]),
    layout: {
      categories: [
        { name: "Info", channels: [readOnly("rules", "Server rules"), readOnly("announcements", "News and updates"), t("introductions", "Say hello")] },
        { name: "Community", channels: [t("general", "Chat about anything"), t("clips-and-memes", "Share your best moments"), { name: "looking-for-group", type: "forum", topic: "Find people to play with", forumTags: ["ranked", "casual", "event"] }] },
        { name: "Voice", channels: [v("Lobby"), v("Squad 1", { userLimit: 5 }), v("Squad 2", { userLimit: 5 }), { name: "Event Stage", type: "stage" }] },
        { name: "Staff", ...staffOnly, channels: [t("staff-chat", "Moderators only"), t("mod-log", "Moderation notes")] },
      ],
    },
  },
  study: {
    name: "study",
    description: "Study group: announcements, subject channels, a Q&A forum, quiet study voice rooms, and staff.",
    roles: staffRoles([{ name: "Student", color: 0x9b59b6 }, { name: "Tutor", color: 0x1abc9c, hoist: true, mentionable: true }]),
    layout: {
      categories: [
        { name: "Start Here", channels: [readOnly("rules", "How this group works"), readOnly("announcements", "Schedules and news"), t("introductions", "Tell us what you study")] },
        { name: "Study", channels: [t("general-study", "Share progress and plans"), t("resources", "Useful links and notes"), { name: "questions", type: "forum", topic: "Ask a question, one per post", forumTags: ["solved", "open"] }] },
        { name: "Study Rooms", channels: [v("Silent Study"), v("Group Work", { userLimit: 8 }), v("Break Room")] },
        { name: "Staff", ...staffOnly, channels: [t("staff-chat", "Tutors and moderators")] },
      ],
    },
  },
  creator: {
    name: "creator",
    description: "Creator and fan community: announcements, a showcase, fan chat, a supporter-only area, and staff.",
    roles: staffRoles([{ name: "Supporter", color: 0xe91e63, hoist: true }, { name: "Fan", color: 0x2ecc71 }]),
    layout: {
      categories: [
        { name: "Welcome", channels: [readOnly("rules", "Server rules"), readOnly("announcements", "New posts and streams"), t("introductions", "Say hello")] },
        { name: "Community", channels: [t("fan-chat", "Chat with other fans"), { name: "showcase", type: "media", topic: "Fan art and clips" }, t("off-topic", "Anything else")] },
        { name: "Supporters", private: true, allowRoles: ["Supporter", "Moderator", "Admin"], channels: [t("supporter-lounge", "Thank you for supporting"), v("Supporter Voice")] },
        { name: "Staff", ...staffOnly, channels: [t("staff-chat", "Moderators only")] },
      ],
    },
  },
  support: {
    name: "support",
    description: "Project or product support: announcements, a help forum, a feedback channel, a bug-report forum, and a team area.",
    roles: staffRoles([{ name: "Maintainer", color: 0xe67e22, hoist: true, mentionable: true }, { name: "Contributor", color: 0x1abc9c }]),
    layout: {
      categories: [
        { name: "Info", channels: [readOnly("rules", "Be kind, search before you ask"), readOnly("announcements", "Releases and news"), t("introductions", "Who are you building for?")] },
        { name: "Help", channels: [{ name: "help", type: "forum", topic: "One question per post", forumTags: ["solved", "needs-info", "question"] }, { name: "bug-reports", type: "forum", topic: "Steps to reproduce, expected and actual result", forumTags: ["bug", "confirmed", "fixed"] }, t("feedback", "Ideas and feature requests")] },
        { name: "Community", channels: [t("general", "Anything about the project"), t("showcase", "Show what you made"), v("Office Hours")] },
        { name: "Team", ...staffOnly, allowRoles: ["Moderator", "Admin", "Maintainer"], channels: [t("team-chat", "Maintainers and moderators"), t("triage", "Sort new reports")] },
      ],
    },
  },
};

// ---------- Validation ----------

const allChannels = (l: Layout): { owner: { private?: boolean; allowRoles?: string[]; overwrites?: { role: string }[] }; label: string }[] => [
  ...l.categories.flatMap((c) => [{ owner: c, label: c.name }, ...(c.channels ?? []).map((x) => ({ owner: x, label: `${c.name}/${x.name}` }))]),
  ...(l.uncategorized ?? []).map((x) => ({ owner: x, label: x.name })),
];

/** Problems that would make applying fail or behave oddly. Empty means the template is sound. */
export function validateTemplate(tpl: Template): string[] {
  const errs: string[] = [];
  const known = new Set(tpl.roles.map((r) => r.name.toLowerCase()));
  const seen = new Set<string>();
  for (const r of tpl.roles) {
    if (seen.has(r.name.toLowerCase())) errs.push(`role "${r.name}" is declared twice`);
    seen.add(r.name.toLowerCase());
    for (const p of r.permissions ?? []) if (!(p in PermissionFlagsBits)) errs.push(`role "${r.name}": unknown permission ${p}`);
  }
  const ok = (ref: string) => ref.toLowerCase() === "@everyone" || known.has(ref.toLowerCase()) || /^\d{15,25}$/.test(ref);
  for (const { owner, label } of allChannels(tpl.layout)) {
    for (const ref of [...(owner.allowRoles ?? []), ...(owner.overwrites ?? []).map((o) => o.role)]) {
      if (!ok(ref)) errs.push(`${label}: role "${ref}" is not declared in roles`);
    }
  }
  const names = new Set<string>();
  for (const c of tpl.layout.categories) {
    if (names.has(c.name.toLowerCase())) errs.push(`category "${c.name}" appears twice`);
    names.add(c.name.toLowerCase());
  }
  return errs;
}

// ---------- Local storage ----------

export async function saveTemplate(tpl: Template): Promise<string> {
  if (!TEMPLATE_NAME.test(tpl.name)) throw new Error(`Template name must match ${TEMPLATE_NAME} (lowercase letters, digits, - and _).`);
  if (tpl.name in BUILTIN_TEMPLATES) throw new Error(`"${tpl.name}" is a built-in template name. Pick another.`);
  const errs = validateTemplate(tpl);
  if (errs.length) throw new Error(`Template is not valid:\n${errs.join("\n")}`);
  await mkdir(templateDir(), { recursive: true });
  const file = join(templateDir(), `${tpl.name}.json`);
  await writeFile(file, JSON.stringify(tpl, null, 2) + "\n");
  return file;
}

export async function listSavedTemplates(): Promise<Template[]> {
  let files: string[] = [];
  try { files = (await readdir(templateDir())).filter((f) => f.endsWith(".json")); } catch { return []; }
  const out: Template[] = [];
  for (const f of files.sort()) {
    try { out.push(JSON.parse(await readFile(join(templateDir(), f), "utf8")) as Template); } catch { /* skip unreadable file */ }
  }
  return out;
}

/** A built-in template, or a saved one. A saved template with a built-in's name never shadows it (save refuses that name). */
export async function getTemplate(name: string): Promise<Template> {
  const key = name.toLowerCase();
  const b = BUILTIN_TEMPLATES[key];
  if (b) return b;
  if (!TEMPLATE_NAME.test(key)) throw new Error(`Unknown template "${name}".`);
  try {
    return JSON.parse(await readFile(join(templateDir(), `${key}.json`), "utf8")) as Template;
  } catch {
    throw new Error(`Unknown template "${name}". Built-in: ${Object.keys(BUILTIN_TEMPLATES).join(", ")}. Use list_templates to see saved ones.`);
  }
}

// ---------- Apply ----------

/** Create the template's missing roles, then lay out its channels. A dry run plans both without touching anything. Never deletes. */
export async function applyTemplate(g: string, tpl: Template, dryRun: boolean): Promise<string[]> {
  const errs = validateTemplate(tpl);
  if (errs.length) throw new Error(`Template "${tpl.name}" is not valid:\n${errs.join("\n")}`);
  const needs = (["stage"] as const).filter((k) => allChannels(tpl.layout).some(({ owner }) => (owner as { type?: string }).type === k));
  const soft = (["forum", "media"] as const).filter((k) => allChannels(tpl.layout).some(({ owner }) => (owner as { type?: string }).type === k));
  const notes: string[] = [];
  if (needs.length || soft.length) {
    const guild = (await rest().get(Routes.guild(g))) as { features?: string[] };
    if (!(guild.features ?? []).includes("COMMUNITY")) {
      if (needs.length) {
        const msg = `! Stage channels need a Community server, and this server is not one yet. Run enable_community first (it is a dry run by default).`;
        if (!dryRun) throw new Error(`Nothing was changed.\n${msg}`);
        notes.push(msg);
      }
      if (soft.length) notes.push(`! ${soft.join(" and ")} channels may also need a Community server (enable_community).`);
    }
  }
  const { plan: rolePlan, planned } = await applyRoles(g, tpl.roles, dryRun);
  const layoutPlan = await applyLayout(g, tpl.layout, { dryRun, prune: false, syncPermissions: "off", extraRoles: planned });
  const changed = (l: string) => /^[+~#!-]/.test(l);
  const roleLines = rolePlan.filter(changed);
  const layoutLines = layoutPlan.filter((l) => !l.startsWith("Nothing to change"));
  if (!roleLines.length && !layoutLines.some(changed)) return ["Nothing to change: the server already has this template's roles and channels.", ...notes];
  return [...notes, ...roleLines.length ? ["Roles:", ...roleLines] : [], ...layoutLines.length ? ["Channels:", ...layoutLines] : []];
}
