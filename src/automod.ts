import type { Role } from "./discord.ts";
import { resolveRole } from "./discord.ts";

type Obj = Record<string, unknown>;

export const TRIGGER = { keyword: 1, spam: 3, keyword_preset: 4, mention_spam: 5, member_profile: 6 } as const;
export type TriggerKind = keyof typeof TRIGGER;
export const TRIGGER_NAME: Record<number, string> = { 1: "keyword", 2: "harmful_link", 3: "spam", 4: "keyword_preset", 5: "mention_spam", 6: "member_profile" };
export const PRESET = { profanity: 1, sexual_content: 2, slurs: 3 } as const;
/** How many rules of each trigger a server may have. */
export const RULE_LIMIT: Record<number, number> = { 1: 6, 3: 1, 4: 1, 5: 1, 6: 1 };

const ACTION = { block_message: 1, send_alert: 2, timeout: 3, block_member_interaction: 4 } as const;
/** Which actions each trigger accepts. */
const ALLOWED: Record<TriggerKind, (keyof typeof ACTION)[]> = {
  keyword: ["block_message", "send_alert", "timeout"],
  spam: ["block_message", "send_alert"],
  keyword_preset: ["block_message", "send_alert"],
  mention_spam: ["block_message", "send_alert", "timeout"],
  member_profile: ["block_member_interaction", "send_alert"],
};

export interface AutomodInput {
  keywords?: string[];
  regexPatterns?: string[];
  allowList?: string[];
  presets?: (keyof typeof PRESET)[];
  mentionLimit?: number;
  mentionRaidProtection?: boolean;
  blockMessage?: boolean;
  customMessage?: string;
  alertChannelId?: string;
  timeoutMinutes?: number;
  blockMemberInteraction?: boolean;
}

/** trigger_metadata fields the caller actually passed. */
export function metadataFrom(a: AutomodInput): Obj {
  const m: Obj = {};
  if (a.keywords) m.keyword_filter = a.keywords;
  if (a.regexPatterns) m.regex_patterns = a.regexPatterns;
  if (a.allowList) m.allow_list = a.allowList;
  if (a.presets) m.presets = a.presets.map((p) => PRESET[p]);
  if (a.mentionLimit !== undefined) m.mention_total_limit = a.mentionLimit;
  if (a.mentionRaidProtection !== undefined) m.mention_raid_protection_enabled = a.mentionRaidProtection;
  return m;
}

/** Throw when the trigger lacks what it needs, or has settings it does not support. Empty values (as Discord returns them) count as unset. */
export function checkTrigger(kind: TriggerKind, m: Obj) {
  const has = (k: string) => m[k] !== undefined && m[k] !== null && !(Array.isArray(m[k]) && (m[k] as unknown[]).length === 0);
  if ((kind === "keyword" || kind === "member_profile") && !has("keyword_filter") && !has("regex_patterns")) throw new Error(`${kind} rules need keywords or regexPatterns.`);
  if (kind === "keyword_preset" && !has("presets")) throw new Error("keyword_preset rules need presets (profanity, sexual_content, slurs).");
  if (kind === "mention_spam" && !has("mention_total_limit")) throw new Error("mention_spam rules need mentionLimit (1-50).");
  if (kind === "spam" && Object.keys(m).some(has)) throw new Error("spam rules take no keyword, preset or mention settings.");
  if (kind !== "keyword_preset" && has("presets")) throw new Error("presets only work with trigger keyword_preset.");
  if (kind !== "keyword_preset" && kind !== "keyword" && has("allow_list")) throw new Error("allowList only works with keyword and keyword_preset rules.");
  if (kind !== "mention_spam" && (has("mention_total_limit") || has("mention_raid_protection_enabled"))) throw new Error("mentionLimit only works with trigger mention_spam.");
}

/** Build the actions array and reject actions the trigger does not allow. Returns undefined when no action was passed. */
export function buildActions(kind: TriggerKind, a: AutomodInput): Obj[] | undefined {
  const out: { type: keyof typeof ACTION; body: Obj }[] = [];
  if (a.blockMessage || a.customMessage) out.push({ type: "block_message", body: { type: ACTION.block_message, metadata: a.customMessage ? { custom_message: a.customMessage } : undefined } });
  if (a.alertChannelId) out.push({ type: "send_alert", body: { type: ACTION.send_alert, metadata: { channel_id: a.alertChannelId } } });
  if (a.timeoutMinutes) out.push({ type: "timeout", body: { type: ACTION.timeout, metadata: { duration_seconds: Math.min(a.timeoutMinutes * 60, 2419200) } } });
  if (a.blockMemberInteraction) out.push({ type: "block_member_interaction", body: { type: ACTION.block_member_interaction } });
  for (const o of out) {
    if (!ALLOWED[kind].includes(o.type)) throw new Error(`Trigger ${kind} does not allow the ${o.type} action. Allowed: ${ALLOWED[kind].join(", ")}.`);
  }
  return out.length ? out.map((o) => o.body) : undefined;
}

export const eventType = (kind: TriggerKind) => (kind === "member_profile" ? 2 : 1);

/** Resolve exempt roles (names or IDs). */
export const exemptRoleIds = (g: string, roles: Role[], refs: string[] | undefined) => refs?.map((r) => resolveRole(g, roles, r));

/** One line per rule. */
export function describeRule(r: Obj): string {
  const t = TRIGGER_NAME[r.trigger_type as number] ?? String(r.trigger_type);
  const acts = ((r.actions as Obj[]) ?? []).map((a) => Object.keys(ACTION).find((k) => ACTION[k as keyof typeof ACTION] === a.type) ?? a.type).join("+");
  const m = (r.trigger_metadata as Obj) ?? {};
  const bits = [
    (m.keyword_filter as string[] | undefined)?.length ? `${(m.keyword_filter as string[]).length} keyword(s)` : "",
    (m.regex_patterns as string[] | undefined)?.length ? `${(m.regex_patterns as string[]).length} regex` : "",
    (m.presets as number[] | undefined)?.length ? `presets=${(m.presets as number[]).map((p) => Object.keys(PRESET).find((k) => PRESET[k as keyof typeof PRESET] === p)).join("+")}` : "",
    m.mention_total_limit ? `mentions>${m.mention_total_limit}` : "",
  ].filter(Boolean).join(" ");
  return `${r.name} ${r.id} [${t}] ${r.enabled ? "on" : "off"} actions=${acts || "-"}${bits ? ` ${bits}` : ""}`;
}
