import { beforeEach, describe, expect, test } from "bun:test";
import { PermissionFlagsBits as P } from "discord.js";
import { applyLayout, exportLayout, restoreSnapshot } from "../src/layout.ts";
import { FakeDiscord, G, ch, role } from "./fake.ts";

const MOD = "100000000000000001", MEMBER = "100000000000000002", DUP1 = "100000000000000003", DUP2 = "100000000000000004";
const USER = "200000000000000001";
const view = String(P.ViewChannel), send = String(P.SendMessages);

let fake: FakeDiscord;
beforeEach(() => {
  fake = new FakeDiscord().install();
  fake.roles.push(role(MOD, "Mod"), role(MEMBER, "Member"), role(DUP1, "Twin"), role(DUP2, "twin"));
  fake.channels.push(
    ch("300000000000000001", "General", 4, { position: 0 }),
    ch("300000000000000002", "chat", 0, {
      parent_id: "300000000000000001", position: 0, topic: "hello", rate_limit_per_user: 5,
      permission_overwrites: [
        { id: G, type: 0, allow: "0", deny: view },
        { id: MEMBER, type: 0, allow: view, deny: "0" },
        { id: DUP1, type: 0, allow: send, deny: "0" },
        { id: USER, type: 1, allow: send, deny: "0" },
      ],
    }),
    ch("300000000000000003", "Lounge", 2, { parent_id: "300000000000000001", position: 1, user_limit: 10, bitrate: 96000 }),
    ch("300000000000000004", "ideas", 15, { parent_id: "300000000000000001", position: 2, available_tags: [{ id: "1", name: "bug" }, { id: "2", name: "idea" }] }),
    ch("300000000000000005", "rules", 0, { position: 0, topic: "read me" }),
    ch("300000000000000006", "Staff", 4, { position: 1, permission_overwrites: [{ id: G, type: 0, allow: "0", deny: view }, { id: MOD, type: 0, allow: view, deny: "0" }] }),
    ch("300000000000000007", "mod-chat", 0, { parent_id: "300000000000000006", position: 0 }),
  );
});

const changes = (plan: string[]) => plan.filter((l) => /^[+~>#-] /.test(l) || l.startsWith("= "));

describe("export then apply round trip", () => {
  for (const mode of ["off", "merge", "replace"] as const) {
    test(`dry run reports nothing to change (syncPermissions=${mode})`, async () => {
      const { layout } = await exportLayout(G, { includeMembers: true });
      const plan = await applyLayout(G, layout, { dryRun: true, prune: true, syncPermissions: mode });
      expect(changes(plan)).toEqual([]);
      expect(plan[0]).toStartWith("Nothing to change");
    });
  }

  test("a real run of an unchanged layout makes no changes on Discord", async () => {
    const { layout } = await exportLayout(G, { includeMembers: true });
    fake.calls.length = 0;
    await applyLayout(G, layout, { dryRun: false, prune: true, syncPermissions: "replace" });
    expect(fake.mutating()).toEqual([]);
  });

  test("export includes uncategorized channels, media-capable kinds, forum tags and voice limits", async () => {
    const { layout, notes } = await exportLayout(G);
    expect(layout.uncategorized).toEqual([{ name: "rules", topic: "read me" }]);
    const general = layout.categories.find((c) => c.name === "General")!;
    expect(general.channels).toContainEqual({ name: "Lounge", type: "voice", userLimit: 10, bitrate: 96000 });
    expect(general.channels?.find((c) => c.name === "ideas")).toMatchObject({ type: "forum", forumTags: ["bug", "idea"] });
    expect(notes.some((n) => n.includes("member overwrite"))).toBe(true);
  });

  test("roles that share a name are exported by ID", async () => {
    const { layout } = await exportLayout(G);
    const chat = layout.categories[0]!.channels!.find((c) => c.name === "chat")!;
    expect(chat.overwrites?.map((o) => o.role)).toEqual(["@everyone", "Member", DUP1]);
  });

  test("includeMembers exports member overwrites", async () => {
    const { layout } = await exportLayout(G, { includeMembers: true });
    expect(layout.categories[0]!.channels![0]!.memberOverwrites).toEqual([{ userId: USER, allow: ["SendMessages"] }]);
  });
});

describe("applyLayout", () => {
  test("creates missing items and orders them", async () => {
    const plan = await applyLayout(G, { categories: [{ name: "New", channels: [{ name: "welcome", topic: "hi", slowmode: 10 }] }] }, { dryRun: false, prune: false });
    expect(plan).toContain("+ create: category New");
    expect(plan.some((l) => l.startsWith("+ create: text welcome"))).toBe(true);
    const made = fake.channels.find((c) => c.name === "welcome")!;
    expect(made).toMatchObject({ topic: "hi", rate_limit_per_user: 10 });
    expect(made.parent_id).toBe(fake.channels.find((c) => c.name === "New")!.id);
  });

  test("updates topic, slowmode, voice limit and forum tags on existing channels", async () => {
    const plan = await applyLayout(G, {
      categories: [{ name: "General", channels: [
        { name: "chat", slowmode: 0 }, { name: "Lounge", type: "voice", userLimit: 5 }, { name: "ideas", type: "forum", forumTags: ["idea", "new"] },
      ] }],
    }, { dryRun: false, prune: false });
    expect(plan.filter((l) => l.startsWith("~ update"))).toHaveLength(3);
    expect(fake.channels.find((c) => c.name === "chat")!.rate_limit_per_user).toBe(0);
    expect(fake.channels.find((c) => c.name === "Lounge")!.user_limit).toBe(5);
    const tags = fake.channels.find((c) => c.name === "ideas")!.available_tags;
    expect(tags).toEqual([{ id: "2", name: "idea" }, { name: "new" }]);
  });

  const target = (extra: object) => ({ categories: [{ name: "General", channels: [{ name: "chat", ...extra }] }] });
  const chatOverwrites = () => fake.channels.find((c) => c.name === "chat")!.permission_overwrites as { id: string; type: number; allow: string; deny: string }[];

  test("off: permissions of existing channels are not touched", async () => {
    await applyLayout(G, target({ overwrites: [{ role: "Mod", allow: ["SendMessages"] }] }), { dryRun: false, prune: false });
    expect(chatOverwrites().some((o) => o.id === MOD)).toBe(false);
  });

  test("merge: declared bits win, everything else stays", async () => {
    const plan = await applyLayout(G, target({ overwrites: [{ role: "Mod", allow: ["SendMessages"] }, { role: "Member", allow: ["SendMessages"], deny: ["ViewChannel"] }] }),
      { dryRun: false, prune: false, syncPermissions: "merge" });
    expect(plan.some((l) => l.startsWith("# permissions (merge): chat"))).toBe(true);
    const ov = chatOverwrites();
    expect(ov.find((o) => o.id === MOD)).toMatchObject({ allow: send, deny: "0" });
    expect(ov.find((o) => o.id === MEMBER)).toMatchObject({ allow: send, deny: view }); // view moved from allow to deny
    expect(ov.find((o) => o.id === G)).toBeDefined();
    expect(ov.find((o) => o.id === USER)).toBeDefined();
  });

  test("replace: undeclared role overwrites are removed, member overwrites stay", async () => {
    await applyLayout(G, target({ overwrites: [{ role: "Mod", allow: ["ViewChannel"] }] }), { dryRun: false, prune: false, syncPermissions: "replace" });
    const ov = chatOverwrites();
    expect(ov.map((o) => o.id).sort()).toEqual([MOD, USER].sort());
  });

  test("merge with private on an existing channel hides it from @everyone", async () => {
    fake.channels.push(ch("300000000000000009", "open", 0, { parent_id: "300000000000000001", position: 3 }));
    await applyLayout(G, { categories: [{ name: "General", channels: [{ name: "open", private: true, allowRoles: ["Mod"] }] }] }, { dryRun: false, prune: false, syncPermissions: "merge" });
    const ov = fake.channels.find((c) => c.name === "open")!.permission_overwrites;
    expect(ov).toContainEqual({ id: G, type: 0, allow: "0", deny: view });
    expect(ov).toContainEqual({ id: MOD, type: 0, allow: view, deny: "0" });
  });

  test("an ambiguous role name is an error that asks for the ID", async () => {
    await expect(applyLayout(G, target({ overwrites: [{ role: "Twin", allow: ["ViewChannel"] }] }), { dryRun: true, prune: false, syncPermissions: "merge" }))
      .rejects.toThrow(/matches 2 roles/);
    await applyLayout(G, target({ overwrites: [{ role: DUP2, allow: ["ViewChannel"] }] }), { dryRun: true, prune: false, syncPermissions: "merge" });
  });

  test("moves a categorized channel out of its category when listed as uncategorized", async () => {
    const { layout } = await exportLayout(G);
    layout.categories[0]!.channels = layout.categories[0]!.channels!.filter((c) => c.name !== "chat");
    layout.uncategorized = [...layout.uncategorized!, { name: "chat", topic: "hello" }];
    const plan = await applyLayout(G, layout, { dryRun: false, prune: false });
    expect(plan).toContain("> move: chat -> no category");
    expect(fake.channels.find((c) => c.name === "chat")!.parent_id).toBeNull();
  });

  test("prune deletes only what is outside the layout, and only on a real run", async () => {
    const { layout } = await exportLayout(G);
    layout.categories = layout.categories.filter((c) => c.name !== "Staff");
    const dry = await applyLayout(G, layout, { dryRun: true, prune: true });
    expect(dry).toContain("- delete: Staff [category]");
    expect(fake.mutating()).toEqual([]);
    await applyLayout(G, layout, { dryRun: false, prune: true });
    expect(fake.channels.some((c) => c.name === "Staff")).toBe(false);
  });

  test("without an uncategorized list, uncategorized channels are left alone even with prune", async () => {
    const { layout } = await exportLayout(G);
    delete layout.uncategorized;
    await applyLayout(G, layout, { dryRun: false, prune: true });
    expect(fake.channels.some((c) => c.name === "rules")).toBe(true);
  });

  test("a different order is reported and fixed", async () => {
    const { layout } = await exportLayout(G);
    layout.categories.reverse();
    const plan = await applyLayout(G, layout, { dryRun: false, prune: false });
    expect(plan.some((l) => l.startsWith("= order"))).toBe(true);
    const pos = (n: string) => fake.channels.find((c) => c.name === n)!.position;
    expect(pos("Staff")).toBeLessThan(pos("General"));
  });
});

describe("restoreSnapshot", () => {
  const snap = () => ({
    guild: G,
    roles: [role(MOD, "Mod"), role("100000000000000009", "Gone", { position: 5 }), role(DUP1, "Twin")] as any,
    channels: [ch("400000000000000001", "Old", 4), ch("400000000000000002", "old-chat", 0, { parent_id: "400000000000000001" })] as any,
  });

  test("recreates missing roles and channels, never touches existing ones", async () => {
    const plan = await restoreSnapshot(G, snap(), { dryRun: false });
    expect(plan).toContain("+ role: Gone");
    expect(plan).toContain("+ category: Old");
    expect(plan).toContain("+ text: old-chat");
    expect(fake.channels.find((c) => c.name === "old-chat")!.parent_id).toBe(fake.channels.find((c) => c.name === "Old")!.id);
    expect(fake.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  test("dry run changes nothing", async () => {
    await restoreSnapshot(G, snap(), { dryRun: true });
    expect(fake.mutating()).toEqual([]);
  });

  test("on the same server a role is matched by ID even when its name is shared", async () => {
    const plan = await restoreSnapshot(G, snap(), { dryRun: true });
    expect(plan.some((l) => l.includes("Twin"))).toBe(false);
  });

  test("on another server a shared name is reported instead of guessed", async () => {
    const other = { ...snap(), guild: "999999999999999999" };
    const plan = await restoreSnapshot(G, other, { dryRun: true });
    expect(plan.some((l) => l.startsWith("! role Twin"))).toBe(true);
  });

  test("include=settings maps channel references and skips features", async () => {
    fake.extra[`/guilds/${G}`] = { description: "old", system_channel_id: null, features: ["COMMUNITY"] };
    const s = { ...snap(), settings: { description: "new", system_channel_id: "400000000000000002", features: [] } };
    await restoreSnapshot(G, s, { dryRun: false, include: ["settings"] });
    const patch = fake.calls.find((c) => c.method === "PATCH" && c.path === `/guilds/${G}`)!;
    expect(patch.body.description).toBe("new");
    expect(patch.body.system_channel_id).toBe(fake.channels.find((c) => c.name === "old-chat")!.id);
    expect("features" in patch.body).toBe(false);
  });
});
