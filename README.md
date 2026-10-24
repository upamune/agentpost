# agentpost

AIエージェントのための独自ドメインのメール受信箱。

agentpostはAIエージェント向けのセルフホスト型メールサービスです。
エージェントやタスクごとにランダムなメールアドレスを発行し、API、CLI、MCPからメールを送受信できます。
自分のCloudflareアカウントで動かし、メールと認証情報を管理できます。

## できること

- 独自ドメインにランダムなメールアドレスを発行し、受信箱を作成します。有効化、無効化、トークンの再発行にも対応します。
- メールの本文、HTML、添付ファイル、原文の`.eml`を取得できます。
- 発行したアドレスからメールを送信し、Reply-Toとスレッド情報を引き継いで返信できます。
- エージェントとの接続に、JSONを返すCLI、HTTP API、stdioとStreamable HTTPのMCPサーバーを提供します。
- 受信と送信状態の変化を監視し、保存したカーソルから再開できます。
- 受信箱トークンで、エージェントが操作できるメールを受信箱ごとに分離できます。

現在は初期開発段階です。
ローカル環境での検証を行っていますが、独自ドメインでの実際のメール送受信は未検証です。
送信に使う[Cloudflare Email Sending](https://developers.cloudflare.com/email-service/get-started/send-emails/)はBetaです。
本番導入前に、利用する環境で送受信と復旧手順を確認してください。

## ローカルで試す

[mise](https://mise.jdx.dev/getting-started.html)をインストールして、次のコマンドを実行します。
必要なBunとNode.jsのバージョンはリポジトリで固定しています。
ローカルの受信テストには、独自ドメインやCloudflareの認証情報は不要です。

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

`setup:local`はランダムな管理者トークンを含む`.dev.vars`を作成します。
既存のファイルは上書きしません。
このファイルはGitの管理対象外です。

サーバーを起動したまま、別のターミナルから受信テストを実行できます。

```sh
mise exec -- bun run smoke:local
```

このテストは受信箱の発行、テストメールの投入、キューによる解析、本文と原文の取得を確認します。
外部へのメール送信は行いません。

### CLIで受信箱を作る

リポジトリのルートで、接続先とトークンを設定します。
`AGENTPOST_API_TOKEN`には`.dev.vars`の`AGENTPOST_ADMIN_TOKEN`の値を指定してください。

```sh
export AGENTPOST_API_URL=http://localhost:8787
export AGENTPOST_API_TOKEN='YOUR_ADMIN_TOKEN'

mise exec -- bun run cli inbox create --label research-agent
```

応答に含まれる`id`、`address`、`token`を保存します。
受信箱トークンは作成時と再発行時にだけ返されます。
以後、その受信箱だけを扱うエージェントには`token`を渡してください。

```sh
export AGENTPOST_API_TOKEN='YOUR_INBOX_TOKEN'

mise exec -- bun run cli inbox get YOUR_INBOX_UUID
mise exec -- bun run cli message list YOUR_INBOX_UUID
mise exec -- bun run cli events watch --inbox YOUR_INBOX_UUID \
  --cursor-file .agentpost/received.cursor.json
```

CLIはJSONを標準出力に返し、イベント監視では1行に1件のJSON（NDJSON）を返します。
コマンドの一覧は`mise exec -- bun run cli --help`で確認できます。
設定に使う環境変数はすべて`AGENTPOST_`で始まります。
Worker、CLI、MCPそれぞれの設定先は[環境変数の一覧](docs/deploy.md#環境変数)を参照してください。

## Cloudflareに導入する

実際のメールを送受信するには、次の準備が必要です。

- Cloudflare DNSで管理する独自ドメイン
- Cloudflare Workers Paidと、D1、R2、Queuesを利用できるアカウント
- 対象ドメインのEmail RoutingとEmail Sendingの有効化
- Email SendingのAPIトークンと、管理者トークン

[導入手順](docs/deploy.md)に沿って、ストレージとキューの作成、DNS、Secrets、デプロイ、catch-allの設定を行ってください。
アドレスごとのルーティング設定は不要です。
agentpostが発行した有効なアドレスだけでメールを受け入れます。

導入後は`AGENTPOST_API_URL`をWorkerのHTTPS URLに変更すると、同じCLIとMCPを使えます。
ローカルの`.dev.vars`に`AGENTPOST_CF_ACCOUNT_ID`と`AGENTPOST_CF_EMAIL_API_TOKEN`を設定した場合も、実際の送信APIを呼びます。
そのため、送信テストには自分で管理する宛先を指定してください。

### メールを送る

送信には同じ要求を識別する**冪等キー**を必ず指定します。
同じメールの要求を再試行するときは、同じキーを使ってください。

```sh
mise exec -- bun run cli send YOUR_INBOX_UUID \
  --to recipient@example.net \
  --subject 'Hello' \
  --text 'Hello from my agent' \
  --idempotency-key task-123-message-1

mise exec -- bun run cli outbox get YOUR_INBOX_UUID YOUR_SEND_UUID
```

送信を要求すると、状態を確認するためのoutbox IDが返されます。
`accepted`はCloudflareが要求を受理した状態で、宛先への配達完了を意味しません。
タイムアウトなどで結果が`unknown`になった場合は、自動再送せず、管理者が送信結果を確認します。

## MCPから使う

MCPクライアントから、受信箱の発行、受信メールの取得、送信、返信、送信状態の確認を行えます。
対応するプロトコルはMCP **2026-07-28**、公式TypeScript SDKはv2.4.0です。

| 操作       | ツール                                      |
| ---------- | ------------------------------------------- |
| 受信箱     | `create_inbox`、`list_inboxes`、`get_inbox` |
| 受信メール | `list_messages`、`get_message`              |
| 送信と返信 | `send_email`、`reply_email`                 |
| 送信状態   | `get_send_status`、`list_outbox`            |

### stdio

クライアントの設定例です。
`/absolute/path/to/agentpost`をcloneしたディレクトリに置き換えてください。
ローカルサーバーに接続する場合は`AGENTPOST_API_URL`を`http://localhost:8787`に変更します。

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
        "AGENTPOST_API_URL": "https://YOUR_WORKER.workers.dev",
        "AGENTPOST_API_TOKEN": "YOUR_INBOX_TOKEN"
      }
    }
  }
}
```

受信箱の新規発行と一覧取得には管理者トークンが必要です。
管理者トークンは全受信箱を操作できるため、必要なエージェントにだけ渡してください。

### Streamable HTTP

Workerの`https://YOUR_WORKER.workers.dev/mcp`に接続し、各要求に`Authorization: Bearer <token>`を付けます。
OAuth認証は未対応のため、接続先URLとBearerトークンを設定できるクライアントが必要です。

### MCP Events

受信通知の`message.received`と、送信状態通知の`message.send_status_changed`を提供します。
`events/list`、`events/poll`、`events/stream`に対応し、pollとpushで購読できます。

**MCP Eventsへの対応は作業部会のドラフトに基づく実験的な機能です**。
MCP本体の確定仕様とは別に扱い、対応クライアントで利用してください。
参照したドラフト、購読とカーソルの扱いは[MCPとEventsの対応範囲](docs/mcp-events.md)を参照してください。

## HTTP API

受信箱の発行から送受信、イベント監視まで、Bearerトークン付きのHTTP APIで操作できます。

```sh
curl "$AGENTPOST_API_URL/v1/inboxes" \
  -H "Authorization: Bearer $AGENTPOST_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"label":"research-agent"}'
```

上の発行例には管理者トークンが必要です。
エンドポイントと送信例は[HTTP APIリファレンス](docs/http-api.md)に記載しています。

## 保存と障害対応

メールの原文と本文はR2、受信箱、処理状態、イベント履歴はD1に保存します。
Cloudflare WorkersがAPIとMCPを提供し、Queuesでメールを処理します。

受信時は原文を保存してから解析します。
キューへの投入や解析が失敗した場合は、保存済みの原文から復旧を試みます。
送信時は要求を永続化します。
キュー処理が重複しても、条件付きの状態更新で二重送信を防ぎます。

監視項目、再試行の条件、障害時の復旧手順は[運用設計](docs/operations.md)を参照してください。

## 制約

| 項目                | 対応範囲                                                          |
| ------------------- | ----------------------------------------------------------------- |
| 受信サイズ          | 1通あたり10 MiBまで                                               |
| APIのJSONリクエスト | 512 KiBまで                                                       |
| 送信形式            | テキストと任意のHTML。送信添付は未対応                            |
| 保存期間            | メールとイベントを無期限に保存。自動削除は未対応                  |
| イベント配信        | at-least-once。受信側で`eventId`による重複除去が必要              |
| 認証                | 管理者トークンと受信箱トークン。OAuthは未対応                     |
| インターフェース    | API、CLI、MCP。Web UI、IMAP、クライアント向けSMTPサーバーは未提供 |

メール本文や添付は信頼できない外部入力です。
エージェントに渡す際の権限設定と、脆弱性の報告方法は[SECURITY.md](SECURITY.md)を参照してください。

## 開発とコントリビューション

```sh
mise run format
mise run ci
```

CIでは整形、静的解析、型検査、テスト、dry-runビルド、秘密情報チェックを実行します。
実メールの送信と本番への自動デプロイは行いません。
不具合や提案は[Issues](https://github.com/upamune/agentpost/issues)、開発手順は[CONTRIBUTING.md](CONTRIBUTING.md)を参照してください。

## ライセンス

[MIT](LICENSE)。
同梱スキルの出典とライセンスは[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)に記載しています。
