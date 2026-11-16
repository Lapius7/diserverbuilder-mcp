# diserverbuilder-mcp

[English](README.md)

自分の Discord Bot を通して、AI アシスタント（Claude など）に Discord サーバーの構成を組ませる MCP サーバーです。カテゴリ、チャンネル、ロール、権限の上書きを扱えます。

Discord の REST API だけを使います。ゲートウェイにはログインしないので、特権インテントは要らず、Bot をオンラインにしておく必要もありません。

## ツール（51 個）

| 分野 | ツール |
|------|--------|
| 概要 | `list_guilds`、`get_guild_info`、`get_structure`、`export_layout` |
| チャンネル | `create_category`、`create_channel`、`edit_channel`（スローモード、ボイスの上限、フォーラムタグ）、`reorder`、`clone_channel`、`delete_channel` |
| 権限 | `get_permissions`、`set_permissions`、`clear_permissions`、`sync_permissions`（カテゴリの権限を配下に揃える） |
| ロール | `list_roles`、`create_role`、`edit_role`、`delete_role`、`reorder_roles`、`apply_roles`、`add_member_role`、`remove_member_role`、`search_members` |
| 一括反映とバックアップ | `apply_layout`（構成全体を宣言）、`snapshot`、`list_snapshots`、`restore_snapshot`（別サーバーへの構成コピーにも使える） |
| サーバー | `edit_guild`、`list_emojis`、`create_emoji`、`delete_emoji`、`list_invites`、`create_invite`、`delete_invite`、`list_webhooks`、`create_webhook`、`delete_webhook`、`list_events`、`create_event`、`delete_event`、`get_audit_log` |
| メッセージ | `send_message`（本文と埋め込み、ピン留め）、`edit_message`、`delete_message`、`pin_message`、`get_messages` |
| スレッドとフォーラム | `create_forum_post`、`create_thread`、`list_threads`、`edit_thread`、`set_forum_options`（タグは `edit_channel` で設定） |

## セットアップ

### 1. Bot を作る

1. [Discord Developer Portal](https://discord.com/developers/applications) でアプリケーションを作り、Bot を追加します。
2. Bot のトークンをコピーします（Bot → Reset Token）。外に出さないでください。
3. 次のどちらかの URL で Bot をサーバーに招待します（`YOUR_CLIENT_ID` を置き換え）。

構成の操作だけ（チャンネルの閲覧、チャンネルの管理、ロールの管理）:

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot&permissions=268436496
```

すべてのツール（上に加えて、サーバー管理、Webhook の管理、イベントの管理、絵文字の作成と管理、招待の作成、監査ログの表示、メッセージの送信、埋め込みリンク、メッセージ履歴の閲覧、メッセージの管理、ピン留め、公開スレッドの作成、スレッドでのメッセージ送信、スレッドの管理）:

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot&permissions=2260932793298097
```

権限が足りないツールは、その旨のエラーを返して失敗するだけなので、まず小さいほうから始められます。

Bot のロールは操作したいロールより上に置いてください。Discord の仕様で、Bot は自分より上のロールを編集できず、自分が持たない権限も付与できません。

### 2. MCP クライアントに登録する

Claude Code:

```sh
claude mcp add -s user diserverbuilder -- npx -y diserverbuilder-mcp
```

Claude Desktop（`claude_desktop_config.json`）:

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

### 3. Bot のトークンを保存する

```sh
npx diserverbuilder-mcp auth
```

トークンを入力すると（画面には表示されません）、Discord で有効か確かめてから、自分だけが読める `~/.diserverbuilder/config.json` に保存します。トークンはシェルの履歴にも、MCP の設定にも、チャットにも残りません。トークンを再発行したときは、もう一度実行してください。`auth status` で使われるトークンの出どころを確認でき、`auth logout` で保存したトークンを削除できます。

環境変数 `DISCORD_BOT_TOKEN` で渡すこともできます（たとえば MCP の登録の `env`）。保存したトークンより優先されます。

Node.js 20 以上が必要です。

## トラブルシューティング

| メッセージ | 原因と対処 |
|------------|------------|
| `The bot token is invalid or was reset`（401） | トークンが間違っているか、リセットされています。Developer Portal（Bot → Reset Token）で新しいトークンを取り直し、`npx diserverbuilder-mcp auth` を実行してください。`DISCORD_BOT_TOKEN` を設定している場合は保存したトークンより優先されるので、そちらを直すか外してください。 |
| `The bot lacks a permission`（403） | 上の権限で Bot を招待し直し、Bot のロールを操作したいロールより上に置いてください。 |
| `The bot cannot see this`（50001） | Bot がそのサーバーにいないか、チャンネルを見られません。 |
| `Not found`（404） | ID が違うか、別のサーバーのものです。`list_guilds`、`get_structure`、`list_roles` で調べてください。 |
| `No bot token` | `npx diserverbuilder-mcp auth` を実行するか、MCP の登録の `env` に `DISCORD_BOT_TOKEN` を設定してください。 |

トークンをチャットやログ、リポジトリに載せてしまったら、すぐに Developer Portal で再発行してください。

## 環境変数

| 名前 | 必須 | 説明 |
|------|------|------|
| `DISCORD_BOT_TOKEN` | いいえ | Bot のトークン。`auth` で保存したものより優先される。どちらか一方を設定する |
| `DISCORD_GUILD_ID` | いいえ | 既定のサーバー ID。未設定なら各ツールに `guildId` を渡す |
| `DISERVERBUILDER_CONFIG_DIR` | いいえ | `auth` がトークンを保存する場所。既定は `~/.diserverbuilder` |
| `DISERVERBUILDER_SNAPSHOT_DIR` | いいえ | スナップショットの保存先。既定は `~/.diserverbuilder/snapshots` |
| `DISERVERBUILDER_READONLY` | いいえ | `1` にすると、Discord を変更できないツールだけを登録する（見る・書き出すだけで、編集は不可） |

## 安全のために

- `apply_layout` は `dryRun: false` を渡すまで計画を表示するだけです。既存のチャンネルは名前で照合するので、重複して作らず、移動や更新で済ませます。
- 構成に書いていないチャンネルは触りません。削除されるのは `prune: true` かつ `dryRun: false` のときだけです。
- `apply_layout` を実際に実行する前に、スナップショットを自動で保存します。それ以外の大きな変更の前は `snapshot` を自分で呼んでください。
- `DISERVERBUILDER_READONLY=1` にすると、AI に中を見せるだけで、何も変更させずに済みます。
- `send_message` と `edit_message` は`allowMentions: true` を渡さない限り、`@everyone` などのメンションで通知しません。
- `export_layout` はカテゴリなしのチャンネル、メンバー個別の権限、未対応のチャンネル種別を書き出しません。書き出した内容を `prune: true` で反映すると、それらが削除されるので避けてください。
- `apply_roles` と `sync_permissions` も既定は dry run です。`apply_roles` はロールを削除しません。
- `restore_snapshot` は無いものだけを名前で照合して作り直し、既存のものは変更も削除もしません。既定は dry run です。
- Discord は一括呼び出しでは 1 件のチャンネルの親しか変えられません。`reorder` では複数のチャンネルをカテゴリ間で一度に動かせないので、その場合は `apply_layout` を使います。
- `delete_channel` と `delete_role` は現在の名前の完全一致を求めます。`delete_channel` はさらに、指定したサーバーに属することも確かめてから削除します。削除したチャンネルとメッセージは元に戻せません。スナップショットに入るのは構成と権限だけで、メッセージは入りません。
- トークンはそのサーバーのチャンネルとロールを管理できる権限を持ちます。リポジトリや共有の設定ファイルに入れないでください。`auth` は、自分だけが読めるファイルに保存します。

## 開発

```sh
pnpm install
pnpm run typecheck
pnpm run build   # src/ を dist/index.js にまとめる（Bun が必要）
pnpm start       # dist/index.js を stdio で起動
```

## ライセンス

MIT
