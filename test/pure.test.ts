import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { PermissionFlagsBits as P } from "discord.js";
import { buildActions, checkTrigger, describeRule, metadataFrom } from "../src/automod.ts";
import { buildOverwrites, diffOverwrites, resolveRole } from "../src/discord.ts";
import { GROUPS, GROUP_OF, enabledGroups } from "../src/groups.ts";
import { BULK_MAX_AGE_MS, chunk, selectPurge } from "../src/purge.ts";
import { diffSnapshots, type SnapshotData } from "../src/snapshot.ts";
import { TOOL_MODULES } from "../src/tools/index.ts";
import { G, role } from "./fake.ts";

const roles = [role("1".repeat(18), "Mod"), role("2".repeat(18), "Twin"), role("3".repeat(18), "twin")];

describe("resolveRole", () => {
  test("by ID, name (any case) and @everyone", () => {
    expect(resolveRole(G, roles, "1".repeat(18))).toBe("1".repeat(18));
    expect(resolveRole(G, roles, "mod")).toBe("1".repeat(18));
    expect(resolveRole(G, roles, "@Everyone")).toBe(G);
  });
  test("duplicate names and unknown names throw", () => {
    expect(() => resolveRole(G, roles, "twin")).toThrow(/Pass the role ID/);
    expect(() => resolveRole(G, roles, "nope")).toThrow(/not found/);
  });
});

describe("buildOverwrites", () => {
  test("private hides from @everyone and shows to allowRoles; member overwrites use type 1", () => {
    const o = buildOverwrites(G, roles, { private: true, allowRoles: ["Mod"], memberOverwrites: [{ userId: "9".repeat(18), allow: ["SendMessages"] }] })!;
    expect(o).toContainEqual({ id: G, type: 0, allow: "0", deny: String(P.ViewChannel) });
    expect(o).toContainEqual({ id: "1".repeat(18), type: 0, allow: String(P.ViewChannel), deny: "0" });
    expect(o).toContainEqual({ id: "9".repeat(18), type: 1, allow: String(P.SendMessages), deny: "0" });
  });
  test("nothing declared gives undefined", () => expect(buildOverwrites(G, roles, {})).toBeUndefined());
  test("unknown permission names throw", () => {
    expect(() => buildOverwrites(G, roles, { overwrites: [{ role: "Mod", allow: ["Fly"] }] })).toThrow(/Unknown permission/);
  });
});

describe("diffOverwrites", () => {
  const name = (o: { id: string }) => o.id;
  const cur = [{ id: "a", type: 0, allow: "1", deny: "0" }, { id: "u", type: 1, allow: "2", deny: "0" }];
  test("no change gives no lines", () => {
    expect(diffOverwrites(cur, [{ id: "a", type: 0, allow: "1", deny: "0" }], "replace", name).changes).toEqual([]);
  });
  test("merge keeps unrelated bits; replace sets exactly", () => {
    const want = [{ id: "a", type: 0, allow: "4", deny: "0" }];
    expect(diffOverwrites(cur, want, "merge", name).next.find((o) => o.id === "a")!.allow).toBe("5");
    expect(diffOverwrites(cur, want, "replace", name).next.find((o) => o.id === "a")!.allow).toBe("4");
  });
  test("replace drops undeclared role overwrites but keeps members", () => {
    const { next } = diffOverwrites(cur, [{ id: "b", type: 0, allow: "1", deny: "0" }], "replace", name);
    expect(next.map((o) => o.id).sort()).toEqual(["b", "u"]);
  });
});

describe("automod builders", () => {
  test("metadata only includes what was passed", () => {
    expect(metadataFrom({ keywords: ["x"], presets: ["slurs"] })).toEqual({ keyword_filter: ["x"], presets: [3] });
  });
  test("checkTrigger requires and rejects settings per trigger", () => {
    expect(() => checkTrigger("keyword", {})).toThrow(/need keywords/);
    expect(() => checkTrigger("keyword_preset", {})).toThrow(/need presets/);
    expect(() => checkTrigger("mention_spam", {})).toThrow(/mentionLimit/);
    expect(() => checkTrigger("spam", { keyword_filter: ["x"] })).toThrow(/spam rules take no/);
    expect(() => checkTrigger("keyword", { keyword_filter: ["x"], presets: [1] })).toThrow(/only work/);
    expect(() => checkTrigger("keyword", { keyword_filter: ["x"], keyword_filter2: [] })).not.toThrow();
    expect(() => checkTrigger("spam", { keyword_filter: [], presets: [] })).not.toThrow();
  });
  test("actions are validated per trigger and timeout is capped at 28 days", () => {
    expect(() => buildActions("spam", { timeoutMinutes: 5 })).toThrow(/does not allow the timeout/);
    expect(() => buildActions("keyword", { blockMemberInteraction: true })).toThrow(/does not allow/);
    expect(buildActions("keyword", { timeoutMinutes: 99999999 })![0]).toMatchObject({ type: 3, metadata: { duration_seconds: 2419200 } });
    expect(buildActions("keyword", {})).toBeUndefined();
  });
  test("describeRule gives one line", () => {
    const l = describeRule({ id: "1", name: "r", trigger_type: 1, enabled: true, actions: [{ type: 1 }], trigger_metadata: { keyword_filter: ["a", "b"] } });
    expect(l).toBe("r 1 [keyword] on actions=block_message 2 keyword(s)");
  });
});

describe("selectPurge", () => {
  const now = Date.UTC(2026, 0, 30);
  const idAt = (ms: number) => String((BigInt(ms - 1420070400000) << 22n));
  const day = 86400_000;
  const msg = (age: number, extra: object = {}) => ({ id: idAt(now - age), author: { id: "u1" }, content: "Hello", ...extra });
  test("splits recent and too old (14 days)", () => {
    const r = selectPurge([msg(day), msg(13 * day), msg(15 * day)], {}, now);
    expect(r.recent).toHaveLength(2);
    expect(r.old).toHaveLength(1);
    expect(BULK_MAX_AGE_MS).toBeLessThan(14 * day);
  });
  test("filters and pinned handling", () => {
    const ms = [msg(day, { pinned: true }), msg(day, { author: { id: "b", bot: true } }), msg(day, { content: "spam here" })];
    expect(selectPurge(ms, {}, now)).toMatchObject({ skippedPinned: 1, recent: expect.any(Array) });
    expect(selectPurge(ms, { includePinned: true }, now).recent).toHaveLength(3);
    expect(selectPurge(ms, { onlyBots: true }, now).recent).toHaveLength(1);
    expect(selectPurge(ms, { contains: "SPAM" }, now).recent).toHaveLength(1);
    expect(selectPurge(ms, { fromUserId: "b" }, now).recent).toHaveLength(1);
  });
  test("chunk splits into groups of the given size", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 100)).toEqual([]);
  });
});

describe("tool groups", () => {
  test("every registered tool belongs to a group, and every grouped tool exists", async () => {
    const { registered } = await import("../src/tool.ts");
    for (const load of Object.values(TOOL_MODULES)) await load();
    const missing = registered.filter((n) => !(n in GROUP_OF));
    const ghosts = Object.keys(GROUP_OF).filter((n) => !registered.includes(n));
    expect(missing).toEqual([]);
    expect(ghosts).toEqual([]);
    expect(new Set(registered).size).toBe(registered.length);
  });
  test("every file in tools/ is listed in TOOL_MODULES", () => {
    const files = readdirSync(new URL("../src/tools", import.meta.url)).filter((f) => f.endsWith(".ts") && f !== "index.ts").map((f) => f.replace(/\.ts$/, ""));
    expect(Object.keys(TOOL_MODULES).sort()).toEqual(files.sort());
  });
  test("no tool is in two groups", () => {
    const all = Object.values(GROUPS).flat();
    expect(new Set(all).size).toBe(all.length);
  });
  test("enabledGroups parses the env value", () => {
    expect(enabledGroups("")).toBeUndefined();
    expect(enabledGroups("all")).toBeUndefined();
    expect([...enabledGroups("Roles, backup")!].sort()).toEqual(["backup", "roles"]);
    expect(enabledGroups("typo")).toBeUndefined(); // only unknown names: fall back to all tools
  });
});

describe("diffSnapshots", () => {
  const base = (): SnapshotData => ({ guild: G, roles: [role("1", "Mod")] as any, channels: [], emojis: [], stickers: [], events: [], automod: [] } as any);
  test("reports added, removed and changed items", () => {
    const a = base(), b = base();
    b.roles = [role("1", "Moderator"), role("2", "New")] as any;
    const d = diffSnapshots(a, b);
    expect(d.some((l) => l.startsWith("+ role") && l.includes("New"))).toBe(true);
    expect(d.some((l) => l.startsWith("~ role") && l.includes("name"))).toBe(true);
  });
  test("identical snapshots have no differences, and an old-format snapshot (no extras) still compares", () => {
    expect(diffSnapshots(base(), base())).toEqual([]);
    const old = { guild: G, roles: [], channels: [] } as unknown as SnapshotData;
    expect(() => diffSnapshots(old, base())).not.toThrow();
  });
});
