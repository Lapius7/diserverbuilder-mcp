import { describe, expect, test } from "bun:test";
import { ChannelType } from "discord.js";
import { inactiveChannels, lastActivity, snowflakeMs, summarizeMessages, topPosters } from "../src/analytics.ts";
import { ch } from "./fake.ts";

/** A snowflake for a given time (ms since 1970). */
const at = (ms: number) => String((BigInt(ms) - 1420070400000n) << 22n);
const NOW = Date.UTC(2026, 5, 1);
const DAY = 86_400_000;

describe("activity", () => {
  test("snowflakeMs round-trips", () => expect(snowflakeMs(at(NOW))).toBe(NOW));
  test("a channel with a recent message is active; an old one is idle", () => {
    const fresh = ch(at(NOW - 90 * DAY), "a", ChannelType.GuildText, { last_message_id: at(NOW - 2 * DAY) });
    const stale = ch(at(NOW - 90 * DAY), "b", ChannelType.GuildText, { last_message_id: at(NOW - 40 * DAY) });
    expect(lastActivity(fresh, NOW).idleDays).toBe(2);
    expect(inactiveChannels([fresh, stale], 30, NOW).map((a) => a.channel.name)).toEqual(["b"]);
  });
  test("no message ever: idle since creation, labelled never", () => {
    const empty = ch(at(NOW - 100 * DAY), "empty", ChannelType.GuildText);
    const [a] = inactiveChannels([empty], 30, NOW);
    expect(a).toMatchObject({ kind: "never", idleDays: 100 });
  });
  test("forum activity is labelled post; voice and categories are skipped", () => {
    const forum = ch(at(NOW - 99 * DAY), "f", ChannelType.GuildForum, { last_message_id: at(NOW - 50 * DAY) });
    const voice = ch(at(NOW - 99 * DAY), "v", ChannelType.GuildVoice);
    const cat = ch(at(NOW - 99 * DAY), "c", ChannelType.GuildCategory);
    const out = inactiveChannels([forum, voice, cat], 30, NOW);
    expect(out.map((a) => [a.channel.name, a.kind])).toEqual([["f", "post"]]);
  });
  test("longest idle first", () => {
    const a = ch("1", "a", ChannelType.GuildText, { last_message_id: at(NOW - 31 * DAY) });
    const b = ch("2", "b", ChannelType.GuildText, { last_message_id: at(NOW - 60 * DAY) });
    expect(inactiveChannels([a, b], 30, NOW).map((x) => x.channel.name)).toEqual(["b", "a"]);
  });
});

describe("summarizeMessages", () => {
  const u = (id: string, name: string, bot = false) => ({ id, username: name, bot });
  test("counts recent messages, separates bots, ranks posters", () => {
    const msgs = [
      { id: at(NOW - DAY), author: u("1", "ann") }, { id: at(NOW - 2 * DAY), author: u("1", "ann") },
      { id: at(NOW - 3 * DAY), author: u("2", "bob") }, { id: at(NOW - DAY), author: u("9", "bot", true) },
      { id: at(NOW - 30 * DAY), author: u("2", "bob") },
    ];
    const s = summarizeMessages(msgs, NOW - 7 * DAY);
    expect(s.messages).toBe(4);
    expect(s.bots).toBe(1);
    expect(topPosters(s.posters, 5).map(([, p]) => `${p.name}:${p.count}`)).toEqual(["ann:2", "bob:1"]);
  });
});
