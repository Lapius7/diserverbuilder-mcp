# diserverbuilder-mcp

[日本語](README.ja.md)

An MCP server that lets an AI assistant (Claude, etc.) build and reorganize a Discord server through a bot you own: categories, channels, roles, and permission overwrites.

It talks to the Discord REST API only. It does not log in to the gateway, so it needs no privileged intents and the bot does not have to stay online.

## Tools (46)

| Area | Tools |
|------|-------|
| Overview | `list_guilds`, `get_guild_info`, `get_structure`, `export_layout` |
| Channels | `create_category`, `create_channel`, `edit_channel` (slowmode, voice limits, forum tags), `reorder`, `clone_channel`, `delete_channel` |
| Permissions | `get_permissions`, `set_permissions`, `clear_permissions`, `sync_permissions` (category to its channels) |
| Roles | `list_roles`, `create_role`, `edit_role`, `delete_role`, `reorder_roles`, `apply_roles`, `add_member_role`, `remove_member_role`, `search_members` |
| Bulk and backup | `apply_layout` (declare the whole structure), `snapshot`, `list_snapshots`, `restore_snapshot` (also copies a structure to another server) |
| Server | `edit_guild`, `list_emojis`, `create_emoji`, `delete_emoji`, `list_invites`, `create_invite`, `delete_invite`, `list_webhooks`, `create_webhook`, `delete_webhook`, `list_events`, `create_event`, `delete_event`, `get_audit_log` |
| Messages | `send_message` (text and embeds, optional pin), `edit_message`, `delete_message`, `pin_message`, `get_messages` |

## Setup

### 1. Create a bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications), create an application, and add a bot.
2. Copy the bot token (Bot, then Reset Token). Keep it secret.
3. Invite the bot to your server with one of these URLs (replace `YOUR_CLIENT_ID`).

Structure only (View Channels, Manage Channels, Manage Roles):

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot&permissions=268436496
```

All tools (adds Manage Server, Manage Webhooks, Manage Events, Manage and Create Expressions, Create Invite, View Audit Log, Send Messages, Embed Links, Read Message History, Manage Messages, Pin Messages):

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot&permissions=2260606375783601
```

A tool fails with a clear error if the bot lacks the permission it needs, so you can start with the smaller set.

Move the bot's role above any role it should manage. Discord does not let a bot edit roles above its own, or grant permissions it does not have.

### 2. Add the server to your MCP client

Claude Code:

```sh
claude mcp add diserverbuilder -e DISCORD_BOT_TOKEN=your-token -- npx -y diserverbuilder-mcp
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "diserverbuilder": {
      "command": "npx",
      "args": ["-y", "diserverbuilder-mcp"],
      "env": { "DISCORD_BOT_TOKEN": "your-token" }
    }
  }
}
```

Requires Node.js 20 or later.

## Environment variables

| Name | Required | Description |
|------|----------|-------------|
| `DISCORD_BOT_TOKEN` | Yes | Bot token |
| `DISCORD_GUILD_ID` | No | Default server ID. If unset, pass `guildId` to each tool |
| `DISERVERBUILDER_SNAPSHOT_DIR` | No | Where snapshots are saved. Default `~/.diserverbuilder/snapshots` |
| `DISERVERBUILDER_READONLY` | No | Set to `1` to register only tools that cannot change Discord (inspect and export, no edits) |

## Safety

- `apply_layout` is a dry run unless you pass `dryRun: false`. It matches existing channels by name, so it moves and updates them instead of duplicating.
- Channels missing from the layout are left alone. They are deleted only with `prune: true` and `dryRun: false`.
- A real `apply_layout` run saves a snapshot first. Call `snapshot` yourself before other large changes.
- Set `DISERVERBUILDER_READONLY=1` to let an assistant look around without being able to change anything.
- `send_message` and `edit_message` suppress `@everyone` and other mentions unless you pass `allowMentions: true`.
- `export_layout` skips uncategorized channels, member overwrites and unsupported channel types. Do not apply an export with `prune: true`, or the skipped channels are deleted.
- `apply_roles` and `sync_permissions` also default to a dry run. `apply_roles` never deletes roles.
- `restore_snapshot` only recreates what is missing (matched by name) and never changes or deletes existing items. It is a dry run by default.
- Discord changes the parent of only one channel per bulk call, so `reorder` cannot move several channels between categories at once. `apply_layout` handles that for you.
- `delete_channel` and `delete_role` need the exact current name and `delete_channel` checks that the channel belongs to the given server. Deleted channels and their messages cannot be restored. Snapshots record structure and permissions only, not messages.
- The token has full channel and role management rights on the server. Keep it out of repositories and shared configs.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm run build   # bundles src/ to dist/index.js (needs Bun)
pnpm start       # runs dist/index.js over stdio
```

## License

MIT
