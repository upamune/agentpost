# agentpost

AIエージェントに独自ドメインのランダムなメールアドレスを発行し、Cloudflareで送受信するAPI・CLI・MCPサーバー。

自分のCloudflareアカウントに配置して使う。ランダムアドレスの発行、本文・原文・添付の取得、送信・返信、切断後に再開できるイベント監視を提供する。Web UIは含まない。

TypeScript / Bun、Workers、D1、R2、Queuesで構成する。HTTPルーティングはHono、外部入力とMCPツールのスキーマはZod、MIME解析はpostal-mimeを使う。

**現時点はローカルで検証できる実装。購入ドメインでの送受信は未検証。** Cloudflare Email SendingはBetaで、タイムアウトなどの結果不明時は自動再送を止めて確認を求める。

## ローカル起動

前提は[mise](https://mise.jdx.dev/getting-started.html)。BunとNode.jsを含むツールは`mise install`で揃う。WranglerはBunランタイム非対応のため、Cloudflareが対応するNode.jsで実行し、依存管理とMCPにはBunを使う。

```sh
git clone https://github.com/upamune/agentpost.git
cd agentpost
mise trust
mise install
mise exec -- bun install --frozen-lockfile
mise exec -- bun run setup:local
mise exec -- bun run db:migrate:local
mise run dev
```

`setup:local`はランダムな管理者トークンを`.dev.vars`に保存する。既存ファイルは上書きしない。CLIを試すときはこのファイルの`ADMIN_TOKEN`を使う。手動設定の場合は32〜256文字の英数字・`_`・`-`を使い、`openssl rand -hex 32`などで生成する。空のサンプルや旧サンプルの固定値では認証を受け付けない。

ローカルの受信・取得はCloudflareの認証情報なしで動く。`CF_ACCOUNT_ID`と`CF_EMAIL_API_TOKEN`を入れると送信キューが実際のCloudflare APIを呼ぶので、実送信を検証するときだけ設定する。

別のターミナルで疎通:

```sh
curl http://localhost:8787/healthz
export MAIL_API_URL=http://localhost:8787
export MAIL_API_TOKEN='YOUR_ADMIN_TOKEN'
curl "$MAIL_API_URL/v1/inboxes" \
  -H "Authorization: Bearer $MAIL_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"label":"research-agent"}'
```

返却される`id`、`address`、`token`を保存する。受信箱トークンでその受信箱の送受信だけを操作できる。管理者トークンは全受信箱の操作と新規発行に使う。発行の応答を受け取れなかった場合は、再発行前に管理者の一覧APIで確認する。

ローカルのメール入力例:

```sh
curl -X POST 'http://localhost:8787/cdn-cgi/local/email' \
  --url-query 'from=sender@example.net' \
  --url-query 'to=GENERATED_ADDRESS@example.com' \
  --data-binary @test/fixtures/hello.eml
```

## API

ローカル起動中は`mise exec -- bun run smoke:local`で、アドレス発行・受信・キュー処理・本文と原文の取得をまとめて検証できる。外部へのメール送信は行わない。別ポートの場合は`LOCAL_MAIL_URL=http://127.0.0.1:8791`などを指定する。

`/healthz`以外は`Authorization: Bearer <token>`が必要。

| Method      | Path                                                   | 操作                                        |
| ----------- | ------------------------------------------------------ | ------------------------------------------- |
| POST        | `/v1/inboxes`                                          | ランダムアドレス発行（管理者）              |
| GET         | `/v1/inboxes?limit=25&offset=0`                        | 受信箱一覧（管理者）                        |
| GET / PATCH | `/v1/inboxes/:id`                                      | 詳細 / 有効・無効の切り替え（変更は管理者） |
| GET         | `/v1/inboxes/:id/messages?limit=25&cursor=...`         | 受信一覧                                    |
| GET         | `/v1/inboxes/:id/messages/:message`                    | 本文・添付情報                              |
| GET         | `/v1/inboxes/:id/messages/:message/raw`                | 元の`.eml`                                  |
| GET         | `/v1/inboxes/:id/messages/:message/attachments/:index` | 添付ダウンロード                            |
| POST        | `/v1/inboxes/:id/messages/:message/reprocess`          | 保存済み原文を再解析                        |
| POST        | `/v1/inboxes/:id/send`                                 | 送信キューへ登録                            |
| POST        | `/v1/inboxes/:id/messages/:message/reply`              | Reply-Toとスレッド情報を使って返信          |
| GET         | `/v1/inboxes/:id/outbox?limit=25&offset=0`             | 送信要求一覧                                |
| GET         | `/v1/inboxes/:id/outbox/:send`                         | 送信状態・プロバイダー応答                  |
| GET         | `/v1/health`                                           | ストレージ疎通・滞留・要確認件数（管理者）  |

管理者用に、受信箱トークンを再発行する`POST /v1/inboxes/:id/token`と、確認済みの送信結果を記録する`POST /v1/inboxes/:id/outbox/:send/resolve`もある。

送信・返信は`Idempotency-Key`ヘッダーが必須。同じメールのリトライでは同じキーを使う。別の内容に同じキーを使うと409を返す。

```sh
curl "$MAIL_API_URL/v1/inboxes/INBOX_ID/send" \
  -H "Authorization: Bearer $MAIL_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: task-123-message-1' \
  -d '{"to":["recipient@example.net"],"subject":"Hello","text":"Hello from my agent"}'
```

`202`は永続化・キュー処理待ち。`accepted`はCloudflareが受理した状態で、宛先への到達を保証しない。`unknown`は管理者による確認が必要。新しいキーでの自動再送は行わない。

## CLI

```sh
export MAIL_API_URL=http://localhost:8787
export MAIL_API_TOKEN='YOUR_ADMIN_OR_INBOX_TOKEN'
mise exec -- bun run cli --help
mise exec -- bun run cli inbox create --label research-agent
mise exec -- bun run cli inbox list
mise exec -- bun run cli message list YOUR_INBOX_UUID
mise exec -- bun run cli send YOUR_INBOX_UUID --to recipient@example.net \
  --subject 'Hello' --text 'Hello from my agent' --idempotency-key task-123-message-1
mise exec -- bun run cli events watch --inbox YOUR_INBOX_UUID \
  --cursor-file .agentpost/received.cursor.json
```

返り値はJSON、イベント監視はNDJSON、エラーは標準エラー。トークンは環境変数から読む。rawメールや添付の保存、送信状態の取得、トークンの再発行なども`--help`に記載している。`src/cli.ts`は`agentpost`の実行エントリーとしてpackage.jsonの`bin`にも登録している。

## MCP

MCP **2026-07-28**と公式SDK v2.4.0に対応する。ローカルのstdioと、Workerの`/mcp`で提供するStreamable HTTPを使える。[MCP Eventsの参照版・配送方式・カーソルの契約](docs/mcp-events.md)も参照する。Eventsは作業部会のドラフトへの対応で、確定したMCP本体の機能とは区別している。

このディレクトリで次のコマンドを実行する。標準入出力のMCPサーバーとして動く。

```sh
MAIL_API_URL=https://YOUR_WORKER.workers.dev \
MAIL_API_TOKEN=YOUR_INBOX_OR_ADMIN_TOKEN \
mise exec -- bun run mcp
```

MCPクライアントには次を設定する。`args`のパスを実際の配置に置き換える。

```json
{
  "mcpServers": {
    "agentpost": {
      "command": "mise",
      "args": [
        "exec",
        "--cd",
        "/absolute/path/to/agentpost",
        "--",
        "bun",
        "run",
        "src/cli.ts",
        "mcp"
      ],
      "env": {
        "MAIL_API_URL": "https://YOUR_WORKER.workers.dev",
        "MAIL_API_TOKEN": "YOUR_INBOX_OR_ADMIN_TOKEN"
      }
    }
  }
}
```

アドレスを自由に発行するエージェントには管理者トークンを渡す。発行後の受信箱を分離したい場合は、各エージェントに個別の受信箱トークンを渡す。ツールは`create_inbox`、`list_inboxes`、`get_inbox`、`list_messages`、`get_message`、`send_email`、`reply_email`、`get_send_status`、`list_outbox`。

HTTPでは`https://YOUR_WORKER.workers.dev/mcp`に、各要求の`Authorization: Bearer <token>`を付けて接続する。OAuthを必須とするホストへの認証連携は未対応。

MCP Eventsは`events/list`・`events/poll`・`events/stream`を実装し、`message.received`と`message.send_status_changed`を通知する。履歴をD1に保存し、署名付きカーソルで切断後に再開できる。pushは相関ID・heartbeat・キャンセルに対応する。Webhookモードは提供していない。

## 本番設定・運用

- [ドメイン購入後の設定と実送受信の検証](docs/deploy.md)
- [障害時の動作、監視、復旧、残る制約](docs/operations.md)
- [最新MCPとEventsの対応範囲](docs/mcp-events.md)

受信は10 MiBまで。JSONリクエストは512 KiBまで。送信はテキストと任意のHTMLに対応し、送信添付は未対応。HTMLや添付を自動実行する機能はない。現在の保存期間は無期限で、自動削除は行わない。

## 開発

```sh
mise run ci
mise exec -- backlog task list
mise exec -- backlog task show task_001
mise exec -- backlog task add --title '次の作業' --priority P2
```

CIはformat、lint（Oxlint / knip / pinact / actionlint）、typecheck、test、build、pinact、secrets（GitleaksによるGit履歴検査）の独立ジョブ。依存は`bun.lock`、ツールは`mise.toml`、GitHub ActionsはSHAで固定する。テストは実際のWorkersランタイム上のD1/R2と、Bun上のMCPクライアントで実行する。ビルドはWranglerのdry-runで、本番への配備は行わない。

開発環境は`upamune/skills`の`init-project`を参照して構成した。API/MCPプロジェクトのためReact/TanStack Startは導入していない。参加方法は[CONTRIBUTING.md](CONTRIBUTING.md)、権限と脆弱性報告は[SECURITY.md](SECURITY.md)を参照する。

## ライセンス

[MIT](LICENSE)。同梱スキルの出典とライセンスは[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)に記載している。`package.json`の`private: true`はnpmへの誤公開を防ぐ設定で、ソースコードの利用を制限するものではない。
