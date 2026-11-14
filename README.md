# diserverbuilder-mcp

[日本語](README.ja.md)

An MCP server that lets an AI assistant (Claude, etc.) build and reorganize a Discord server through a bot you own: categories, channels, roles, and permission overwrites.

It talks to the Discord REST API only. It does not log in to the gateway, so it needs no privileged intents and the bot does not have to stay online.

## Tools

| Tool | What it does |
|------|--------------|
| `list_guilds` | List servers the bot has joined |
| `get_structure` | Show categories and channels in display order, with IDs |
| `list_roles` | List roles with IDs |
| `snapshot` | Save channels, roles, and permission overwrites as JSON |
| `create_category` / `create_channel` | Create a category or channel (text, voice, announcement, stage, forum) |
| `edit_channel` | Change name, topic, NSFW flag, or parent category |
| `reorder` | Change order and parent of many channels at once |
| `set_permissions` / `clear_permissions` | Set or remove a role or member's overwrite on a channel |
| `create_role` | Create a role |
| `delete_channel` | Delete a channel or category (needs the exact current name) |
| `apply_layout` | Declare the whole structure and apply it. Dry run by default |

## Setup

### 1. Create a bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications), create an application, and add a bot.
2. Copy the bot token (Bot, then Reset Token). Keep it secret.
3. Invite the bot to your server with this URL (replace `YOUR_CLIENT_ID`). It requests View Channels, Manage Channels, and Manage Roles:

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot&permissions=268436496
```

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

## Safety

- `apply_layout` is a dry run unless you pass `dryRun: false`. It matches existing channels by name, so it moves and updates them instead of duplicating.
- Channels missing from the layout are left alone. They are deleted only with `prune: true` and `dryRun: false`.
- A real `apply_layout` run saves a snapshot first. Call `snapshot` yourself before other large changes.
- `delete_channel` needs the exact current name and checks that the channel belongs to the given server. Deleted channels and their messages cannot be restored. Snapshots record structure and permissions only, not messages.
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
