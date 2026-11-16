# diserverbuilder-mcp

[日本語](README.ja.md)

An MCP server that lets an AI assistant (Claude, etc.) build and reorganize a Discord server through a bot you own: categories, channels, roles, and permission overwrites.

It talks to the Discord REST API only. It does not log in to the gateway, so it needs no privileged intents and the bot does not have to stay online.

## Tools (95)

| Area | Tools |
|------|-------|
| Overview | `list_guilds`, `get_guild_info`, `get_structure`, `edit_guild`, `get_audit_log` |
| Channels | `create_category`, `create_channel` (text, voice, announcement, stage, forum, media), `edit_channel` (slowmode, voice limits, forum tags), `reorder`, `clone_channel`, `delete_channel` |
| Permissions | `get_permissions`, `set_permissions`, `clear_permissions`, `sync_permissions` (category to its channels) |
| Roles | `list_roles`, `create_role`, `edit_role`, `delete_role`, `reorder_roles`, `apply_roles`, `add_member_role`, `remove_member_role`, `search_members`, `list_role_members` |
| Layout | `apply_layout` (declare the whole structure, optionally syncing permissions of existing items), `export_layout` (round-trips with `apply_layout`) |
| Backup | `snapshot`, `list_snapshots`, `diff_snapshot`, `restore_snapshot` (also copies a structure to another server) |
| Members | `get_member`, `kick_member`, `ban_member`, `unban_member`, `list_bans`, `timeout_member`, `set_nickname`, `move_member` |
| AutoMod | `list_automod_rules`, `create_automod_rule`, `edit_automod_rule`, `delete_automod_rule` |
| Community | `get_onboarding`, `edit_onboarding`, `get_welcome_screen`, `edit_welcome_screen`, `enable_community`, `disable_community` |
| Emojis and stickers | `list_emojis`, `create_emoji`, `delete_emoji`, `list_stickers`, `create_sticker`, `delete_sticker` |
| Invites, webhooks, events | `list_invites`, `create_invite`, `delete_invite`, `list_webhooks`, `create_webhook`, `execute_webhook`, `delete_webhook`, `list_events`, `create_event`, `delete_event` |
| Messages | `send_message` (text, embeds, polls, link buttons, replies, optional pin), `edit_message`, `delete_message`, `pin_message`, `get_messages`, `add_reaction`, `remove_reaction`, `purge_messages` |
| Access audit | `check_access` (what a member or role can really do, per channel), `audit_permissions` (risky permissions, duplicate role names, stale overwrites, bot role order) |
| Templates (local) | `list_templates`, `save_template`, `apply_template`. Built in: minimal, gaming, study, creator, support |
| Server templates (Discord) | `list_guild_templates`, `get_guild_template`, `create_guild_template`, `sync_guild_template`, `edit_guild_template`, `delete_guild_template` |
| Activity | `inactive_channels`, `activity_report` |
| Stages | `get_stage`, `start_stage`, `edit_stage`, `end_stage` |
| Threads and forums | `create_forum_post`, `create_thread`, `list_threads`, `edit_thread`, `set_forum_options` (tags are set with `edit_channel`) |

Buttons are limited to link buttons. The server has no gateway connection, so nothing could receive a click on any other kind.

Listing members (`search_members`, `list_role_members`, `snapshot` with `includeMembers`) needs the **Server Members Intent**. Turn it on in the Developer Portal (Bot, Privileged Gateway Intents). The tool tells you so if it is off.

## Setup

### 1. Create a bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications), create an application, and add a bot.
2. Copy the bot token (Bot, then Reset Token). Keep it secret.
3. Invite the bot to your server with one of these URLs (replace `YOUR_CLIENT_ID`).

Structure only (View Channels, Manage Channels, Manage Roles):

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot&permissions=268436496
```

All tools (adds Manage Server, Manage Webhooks, Manage Events, Manage and Create Expressions, Create Invite, View Audit Log, Send Messages, Embed Links, Read Message History, Manage Messages, Pin Messages, Create Public Threads, Send Messages in Threads, Manage Threads, Kick Members, Ban Members, Moderate Members, Move Members, Mute Members, Add Reactions, Send Polls, Manage Nicknames):

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot&permissions=2824982413536503
```

A tool fails with a clear error if the bot lacks the permission it needs, so you can start with the smaller set.

Move the bot's role above any role it should manage. Discord does not let a bot edit roles above its own, or grant permissions it does not have.

### 2. Add the server to your MCP client

Claude Code:

```sh
claude mcp add -s user diserverbuilder -- npx -y diserverbuilder-mcp
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "diserverbuilder": {
      "command": "npx",
      "args": ["-y", "diserverbuilder-mcp"]
    }
  }
}
```

### 3. Save the bot token

```sh
npx diserverbuilder-mcp auth
```

It asks for the token (the input is hidden), checks it with Discord, and saves it to `~/.diserverbuilder/config.json`, readable only by you. The token never appears in your shell history, your MCP config or a chat. Run it again whenever you reset the token. `auth status` shows which token is in use, and `auth logout` deletes the saved one.

You can also set the `DISCORD_BOT_TOKEN` environment variable instead (for example in the `env` of the MCP entry). It takes priority over the saved token.

Requires Node.js 20 or later.

## Troubleshooting

| Message | Cause and fix |
|---------|---------------|
| `The bot token is invalid or was reset` (401) | The token is wrong or was reset. Copy a fresh one from the Developer Portal (Bot, Reset Token) and run `npx diserverbuilder-mcp auth`. If you set `DISCORD_BOT_TOKEN`, it overrides the saved token, so fix or remove it. |
| `The bot lacks a permission` (403) | Re-invite the bot with the permissions above, and move its role above any role it edits. |
| `The bot cannot see this` (50001) | The bot is not in that server, or cannot view the channel. |
| `Not found` (404) | The ID is wrong or belongs to another server. Look it up with `list_guilds`, `get_structure` or `list_roles`. |
| `No bot token` | Run `npx diserverbuilder-mcp auth`, or set `DISCORD_BOT_TOKEN` in the `env` of the MCP entry. |

If a token ever ends up in a chat, a log or a repository, reset it in the Developer Portal right away.

## Environment variables

| Name | Required | Description |
|------|----------|-------------|
| `DISCORD_BOT_TOKEN` | No | Bot token. Takes priority over the one saved by `auth`. Set one or the other |
| `DISCORD_GUILD_ID` | No | Default server ID. If unset, pass `guildId` to each tool |
| `DISERVERBUILDER_CONFIG_DIR` | No | Where `auth` saves the token. Default `~/.diserverbuilder` |
| `DISERVERBUILDER_SNAPSHOT_DIR` | No | Where snapshots are saved. Default `~/.diserverbuilder/snapshots` |
| `DISERVERBUILDER_READONLY` | No | Set to `1` to register only tools that cannot change Discord (inspect and export, no edits) |
| `DISERVERBUILDER_TOOLS` | No | Comma-separated tool groups to register, for example `channels,roles,layout`. Default: all. Groups: `overview`, `channels`, `permissions`, `roles`, `layout`, `backup`, `members`, `automod`, `community`, `expressions`, `invites`, `webhooks`, `events`, `messages`, `audit`, `templates`, `guildtemplates`, `analytics`, `stages`, `threads`. Unknown names are reported on stderr; if none are valid, every tool is registered. Combines with `DISERVERBUILDER_READONLY` |

## Safety

- `apply_layout` is a dry run unless you pass `dryRun: false`. It matches existing channels by name, so it moves and updates them instead of duplicating.
- Channels missing from the layout are left alone. They are deleted only with `prune: true` and `dryRun: false`.
- A real `apply_layout` run saves a snapshot first. Call `snapshot` yourself before other large changes.
- Set `DISERVERBUILDER_READONLY=1` to let an assistant look around without being able to change anything.
- `send_message` and `edit_message` suppress `@everyone` and other mentions unless you pass `allowMentions: true`.
- `apply_layout` leaves the permissions of existing channels alone by default. `syncPermissions: "merge"` adds the declared bits (declared bits win, everything else stays). `"replace"` makes role overwrites match exactly: undeclared role overwrites are removed and member overwrites stay. The dry run shows each change.
- `export_layout` includes uncategorized channels, slowmode, voice limits, forum tags and role overwrites, so exporting and applying an unchanged server reports "Nothing to change". Member overwrites are skipped unless `includeMembers: true`, and unsupported channel types are skipped and listed. Do not apply an export with `prune: true` if it lists skipped types, or those channels are deleted.
- Role names are matched without case. If several roles share a name, tools stop and ask for the role ID instead of guessing, and `apply_roles` skips that role.
- `snapshot` also records server settings, emojis, stickers, scheduled events, AutoMod rules, onboarding and the welcome screen. Parts the bot cannot read are skipped with a note. `diff_snapshot` shows what changed since one.
- `kick_member`, `ban_member` and `timeout_member` act immediately and have no dry run. A timeout lasts at most 28 days, and a ban can delete up to 7 days of the user's messages. Reasons go to the audit log.
- `purge_messages` is a dry run by default. It looks at the newest messages (up to 500), keeps pinned ones unless told otherwise, and leaves messages older than 14 days, which Discord cannot bulk-delete. Deleted messages cannot be restored.
- `edit_onboarding` replaces all questions with the list you pass, so read them with `get_onboarding` first. It needs the Community feature.
- `execute_webhook` takes only the webhook ID. The secret token is fetched inside the tool and never shown, including in error messages.
- `apply_roles` and `sync_permissions` also default to a dry run. `apply_roles` never deletes roles.
- `restore_snapshot` only recreates what is missing (matched by name) and never changes or deletes existing items. It is a dry run by default.
- Discord changes the parent of only one channel per bulk call, so `reorder` cannot move several channels between categories at once. `apply_layout` handles that for you.
- `delete_channel` and `delete_role` need the exact current name and `delete_channel` checks that the channel belongs to the given server. Deleted channels and their messages cannot be restored. Snapshots do not include messages.
- `apply_template` builds a local template: it creates the template's roles and channels that are missing and keeps everything else. It is a dry run by default, saves a snapshot before a real run, and a second run reports nothing to change. The bot can only give a role permissions it holds itself, so a template that asks for more is refused before anything changes; the built-in roles stay within the "All tools" invite. Stage channels need a Community server, so run `enable_community` first (the dry run says so, and a real run is refused without it). `list_templates` and `save_template` handle files on your computer only; the Discord server templates (`discord.new` links) are the `*_guild_template` tools, and Discord is believed to allow only one per server.
- `check_access` and `audit_permissions` only read. `check_access` follows Discord's order (owner and Administrator first, then @everyone and roles, then channel overwrites, then the member). Overwrites on a category do not reach its channels by themselves, so check the channel.
- `inactive_channels` and `activity_report` never return message text. The report's optional sample reads at most 100 messages from each of 25 channels, so counts in busy channels are lower bounds.
- `enable_community` and `disable_community` are dry runs by default. Enabling can raise the verification level and turn the explicit content filter on, because Discord requires both. These two tools and the stage tools were checked against an in-memory mock only, not a live server.
- `end_stage` and `delete_guild_template` need the exact current topic or name.
- The token has full channel and role management rights on the server. Keep it out of repositories and shared configs. `auth` stores it in a file only you can read.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm test        # needs Bun; no Discord access or token required
pnpm run build   # bundles src/ to dist/index.js (needs Bun)
pnpm start       # runs dist/index.js over stdio
```

## License

MIT
