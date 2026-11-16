import { describe, expect, test } from "bun:test";
import { ChannelType, PermissionFlagsBits as P } from "discord.js";
import { ALL_PERMS, auditPermissions, can, computePermissions } from "../src/access.ts";
import { G, ch, role } from "./fake.ts";

const everyone = role(G, "@everyone", { permissions: String(P.ViewChannel | P.SendMessages | P.ReadMessageHistory | P.AttachFiles | P.EmbedLinks) });
const mod = role("200000000000000001", "Mod", { permissions: String(P.KickMembers) });
const roles = [everyone, mod];
const text = (ows: any[] = []) => ch("300000000000000001", "general", ChannelType.GuildText, { permission_overwrites: ows });
const ow = (id: string, type: number, allow: bigint, deny: bigint) => ({ id, type, allow: String(allow), deny: String(deny) });
const base = { guildId: G, roles, roleIds: [] as string[], userId: "400000000000000001" };

describe("computePermissions", () => {
  test("owner and administrator get everything", () => {
    expect(computePermissions({ ...base, ownerId: base.userId, channel: text([ow(G, 0, 0n, P.ViewChannel)]) })).toBe(ALL_PERMS);
    const admin = role("200000000000000002", "Admin", { permissions: String(P.Administrator) });
    expect(computePermissions({ ...base, roles: [...roles, admin], roleIds: [admin.id], channel: text([ow(G, 0, 0n, P.ViewChannel)]) })).toBe(ALL_PERMS);
  });
  test("role permissions add to @everyone", () => {
    const p = computePermissions({ ...base, roleIds: [mod.id] });
    expect(can(p, "KickMembers", "SendMessages")).toBe(true);
  });
  test("member overwrite beats a role allow; role allow beats an @everyone deny", () => {
    const c = text([ow(G, 0, 0n, P.SendMessages), ow(mod.id, 0, P.SendMessages, 0n), ow(base.userId, 1, 0n, P.SendMessages)]);
    expect(can(computePermissions({ ...base, roleIds: [mod.id], channel: c }), "SendMessages")).toBe(false);
    const c2 = text([ow(G, 0, 0n, P.SendMessages), ow(mod.id, 0, P.SendMessages, 0n)]);
    expect(can(computePermissions({ ...base, roleIds: [mod.id], channel: c2 }), "SendMessages")).toBe(true);
  });
  test("role overwrites combine: a deny on one role loses to an allow on another", () => {
    const other = role("200000000000000003", "Other");
    const c = text([ow(mod.id, 0, 0n, P.SendMessages), ow(other.id, 0, P.SendMessages, 0n)]);
    expect(can(computePermissions({ ...base, roles: [...roles, other], roleIds: [mod.id, other.id], channel: c }), "SendMessages")).toBe(true);
  });
  test("no View Channel means nothing in the channel", () => {
    expect(computePermissions({ ...base, channel: text([ow(G, 0, 0n, P.ViewChannel)]) })).toBe(0n);
  });
  test("a text channel without Send Messages loses attach and embed", () => {
    const p = computePermissions({ ...base, channel: text([ow(G, 0, 0n, P.SendMessages)]) });
    expect(can(p, "ViewChannel", "ReadMessageHistory")).toBe(true);
    expect(can(p, "AttachFiles")).toBe(false);
    expect(can(p, "EmbedLinks")).toBe(false);
  });
  test("timeout keeps only view and history", () => {
    const p = computePermissions({ ...base, roleIds: [mod.id], timedOut: true, channel: text() });
    expect(p).toBe(P.ViewChannel | P.ReadMessageHistory);
  });
  test("a role-only check ignores member overwrites", () => {
    const c = text([ow("400000000000000001", 1, 0n, P.ViewChannel)]);
    expect(can(computePermissions({ guildId: G, roles, roleIds: [mod.id], channel: c }), "ViewChannel")).toBe(true);
  });
  test("overwrites on the category are not inherited", () => {
    const cat = ch("500000000000000001", "Private", ChannelType.GuildCategory, { permission_overwrites: [ow(G, 0, 0n, P.ViewChannel)] });
    const child = ch("300000000000000002", "child", ChannelType.GuildText, { parent_id: cat.id });
    expect(can(computePermissions({ ...base, channel: child }), "ViewChannel")).toBe(true);
  });
});

describe("auditPermissions", () => {
  const rolesBad = [
    role(G, "@everyone", { permissions: String(P.ViewChannel | P.MentionEveryone) }),
    role("200000000000000010", "Boss", { permissions: String(P.Administrator), position: 5 }),
    role("200000000000000011", "Helper", { permissions: String(P.ManageMessages), position: 2 }),
    role("200000000000000012", "Helper", { position: 1 }),
    role("200000000000000013", "BotRole", { permissions: String(P.ManageRoles), position: 3 }),
  ];
  test("flags dangerous bits, duplicates, stale overwrites and role order", () => {
    const chs = [
      ch("300000000000000010", "secret", ChannelType.GuildText, { permission_overwrites: [ow("999999999999999999", 0, P.ViewChannel, 0n)] }),
    ];
    const out = auditPermissions({ guildId: G, roles: rolesBad, channels: chs, botRoleIds: ["200000000000000013"] });
    const text = out.join("\n");
    expect(out[0]).toStartWith("[high]");
    expect(text).toContain("@everyone grants MentionEveryone");
    expect(text).toContain("Boss");
    expect(text).toContain('share the name "Helper"');
    expect(text).toContain("no longer exists");
    expect(text).toContain("sit above the bot's highest role");
  });
  test("a clean server reports nothing", () => {
    expect(auditPermissions({ guildId: G, roles: [everyone], channels: [] })).toEqual([]);
  });
  test("flags a public channel inside a private category", () => {
    const cat = ch("500000000000000002", "Staff", ChannelType.GuildCategory, { permission_overwrites: [ow(G, 0, 0n, P.ViewChannel)] });
    const kid = ch("300000000000000011", "oops", ChannelType.GuildText, { parent_id: cat.id, permission_overwrites: [ow(G, 0, P.ViewChannel, 0n)] });
    expect(auditPermissions({ guildId: G, roles: [everyone], channels: [cat, kid] }).join("\n")).toContain("inside the private category Staff");
  });
});
