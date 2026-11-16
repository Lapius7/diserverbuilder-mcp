import { Routes } from "discord.js";
import { getRoles, permBits, permNames, rest, type Member, type Role } from "./discord.ts";
import { computePermissions } from "./access.ts";

export interface RoleSpec { name: string; color?: number; permissions?: string[]; hoist?: boolean; mentionable?: boolean }

export const roleBody = (a: Omit<RoleSpec, "name">) => ({
  color: a.color, permissions: a.permissions ? permBits(a.permissions) : undefined, hoist: a.hoist, mentionable: a.mentionable,
});

/** What the bot can do server-wide, or undefined when it cannot be read (the checks that need it are then skipped). */
export async function botPermissions(g: string, roles: Role[]): Promise<bigint | undefined> {
  try {
    const me = (await rest().get(Routes.user())) as { id: string };
    const member = (await rest().get(Routes.guildMember(g, me.id))) as Member;
    const guild = (await rest().get(Routes.guild(g))) as { owner_id?: string };
    return computePermissions({ guildId: g, ownerId: guild.owner_id, roles, roleIds: member.roles, userId: me.id });
  } catch { return undefined; }
}

/**
 * Create the missing roles and update the changed ones (matched by name). Never deletes.
 * `planned` lists the roles a dry run would create, with placeholder IDs ("new:<name>"), so callers can resolve names that do not exist yet.
 */
export async function applyRoles(g: string, wanted: RoleSpec[], dryRun: boolean): Promise<{ plan: string[]; planned: Role[] }> {
  const current = await getRoles(g);
  const plan: string[] = [];
  const planned: Role[] = [];
  // Discord refuses (50013) a role that carries a permission the bot does not hold itself. Find those first so a real run changes nothing.
  const mine = await botPermissions(g, current);
  const ungrantable: string[] = [];
  if (mine !== undefined) {
    for (const want of wanted) {
      if (!want.permissions) continue;
      const ex = current.find((r) => !r.managed && r.id !== g && r.name.toLowerCase() === want.name.toLowerCase());
      const missing = BigInt(permBits(want.permissions)) & ~BigInt(ex?.permissions ?? "0") & ~mine;
      if (missing) ungrantable.push(`! ${want.name}: needs ${permNames(missing).join(", ")}, which the bot does not hold. Discord only lets a bot give a role permissions it has itself: give the bot those permissions, or remove them from the role`);
    }
    if (ungrantable.length && !dryRun) throw new Error(`Nothing was changed.\n${ungrantable.join("\n")}`);
  }
  plan.push(...ungrantable);
  for (const want of wanted) {
    const hits = current.filter((r) => !r.managed && r.id !== g && r.name.toLowerCase() === want.name.toLowerCase());
    if (hits.length > 1) { plan.push(`! skipped: ${want.name} matches ${hits.length} roles (${hits.map((r) => r.id).join(", ")}); rename or delete the duplicates first`); continue; }
    const ex = hits[0];
    if (!ex) {
      plan.push(`+ create: ${want.name}`);
      if (dryRun) planned.push({ id: `new:${want.name}`, name: want.name, position: 0, permissions: permBits(want.permissions) });
      else await rest().post(Routes.guildRoles(g), { body: { name: want.name, ...roleBody(want) } });
      continue;
    }
    const patch: Record<string, unknown> = {};
    if (want.color !== undefined && want.color !== ex.color) patch.color = want.color;
    if (want.permissions && permBits(want.permissions) !== ex.permissions) patch.permissions = permBits(want.permissions);
    if (want.hoist !== undefined && want.hoist !== !!ex.hoist) patch.hoist = want.hoist;
    if (want.mentionable !== undefined && want.mentionable !== !!ex.mentionable) patch.mentionable = want.mentionable;
    if (!Object.keys(patch).length) { plan.push(`= unchanged: ${ex.name}`); continue; }
    plan.push(`~ update: ${ex.name} ${Object.keys(patch).join(", ")}`);
    if (!dryRun) await rest().patch(Routes.guildRole(g, ex.id), { body: patch });
  }
  return { plan, planned };
}
