import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSnapshot, readSnapshot, saveSnapshot, listSnapshots } from "../src/snapshot.ts";
import { FakeDiscord, G, ch, role } from "./fake.ts";

const dir = mkdtempSync(join(tmpdir(), "dsb-snap-"));
process.env.DISERVERBUILDER_SNAPSHOT_DIR = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let fake: FakeDiscord;
beforeEach(() => {
  fake = new FakeDiscord().install();
  fake.roles.push(role("100000000000000001", "Mod"));
  fake.channels.push(ch("300000000000000001", "General", 4));
  fake.extra[`/guilds/${G}`] = { description: "d", features: [] };
  fake.extra[`/guilds/${G}/emojis`] = [{ id: "5", name: "wave" }];
});

describe("snapshot", () => {
  test("collects roles, channels, settings and emojis; a part the bot cannot read becomes a note", async () => {
    fake.failing.set(`/guilds/${G}/auto-moderation/rules`, 403);
    const s = await collectSnapshot(G, { includeMembers: false });
    expect(s.roles.map((r) => r.name)).toContain("Mod");
    expect(s.channels).toHaveLength(1);
    expect(s.emojis).toEqual([{ id: "5", name: "wave" }]);
    expect(s.notes?.some((n) => /auto/i.test(n))).toBe(true);
    expect(s.memberRoles).toBeUndefined();
  });

  test("saved file is listed and reads back", async () => {
    const { file } = await saveSnapshot(G, { includeMembers: false });
    expect(await listSnapshots()).toContain(file.split("/").pop()!);
    expect((await readSnapshot(file)).guild).toBe(G);
  });

  test("an old-format file (guild, channels, roles only) still loads", async () => {
    const f = join(dir, "old.json");
    writeFileSync(f, JSON.stringify({ guild: G, roles: [], channels: [] }));
    expect((await readSnapshot(f)).guild).toBe(G);
  });

  test("a file that is not a snapshot is rejected", async () => {
    const f = join(dir, "bad.json");
    writeFileSync(f, JSON.stringify({ hello: 1 }));
    await expect(readSnapshot(f)).rejects.toThrow(/Not a diserverbuilder snapshot/);
  });
});
