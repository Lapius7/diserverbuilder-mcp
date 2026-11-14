# diserverbuilder-mcp

[English](README.md)

自分の Discord Bot を通して、AI アシスタント（Claude など）に Discord サーバーの構成を組ませる MCP サーバーです。カテゴリ、チャンネル、ロール、権限の上書きを扱えます。

Discord の REST API だけを使います。ゲートウェイにはログインしないので、特権インテントは要らず、Bot をオンラインにしておく必要もありません。

## ツール

| ツール | できること |
|--------|------------|
| `list_guilds` | Bot が参加しているサーバーの一覧 |
| `get_structure` | カテゴリとチャンネルの構成を、見た目の順番で ID つきで表示 |
| `list_roles` | ロールを ID つきで一覧 |
| `snapshot` | チャンネル、ロール、権限の上書きを JSON で保存 |
| `create_category` / `create_channel` | カテゴリ、チャンネル（テキスト、ボイス、アナウンス、ステージ、フォーラム）を作成 |
| `edit_channel` | 名前、トピック、NSFW、親カテゴリを変更 |
| `reorder` | 複数チャンネルの並びと親をまとめて変更 |
| `set_permissions` / `clear_permissions` | チャンネルごとのロール・メンバーの権限上書きを設定、削除 |
| `create_role` | ロールを作成 |
| `delete_channel` | チャンネルやカテゴリを削除（現在の名前を正確に渡す必要がある） |
| `apply_layout` | 理想の構成を宣言してまとめて反映。既定は dry run |

## セットアップ

### 1. Bot を作る

1. [Discord Developer Portal](https://discord.com/developers/applications) でアプリケーションを作り、Bot を追加します。
2. Bot のトークンをコピーします（Bot → Reset Token）。外に出さないでください。
3. 次の URL で Bot をサーバーに招待します（`YOUR_CLIENT_ID` を置き換え）。要求する権限は、チャンネルの閲覧、チャンネルの管理、ロールの管理です。

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot&permissions=268436496
```

Bot のロールは、操作したいロールより上に置いてください。Discord の仕様で、Bot は自分より上のロールを編集できず、自分が持たない権限も付与できません。

### 2. MCP クライアントに登録する

Claude Code:

```sh
claude mcp add diserverbuilder -e DISCORD_BOT_TOKEN=your-token -- npx -y diserverbuilder-mcp
```

Claude Desktop（`claude_desktop_config.json`）:

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

Node.js 20 以上が必要です。

## 環境変数

| 名前 | 必須 | 説明 |
|------|------|------|
| `DISCORD_BOT_TOKEN` | はい | Bot のトークン |
| `DISCORD_GUILD_ID` | いいえ | 既定のサーバー ID。未設定なら各ツールに `guildId` を渡す |
| `DISERVERBUILDER_SNAPSHOT_DIR` | いいえ | スナップショットの保存先。既定は `~/.diserverbuilder/snapshots` |

## 安全のために

- `apply_layout` は、`dryRun: false` を渡すまで計画を表示するだけです。既存のチャンネルは名前で照合するので、重複して作らず、移動や更新で済ませます。
- 構成に書いていないチャンネルは触りません。削除されるのは、`prune: true` かつ `dryRun: false` のときだけです。
- `apply_layout` を実際に実行する前に、スナップショットを自動で保存します。それ以外の大きな変更の前は、`snapshot` を自分で呼んでください。
- `delete_channel` は、現在の名前の完全一致と、指定したサーバーに属することを確かめてから削除します。削除したチャンネルとメッセージは元に戻せません。スナップショットに入るのは構成と権限だけで、メッセージは入りません。
- トークンは、そのサーバーのチャンネルとロールを管理できる権限を持ちます。リポジトリや共有の設定ファイルに入れないでください。

## 開発

```sh
pnpm install
pnpm run typecheck
pnpm run build   # src/ を dist/index.js にまとめる（Bun が必要）
pnpm start       # dist/index.js を stdio で起動
```

## ライセンス

MIT
