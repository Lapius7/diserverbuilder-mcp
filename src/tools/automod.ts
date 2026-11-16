import { Routes } from "discord.js";
import { z } from "zod";
import {
  RULE_LIMIT, TRIGGER, TRIGGER_NAME, buildActions, checkTrigger, describeRule, eventType, exemptRoleIds, metadataFrom,
  type AutomodInput, type TriggerKind,
} from "../automod.ts";
import { getRoles, guildOf, rest } from "../discord.ts";
import { DESTRUCTIVE, EDIT, READ, WRITE, def, guildId } from "../tool.ts";

type Obj = Record<string, unknown>;

const settings = {
  keywords: z.array(z.string().max(60)).max(1000).optional().describe("Words to match. Wildcards: *word*, word*, *word"),
  regexPatterns: z.array(z.string().max(260)).max(10).optional().describe("Rust-flavored regex, up to 10"),
  allowList: z.array(z.string().max(60)).max(1000).optional().describe("Words that are never matched (keyword and keyword_preset)"),
  presets: z.array(z.enum(["profanity", "sexual_content", "slurs"])).optional(),
  mentionLimit: z.number().int().min(1).max(50).optional().describe("mention_spam: max unique mentions per message"),
  mentionRaidProtection: z.boolean().optional(),
  blockMessage: z.boolean().optional().describe("Action: block the message"),
  customMessage: z.string().max(150).optional().describe("Shown to the member whose message is blocked (implies blockMessage)"),
  alertChannelId: z.string().optional().describe("Action: post an alert in this channel"),
  timeoutMinutes: z.number().int().min(1).max(40320).optional().describe("Action: time the member out (keyword and mention_spam only)"),
  blockMemberInteraction: z.boolean().optional().describe("Action: block the member from interacting (member_profile only)"),
  exemptRoles: z.array(z.string()).max(20).optional().describe("Role names or IDs"),
  exemptChannelIds: z.array(z.string()).max(50).optional(),
  enabled: z.boolean().optional(),
};

const rules = (g: string) => rest().get(Routes.guildAutoModerationRules(g)) as Promise<Obj[]>;

def("list_automod_rules", {
  description: "List AutoMod rules (name, ID, trigger, on/off, actions). Needs Manage Server.",
  inputSchema: { guildId },
  annotations: READ,
}, async (a) => (await rules(guildOf(a.guildId))).map(describeRule).join("\n") || "(no AutoMod rules)");

def("create_automod_rule", {
  description:
    "Create an AutoMod rule. trigger: keyword (keywords/regexPatterns), spam, keyword_preset (presets), mention_spam (mentionLimit), member_profile (keywords/regexPatterns in names and bios). " +
    "At least one action is needed: blockMessage/customMessage, alertChannelId, timeoutMinutes (keyword and mention_spam only), blockMemberInteraction (member_profile only). " +
    "A server may have 6 keyword rules and 1 of each other kind. Needs Manage Server.",
  inputSchema: { guildId, name: z.string().max(100), trigger: z.enum(["keyword", "spam", "keyword_preset", "mention_spam", "member_profile"]), ...settings },
  annotations: WRITE,
}, async (a) => {
  const g = guildOf(a.guildId);
  const kind = a.trigger as TriggerKind;
  const meta = metadataFrom(a as AutomodInput);
  checkTrigger(kind, meta);
  const actions = buildActions(kind, a as AutomodInput);
  if (!actions) throw new Error("Pass at least one action: blockMessage, customMessage, alertChannelId, timeoutMinutes or blockMemberInteraction.");
  const have = (await rules(g)).filter((r) => r.trigger_type === TRIGGER[kind]).length;
  if (have >= RULE_LIMIT[TRIGGER[kind]]!) throw new Error(`The server already has ${have} ${kind} rule(s), the maximum. Edit or delete one first.`);
  const r = (await rest().post(Routes.guildAutoModerationRules(g), {
    body: {
      name: a.name, event_type: eventType(kind), trigger_type: TRIGGER[kind],
      trigger_metadata: Object.keys(meta).length ? meta : undefined, actions, enabled: a.enabled ?? true,
      exempt_roles: exemptRoleIds(g, await getRoles(g), a.exemptRoles), exempt_channels: a.exemptChannelIds,
    },
  })) as Obj;
  return `Created: ${r.name} ${r.id}`;
});

def("edit_automod_rule", {
  description:
    "Change an AutoMod rule (only the fields you pass). Trigger settings you pass replace the same setting of the rule; passing any action field replaces all of the rule's actions. The trigger type cannot change.",
  inputSchema: { guildId, ruleId: z.string(), name: z.string().max(100).optional(), ...settings },
  annotations: EDIT,
}, async (a) => {
  const g = guildOf(a.guildId);
  const cur = (await rest().get(Routes.guildAutoModerationRule(g, a.ruleId))) as Obj;
  const kind = TRIGGER_NAME[cur.trigger_type as number] as TriggerKind | undefined;
  if (!kind || !(kind in TRIGGER)) throw new Error(`Rules of trigger type ${cur.trigger_type} cannot be edited here.`);
  const passed = metadataFrom(a as AutomodInput);
  const body: Obj = { name: a.name, enabled: a.enabled, exempt_channels: a.exemptChannelIds };
  if (Object.keys(passed).length) {
    const meta = { ...((cur.trigger_metadata as Obj) ?? {}), ...passed };
    checkTrigger(kind, meta);
    body.trigger_metadata = meta;
  }
  const actionFields = ["blockMessage", "customMessage", "alertChannelId", "timeoutMinutes", "blockMemberInteraction"] as const;
  if (actionFields.some((f) => (a as Obj)[f] !== undefined)) {
    body.actions = buildActions(kind, a as AutomodInput);
    if (!body.actions) throw new Error("That would leave the rule with no action.");
  }
  if (a.exemptRoles) body.exempt_roles = exemptRoleIds(g, await getRoles(g), a.exemptRoles);
  const r = (await rest().patch(Routes.guildAutoModerationRule(g, a.ruleId), { body })) as Obj;
  return `Updated: ${r.name} ${r.id}`;
});

def("delete_automod_rule", {
  description: "Delete an AutoMod rule. confirmName must exactly match the rule's current name. Take a snapshot first.",
  inputSchema: { guildId, ruleId: z.string(), confirmName: z.string() },
  annotations: DESTRUCTIVE,
}, async (a) => {
  const g = guildOf(a.guildId);
  const r = (await rest().get(Routes.guildAutoModerationRule(g, a.ruleId))) as Obj;
  if (r.name !== a.confirmName) throw new Error(`Name mismatch (actual: ${r.name}). Nothing deleted.`);
  await rest().delete(Routes.guildAutoModerationRule(g, a.ruleId));
  return `Deleted: ${r.name}`;
});

