/** Tool groups. DISERVERBUILDER_TOOLS=structure,roles registers only those groups (default: all). Every tool must be listed here. */
export const GROUPS: Record<string, string[]> = {
  overview: ["list_guilds", "get_guild_info", "get_structure", "edit_guild", "get_audit_log"],
  channels: ["create_category", "create_channel", "edit_channel", "reorder", "clone_channel", "delete_channel"],
  permissions: ["get_permissions", "set_permissions", "clear_permissions", "sync_permissions"],
  roles: [
    "list_roles", "create_role", "edit_role", "delete_role", "reorder_roles", "apply_roles",
    "add_member_role", "remove_member_role", "search_members", "list_role_members",
  ],
  layout: ["apply_layout", "export_layout"],
  backup: ["snapshot", "list_snapshots", "diff_snapshot", "restore_snapshot"],
  members: ["get_member", "kick_member", "ban_member", "unban_member", "list_bans", "timeout_member", "set_nickname", "move_member"],
  automod: ["list_automod_rules", "create_automod_rule", "edit_automod_rule", "delete_automod_rule"],
  community: ["get_onboarding", "edit_onboarding", "get_welcome_screen", "edit_welcome_screen", "enable_community", "disable_community"],
  expressions: ["list_emojis", "create_emoji", "delete_emoji", "list_stickers", "create_sticker", "delete_sticker"],
  invites: ["list_invites", "create_invite", "delete_invite"],
  webhooks: ["list_webhooks", "create_webhook", "delete_webhook", "execute_webhook"],
  events: ["list_events", "create_event", "delete_event"],
  messages: [
    "send_message", "edit_message", "delete_message", "pin_message", "get_messages",
    "add_reaction", "remove_reaction", "purge_messages",
  ],
  audit: ["check_access", "audit_permissions"],
  templates: ["list_templates", "save_template", "apply_template"],
  guildtemplates: ["list_guild_templates", "get_guild_template", "create_guild_template", "sync_guild_template", "edit_guild_template", "delete_guild_template"],
  analytics: ["inactive_channels", "activity_report"],
  stages: ["get_stage", "start_stage", "edit_stage", "end_stage"],
  threads: ["create_forum_post", "create_thread", "list_threads", "edit_thread", "set_forum_options"],
};

export const GROUP_OF: Record<string, string> = Object.fromEntries(
  Object.entries(GROUPS).flatMap(([g, tools]) => tools.map((t) => [t, g])),
);

/** Groups named in DISERVERBUILDER_TOOLS, or undefined for all. Unknown names are reported on stderr and ignored. */
export function enabledGroups(env: string | undefined = process.env.DISERVERBUILDER_TOOLS): Set<string> | undefined {
  const names = (env ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!names.length || names.includes("all")) return undefined;
  const unknown = names.filter((n) => !(n in GROUPS));
  if (unknown.length) console.error(`diserverbuilder-mcp: unknown tool group(s) in DISERVERBUILDER_TOOLS: ${unknown.join(", ")}. Valid: ${Object.keys(GROUPS).join(", ")}`);
  const valid = names.filter((n) => n in GROUPS);
  // Nothing usable: register every tool rather than an empty server.
  return valid.length ? new Set(valid) : undefined;
}
