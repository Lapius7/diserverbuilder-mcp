import { describe, expect, test } from "bun:test";
import { ChannelType } from "discord.js";
import { planDisableCommunity, planEnableCommunity } from "../src/community.ts";
import { ch } from "./fake.ts";

const rules = ch("1", "rules", ChannelType.GuildText), news = ch("2", "news", ChannelType.GuildAnnouncement), voice = ch("3", "vc", ChannelType.GuildVoice);

describe("planEnableCommunity", () => {
  test("blocks when a channel is missing, unknown or not text", () => {
    expect(planEnableCommunity({}, [rules, news]).problems.join()).toContain("no rules channel");
    expect(planEnableCommunity({ rules_channel_id: "1" }, [rules, news]).problems.join()).toContain("no public updates channel");
    expect(planEnableCommunity({}, [rules], { rulesChannelId: "1", publicUpdatesChannelId: "9" }).problems.join()).toContain("not found");
    const p = planEnableCommunity({}, [rules, voice], { rulesChannelId: "1", publicUpdatesChannelId: "3" });
    expect(p.problems.join()).toContain("must be a text");
    expect(p.body).toBeUndefined();
  });
  test("sets what is missing and keeps existing features", () => {
    const p = planEnableCommunity({ features: ["INVITES_DISABLED", "ANIMATED_ICON"], verification_level: 0, explicit_content_filter: 0 }, [rules, news], { rulesChannelId: "1", publicUpdatesChannelId: "2" });
    expect(p.problems).toEqual([]);
    expect(p.body).toEqual({
      rules_channel_id: "1", public_updates_channel_id: "2", verification_level: 1, explicit_content_filter: 2,
      features: ["INVITES_DISABLED", "ANIMATED_ICON", "COMMUNITY"],
    });
  });
  test("does not lower a stricter verification level or resend channels already set", () => {
    const p = planEnableCommunity({ rules_channel_id: "1", public_updates_channel_id: "2", verification_level: 3, explicit_content_filter: 2 }, [rules, news]);
    expect(p.body).toEqual({ features: ["COMMUNITY"] });
  });
  test("already community: nothing to send", () => {
    expect(planEnableCommunity({ features: ["COMMUNITY"] }, []).body).toBeUndefined();
  });
});

describe("planDisableCommunity", () => {
  test("removes COMMUNITY and DISCOVERABLE, keeps the rest", () => {
    const p = planDisableCommunity({ features: ["COMMUNITY", "DISCOVERABLE", "NEWS"] });
    expect(p.body).toEqual({ features: ["NEWS"] });
    expect(p.changes.join()).toContain("DISCOVERABLE");
  });
  test("not a community: nothing", () => expect(planDisableCommunity({ features: [] }).body).toBeUndefined());
});
