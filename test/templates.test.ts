import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionFlagsBits } from "discord.js";
import { BUILTIN_TEMPLATES, applyTemplate, getTemplate, listSavedTemplates, saveTemplate, validateTemplate, type Template } from "../src/templates.ts";
import { permBits } from "../src/discord.ts";
import { FakeDiscord, G } from "./fake.ts";

let fake: FakeDiscord, dir: string;
beforeEach(() => { fake = new FakeDiscord().install(); dir = mkdtempSync(join(tmpdir(), "dsb-tpl-")); process.env.DISERVERBUILDER_CONFIG_DIR = dir; });
afterEach(() => { delete process.env.DISERVERBUILDER_CONFIG_DIR; rmSync(dir, { recursive: true, force: true }); });

describe("built-in templates", () => {
  for (const [name, tpl] of Object.entries(BUILTIN_TEMPLATES)) {
    test(`${name}: valid, dry run on an empty server does not throw or write`, async () => {
      expect(validateTemplate(tpl)).toEqual([]);
      const plan = await applyTemplate(G, tpl, true);
      expect(plan.join("\n")).toContain("+ create");
      expect(fake.mutating()).toEqual([]);
    });
    test(`${name}: a real run, then a dry run reports nothing to change`, async () => {
      fake.extra[`/guilds/${G}`] = { features: ["COMMUNITY"] };
      await applyTemplate(G, tpl, false);
      expect(fake.roles.length).toBe(1 + tpl.roles.length);
      expect(await applyTemplate(G, tpl, true)).toEqual(["Nothing to change: the server already has this template's roles and channels."]);
    });
  }
  test("every permission a built-in role asks for is covered by the README's \"All tools\" invite", () => {
    const invite = BigInt([...readFileSync(join(import.meta.dir, "../README.md"), "utf8").matchAll(/permissions=(\d+)/g)].map((m) => m[1]!).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)).pop()!);
    for (const tpl of Object.values(BUILTIN_TEMPLATES)) {
      for (const r of tpl.roles) {
        const bits = BigInt(permBits(r.permissions));
        expect({ template: tpl.name, role: r.name, outside: bits & ~invite }).toEqual({ template: tpl.name, role: r.name, outside: 0n });
      }
    }
  });
  test("a bot without Administrator is not asked to hand it out: a real run is refused before any write", async () => {
    fake.roles.push({ id: "700000000000000001", name: "Bot", position: 1, permissions: String(PermissionFlagsBits.ManageRoles), managed: true });
    fake.members[fake.me.id] = { user: fake.me, roles: ["700000000000000001"] };
    const tpl: Template = { name: "x", description: "", roles: [{ name: "Boss", permissions: ["Administrator"] }], layout: { categories: [] } };
    expect((await applyTemplate(G, tpl, true)).join("\n")).toContain("! Boss: needs Administrator");
    await expect(applyTemplate(G, tpl, false)).rejects.toThrow("Nothing was changed");
    expect(fake.mutating()).toEqual([]);
  });
  test("stage channels on a server without Community: dry run warns, real run is refused before any write", async () => {
    const plan = await applyTemplate(G, BUILTIN_TEMPLATES.gaming!, true);
    expect(plan.join("\n")).toContain("stage channels need a Community server");
    await expect(applyTemplate(G, BUILTIN_TEMPLATES.gaming!, false)).rejects.toThrow("enable_community");
    expect(fake.mutating()).toEqual([]);
  });
  test("forum channels do not need Community (checked on a live server)", async () => {
    expect((await applyTemplate(G, BUILTIN_TEMPLATES.support!, true)).join("\n")).not.toContain("need a Community server");
  });
  test("private categories deny @everyone and allow the named roles by their real IDs", async () => {
    await applyTemplate(G, BUILTIN_TEMPLATES.minimal!, false);
    const staff = fake.channels.find((c) => c.name === "Staff")!;
    const mod = fake.roles.find((r) => r.name === "Moderator")!;
    expect(staff.permission_overwrites.map((o: any) => o.id).sort()).toEqual([G, mod.id, fake.roles.find((r) => r.name === "Admin")!.id].sort());
  });
});

describe("validateTemplate", () => {
  const tpl = (over: Partial<Template>): Template => ({ name: "x", description: "", roles: [{ name: "A" }], layout: { categories: [{ name: "C" }] }, ...over });
  test("catches undeclared roles, duplicate roles, bad permissions and duplicate categories", () => {
    expect(validateTemplate(tpl({ layout: { categories: [{ name: "C", private: true, allowRoles: ["Ghost"] }] } })).join()).toContain('"Ghost" is not declared');
    expect(validateTemplate(tpl({ roles: [{ name: "A" }, { name: "a" }] })).join()).toContain("declared twice");
    expect(validateTemplate(tpl({ roles: [{ name: "A", permissions: ["Nope"] }] })).join()).toContain("unknown permission");
    expect(validateTemplate(tpl({ layout: { categories: [{ name: "C" }, { name: "c" }] } })).join()).toContain("appears twice");
  });
});

describe("local templates", () => {
  const mine: Template = { name: "my-team", description: "d", roles: [{ name: "Lead" }], layout: { categories: [{ name: "Home", channels: [{ name: "hi" }] }] } };
  test("save, list and get round-trip", async () => {
    await saveTemplate(mine);
    expect((await listSavedTemplates()).map((x) => x.name)).toEqual(["my-team"]);
    expect((await getTemplate("my-team")).roles[0]!.name).toBe("Lead");
  });
  test("rejects names that could escape the folder, built-in names and invalid templates", async () => {
    for (const name of ["../evil", "a/b", "Upper", "", "x".repeat(65)]) await expect(saveTemplate({ ...mine, name })).rejects.toThrow("Template name");
    await expect(saveTemplate({ ...mine, name: "gaming" })).rejects.toThrow("built-in");
    await expect(saveTemplate({ ...mine, layout: { categories: [{ name: "H", private: true, allowRoles: ["Nobody"] }] } })).rejects.toThrow("not valid");
    await expect(getTemplate("../x")).rejects.toThrow("Unknown template");
  });
});
