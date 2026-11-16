import { ChannelType } from "discord.js";
import type { Ch } from "./discord.ts";

export interface GuildCfg {
  features?: string[];
  verification_level?: number;
  explicit_content_filter?: number;
  rules_channel_id?: string | null;
  public_updates_channel_id?: string | null;
}
export interface CommunityPlan {
  /** PATCH body for Modify Guild. Absent when there is nothing to send (already on, or blocked by `problems`). */
  body?: Record<string, unknown>;
  /** What will change, one line each. */
  changes: string[];
  /** What blocks enabling. Non-empty means the body must not be sent. */
  problems: string[];
}

const TEXTLIKE = new Set<number>([ChannelType.GuildText, ChannelType.GuildAnnouncement]);

/**
 * Community needs a rules channel and an updates channel (text channels), verification of at least Low and the explicit content filter on for all members.
 * The features list keeps everything the server already has and adds COMMUNITY.
 */
export function planEnableCommunity(guild: GuildCfg, channels: Ch[], want: { rulesChannelId?: string; publicUpdatesChannelId?: string } = {}): CommunityPlan {
  const features = guild.features ?? [];
  if (features.includes("COMMUNITY")) return { changes: [], problems: [], body: undefined };
  const changes: string[] = [], problems: string[] = [];
  const body: Record<string, unknown> = {};
  const byId = new Map(channels.map((c) => [c.id, c]));
  const pick = (key: "rules_channel_id" | "public_updates_channel_id", given: string | undefined, label: string) => {
    const id = given ?? guild[key] ?? undefined;
    if (!id) { problems.push(`no ${label} channel: pass ${key === "rules_channel_id" ? "rulesChannelId" : "publicUpdatesChannelId"} (a text channel)`); return; }
    const c = byId.get(id);
    if (!c) problems.push(`${label} channel ${id} was not found in this server`);
    else if (!TEXTLIKE.has(c.type)) problems.push(`${label} channel #${c.name} must be a text or announcement channel`);
    else if (id !== guild[key]) { body[key] = id; changes.push(`set ${label} channel to #${c.name}`); }
  };
  pick("rules_channel_id", want.rulesChannelId, "rules");
  pick("public_updates_channel_id", want.publicUpdatesChannelId, "public updates");
  if ((guild.verification_level ?? 0) < 1) { body.verification_level = 1; changes.push("raise verification level to 1 (low)"); }
  if (guild.explicit_content_filter !== 2) { body.explicit_content_filter = 2; changes.push("scan media from all members (explicit content filter 2)"); }
  body.features = [...features, "COMMUNITY"];
  changes.push("turn COMMUNITY on");
  return { body: problems.length ? undefined : body, changes, problems };
}

/** Community off. DISCOVERABLE depends on it, so Discord turns that off too; the list says so. */
export function planDisableCommunity(guild: GuildCfg): CommunityPlan {
  const features = guild.features ?? [];
  if (!features.includes("COMMUNITY")) return { changes: [], problems: [] };
  const changes = ["turn COMMUNITY off"];
  if (features.includes("DISCOVERABLE")) changes.push("also removes DISCOVERABLE (server discovery needs Community)");
  return { body: { features: features.filter((f) => f !== "COMMUNITY" && f !== "DISCOVERABLE") }, changes, problems: [] };
}
