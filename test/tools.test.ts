import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ChannelType, PermissionFlagsBits as P } from "discord.js";
import { server } from "../src/tool.ts";
import { loadTools } from "../src/tools/index.ts";
import { FakeDiscord, G, ch, role } from "./fake.ts";

let client: Client, fake: FakeDiscord;
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: { guildId: G, ...args } })) as { isError?: boolean; content: { text: string }[] };
  return { error: !!r.isError, text: r.content[0]!.text };
};
beforeAll(async () => {
  await loadTools();
  client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
});
beforeEach(() => { fake = new FakeDiscord().install(); });

const USER = "400000000000000001", MOD = "200000000000000001";

describe("check_access", () => {
  beforeEach(() => {
    fake.roles[0]!.permissions = String(P.ViewChannel | P.SendMessages);
    fake.roles.push(role(MOD, "Mod", { permissions: String(P.KickMembers) }));
    fake.extra[`/guilds/${G}`] = { owner_id: "999999999999999999" };
    fake.members[USER] = { user: { id: USER, username: "ann" }, roles: [MOD] };
    fake.channels.push(
      ch("300000000000000001", "open", ChannelType.GuildText),
      ch("300000000000000002", "staff", ChannelType.GuildText, { permission_overwrites: [{ id: G, type: 0, allow: "0", deny: String(P.ViewChannel) }, { id: MOD, type: 0, allow: String(P.ViewChannel), deny: "0" }] }),
      ch("300000000000000003", "locked", ChannelType.GuildText, { permission_overwrites: [{ id: USER, type: 1, allow: "0", deny: String(P.ViewChannel) }] }),
    );
  });
  test("member across all channels", async () => {
    const r = await call("check_access", { userId: USER });
    expect(r.text).toContain("#open [text] 300000000000000001: ViewChannel yes, SendMessages yes");
    expect(r.text).toContain("#staff [text] 300000000000000002: ViewChannel yes");
    expect(r.text).toContain("#locked [text] 300000000000000003: ViewChannel no");
  });
  test("role only mode and a single channel", async () => {
    expect((await call("check_access", { role: "Mod", channelId: "300000000000000002" })).text).toContain("KickMembers");
    expect((await call("check_access", { role: "@everyone", channelId: "300000000000000002" })).text).toContain("no access");
  });
  test("needs exactly one of userId or role", async () => {
    expect((await call("check_access", {})).error).toBe(true);
  });
});

describe("audit_permissions", () => {
  test("reports findings and survives the bot being unreadable", async () => {
    fake.roles[0]!.permissions = String(P.MentionEveryone);
    const r = await call("audit_permissions");
    expect(r.text).toContain("[high] @everyone grants MentionEveryone");
    expect(r.text).toContain("role-order check was skipped");
  });
});

describe("stages", () => {
  const STAGE = "300000000000000010", TEXT = "300000000000000011";
  beforeEach(() => fake.channels.push(ch(STAGE, "Events", ChannelType.GuildStageVoice), ch(TEXT, "chat", ChannelType.GuildText)));
  test("not live, start, edit, end", async () => {
    expect((await call("get_stage")).text).toContain("not live: #Events");
    expect((await call("get_stage", { channelId: STAGE })).text).toStartWith("Not live");
    expect((await call("start_stage", { channelId: STAGE, topic: "Q&A" })).text).toContain('"Q&A" (server members only)');
    expect(fake.stages[STAGE]).toMatchObject({ privacy_level: 2, send_start_notification: false });
    expect((await call("get_stage")).text).toContain("LIVE #Events");
    expect((await call("edit_stage", { channelId: STAGE, topic: "New" })).text).toContain('"New"');
    expect((await call("end_stage", { channelId: STAGE, confirmTopic: "wrong" })).error).toBe(true);
    expect(fake.stages[STAGE]).toBeDefined();
    expect((await call("end_stage", { channelId: STAGE, confirmTopic: "New" })).text).toContain("Ended");
    expect((await call("end_stage", { channelId: STAGE, confirmTopic: "New" })).text).toContain("Nothing to end");
  });
  test("start refuses a non-stage channel; edit refuses when not live", async () => {
    expect((await call("start_stage", { channelId: TEXT, topic: "x" })).text).toContain("not a stage channel");
    expect((await call("edit_stage", { channelId: STAGE, topic: "x" })).text).toContain("No stage is running");
  });
});

describe("templates and analytics through the tools", () => {
  test("apply_template dry run changes nothing, real run is idempotent", async () => {
    const dry = await call("apply_template", { name: "minimal" });
    expect(dry.text).toContain("[dry-run]");
    expect(fake.mutating()).toEqual([]);
    const real = await call("apply_template", { name: "minimal", dryRun: false });
    expect(real.error).toBe(false);
    expect((await call("apply_template", { name: "minimal" })).text).toContain("Nothing to change");
    expect((await call("apply_template", { name: "nope" })).error).toBe(true);
  });
  test("inactive_channels lists never-used channels", async () => {
    fake.channels.push(ch("300000000000000020", "quiet", ChannelType.GuildText));
    const r = await call("inactive_channels", { days: 1 });
    expect(r.text).toContain("#quiet");
    expect(r.text).toContain("never had a message");
  });
  test("enable_community dry run explains what is missing, then what changes", async () => {
    fake.channels.push(ch("300000000000000030", "rules", ChannelType.GuildText), ch("300000000000000031", "news", ChannelType.GuildText));
    expect((await call("enable_community")).text).toContain("Cannot enable");
    const r = await call("enable_community", { rulesChannelId: "300000000000000030", publicUpdatesChannelId: "300000000000000031" });
    expect(r.text).toContain("[dry-run]");
    expect(r.text).toContain("turn COMMUNITY on");
    expect(fake.mutating()).toEqual([]);
  });
});

describe("guild templates", () => {
  test("create, refuse a second, sync, edit, delete needs the right name", async () => {
    const made = await call("create_guild_template", { name: "Starter", description: "hi" });
    const code = made.text.match(/\[(\w+)\]/)![1]!;
    expect(made.text).toContain(`https://discord.new/${code}`);
    expect((await call("create_guild_template", { name: "Again" })).error).toBe(true);
    expect((await call("list_guild_templates")).text).toContain("Starter");
    fake.templates[0]!.is_dirty = true;
    expect((await call("list_guild_templates")).text).toContain("UNSYNCED");
    expect((await call("sync_guild_template", { code })).text).not.toContain("UNSYNCED");
    expect((await call("edit_guild_template", { code, name: "Renamed" })).text).toContain("Renamed");
    expect((await call("delete_guild_template", { code, confirmName: "Starter" })).error).toBe(true);
    expect(fake.templates.length).toBe(1);
    expect((await call("delete_guild_template", { code, confirmName: "Renamed" })).text).toContain("Deleted");
    expect((await call("list_guild_templates")).text).toContain("no Discord template");
  });
});
