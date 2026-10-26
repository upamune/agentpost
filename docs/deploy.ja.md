# Cloudflareへの導入

[English](deploy.md) | [日本語](deploy.ja.md)

Cloudflare DNSで管理する独自ドメインを使う。ローカル検証と本番稼働は別で、最後の実送受信が通るまでは運用開始しない。

## 環境変数

利用者が設定する環境変数には`AGENTPOST_`プレフィックスを付ける。
CLIとstdioのMCPはプロセスの環境変数を読み、Workerは`wrangler.jsonc`の`vars`とWorkers Secretsを読む。ローカルのWorker Secretsは`.dev.vars`に設定する。

| 名前                                     | 設定先                   | 用途                                                                    |
| ---------------------------------------- | ------------------------ | ----------------------------------------------------------------------- |
| `AGENTPOST_API_URL`                      | CLI / stdio MCP          | APIの接続先。ローカルは`http://localhost:8787`、本番はWorkerのHTTPS URL |
| `AGENTPOST_API_TOKEN`                    | CLI / stdio MCP          | 操作に使う管理者トークンまたは受信箱トークン                            |
| `AGENTPOST_ADMIN_TOKEN`                  | Worker Secret            | 全受信箱を管理するトークン                                              |
| `AGENTPOST_EMAIL_DOMAIN`                 | `wrangler.jsonc`の`vars` | メールアドレスを発行するドメイン                                        |
| `AGENTPOST_CF_ZONE_ID`                   | Worker vars              | 診断対象のゾーンID（任意）                                              |
| `AGENTPOST_CF_SENDING_SUBDOMAIN_ID`      | Worker vars              | 診断対象の送信ドメインID（任意）                                        |
| `AGENTPOST_CF_DIAGNOSTICS_API_TOKEN`     | Worker Secret            | 上記2件と併せて使う専用の診断資格情報                                   |
| `AGENTPOST_CF_ACCOUNT_ID`                | Worker Secret            | Email Sendingを利用するCloudflareアカウントID                           |
| `AGENTPOST_CF_EMAIL_API_TOKEN`           | Worker Secret            | Email Sending権限を持つCloudflare APIトークン                           |
| `AGENTPOST_AUTH_MODE`                    | Worker vars              | `token`（既定）・`oauth`・`both`                                        |
| `AGENTPOST_CURSOR_KEY`                   | Worker Secret            | 独立したイベントカーソル暗号化鍵。OAuth/bothでは必須                    |
| `AGENTPOST_ACCESS_TEAM_DOMAIN`           | Worker vars              | 信頼するAccess teamのHTTPS origin                                       |
| `AGENTPOST_ACCESS_AUD`                   | Worker vars              | Accessアプリの対象AUD                                                   |
| `AGENTPOST_ACCESS_PRINCIPALS`            | Worker vars              | 本人IDとロールのJSON対応表                                              |
| `AGENTPOST_OAUTH_RESOURCE_URL`           | Worker vars              | `/mcp`で終わる正規のHTTPS URL                                           |
| `AGENTPOST_OAUTH_AUTHORIZATION_SERVER`   | Worker vars              | Accessメタデータにある正確なAS issuer                                   |
| `AGENTPOST_FORWARD_ALLOWED_DESTINATIONS` | Worker Secret            | 任意。信頼する検証済み転送先のJSON配列。未設定なら許可なし              |
| `AGENTPOST_WEBHOOK_ENCRYPTION_KEY`       | Worker Secret            | 任意。Webhook設定の暗号化に使う32バイト・64文字16進数の独立鍵           |
| `AGENTPOST_WEBHOOK_ALLOWED_ORIGINS`      | Worker vars              | 任意。信頼する公開HTTPS originの完全一致JSON配列                        |
| `AGENTPOST_LOCAL_URL`                    | ローカル受信テスト       | `smoke:local`の接続先。既定値は`http://127.0.0.1:8787`                  |

OAuthまたはbothでは、デプロイ前に[認証設定](authentication.ja.md)を行います。既定のtoken専用ではAccessアプリは不要です。

旧名から移行する場合は、次の対応で名前だけを変更し、値は保持する。旧名は読み取らない。

| 旧名                 | 新しい名前                     |
| -------------------- | ------------------------------ |
| `MAIL_API_URL`       | `AGENTPOST_API_URL`            |
| `MAIL_API_TOKEN`     | `AGENTPOST_API_TOKEN`          |
| `ADMIN_TOKEN`        | `AGENTPOST_ADMIN_TOKEN`        |
| `EMAIL_DOMAIN`       | `AGENTPOST_EMAIL_DOMAIN`       |
| `CF_ACCOUNT_ID`      | `AGENTPOST_CF_ACCOUNT_ID`      |
| `CF_EMAIL_API_TOKEN` | `AGENTPOST_CF_EMAIL_API_TOKEN` |
| `LOCAL_MAIL_URL`     | `AGENTPOST_LOCAL_URL`          |

既存のWorkerを更新する場合は、新しい名前のSecretsを同じ値で登録してからデプロイする。CLIの環境変数、MCPの接続設定、`.dev.vars`も更新する。
token専用で`AGENTPOST_CURSOR_KEY`を省略した場合は管理者トークンから暗号化鍵も導くため、値を変えるとカーソルも無効になる。OAuth/bothでは独立したカーソル鍵が必須。

旧署名形式のカーソルも拒否されます。[カーソルの移行](mcp-events.ja.md#カーソルの移行)に従って状態を照合してください。

受信箱のメモ・URLを使うには、Workerの更新前に `0008_inbox_metadata.sql` を含むすべてのD1マイグレーションを適用します。既存の受信箱には空のメタデータを追加し、識別情報・資格情報・メールを維持します。[更新手順](inbox-metadata.ja.md#更新手順)を参照してください。

## 1. アカウントとドメイン

1. CloudflareのWorkers PaidとD1・R2・Queues・SQLite-backed Durable Objectsを利用できる状態にする。
2. ダッシュボードのEmail Serviceで、購入ドメインの**Email RoutingとEmail Sendingの両方**を有効化する。
3. Cloudflareが提示するMX・SPF・DKIM・DMARCの設定・検証を完了する。SendingはBetaなので、そのアカウントで実際に有効化できることを確認する。
4. APIトークンに、対象アカウントの**Email Sending: Edit**権限を付与する。Worker実行時のトークンはメール送信に限定し、DNS変更・アカウント管理の権限を付けない。

`wrangler.jsonc`の`vars.AGENTPOST_EMAIL_DOMAIN`を購入ドメインに変える。`AGENTPOST_CF_ACCOUNT_ID`はそのドメインとEmail Sendingを所有するアカウントのID。

公式資料: [ドメイン設定](https://developers.cloudflare.com/email-service/configuration/domains/)、[送信](https://developers.cloudflare.com/email-service/get-started/send-emails/)、[REST API](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/)。

DNS設定後、管理者として `mise exec -- bun run cli domain check` を実行し、[ドメイン診断](domain-diagnostics.ja.md)の結果を確認してください。`--strict` は警告も失敗にします。Cloudflareとの照合用資格情報は任意で、送信用トークンとは分けます。伝播や実メールの認証確認は別途必要です。

## 2. ストレージとキュー

以下は本番アカウントのリソースを作るコマンド。新しいアカウントや環境では、一つずつ結果を確認する。同名の既存リソースは再利用の可否を確認してから設定する。

```sh
mise exec -- bun run wrangler login
mise exec -- bun run wrangler whoami
mise exec -- bun run wrangler d1 create agentpost
```

返された`database_id`を`wrangler.jsonc`に設定する。D1の全ゼロIDはローカル用プレースホルダー。

```sh
mise exec -- bun run wrangler r2 bucket create agentpost
mise exec -- bun run wrangler queues create agentpost
mise exec -- bun run wrangler queues create agentpost-dlq
mise exec -- bun run wrangler queues create agentpost-webhooks
mise exec -- bun run wrangler queues create agentpost-webhooks-dlq
mise exec -- bun run wrangler d1 migrations apply DB --remote
```

R2は非公開のままにし、`r2.dev`や公開カスタムドメインを有効化しない。メール取得は認証付きWorker APIを通す。

### アクセスと送信の制限

`wrangler.jsonc`の`ratelimits`に、HTTPアクセス用の`AGENTPOST_REQUEST_LIMITER`と送信要求用の`AGENTPOST_SEND_LIMITER`を定義している。シェルの環境変数やSecretsとして登録する値ではなく、Wranglerが作るバインディング。

- HTTPは認証前にIP単位で毎分300回。APIとMCPで共通。MCPが内部でAPIを呼ぶ処理では二重に数えない。
- 新しい送信・返信は受信箱単位で毎分10回。宛先数ではなく要求数。同じ冪等キーへの再要求は新規枠を使わない。
- 429では`Retry-After: 60`に従って待つ。同じ論理メールの再要求に新しいキーを発行しない。制限基盤が使えなければ503で新規要求を拒否する。

`namespace_id`はCloudflareアカウント内で他のWorkerと重複しない値にする。ステージング・本番を分ける場合は別のIDを設定し、Wranglerの名前付き環境には両方のバインディングを明示する。同じIDの環境はカウンターを共有する。

[Cloudflareのレート制限](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)は拠点ごとの近似値で、厳密な世界共通クォータではない。送信先の許可リストや日次の課金上限をこの制限で代用しない。公開時はCloudflare側のWAF・アクセス制御・送信上限も運用方針に合わせて設定する。

HTTPはlocalhost・ループバック以外では拒否する。TLSを別のプロキシで終端する場合もWorkerまでHTTPSを使い、OriginはWorkerへの要求URLと一致させる。

## 3. Secretsとデプロイ

token/bothでは`AGENTPOST_ADMIN_TOKEN`に32〜256文字の英数字・`_`・`-`からなるランダム文字列を使用する。生成例は`openssl rand -hex 32`。ローカル開発用とは別の値を生成する。秘密情報をREADME・チャット・Gitに貼らない。

OAuth専用では下の管理者トークン登録を省略し、Accessの本人にadminを付与します。OAuth/bothでは`wrangler secret put AGENTPOST_CURSOR_KEY`も実行します。

```sh
mise exec -- bun run wrangler secret put AGENTPOST_ADMIN_TOKEN
mise exec -- bun run wrangler secret put AGENTPOST_CF_ACCOUNT_ID
mise exec -- bun run wrangler secret put AGENTPOST_CF_EMAIL_API_TOKEN
mise run ci
mise exec -- bun run deploy
```

`wrangler.jsonc`の`AGENTPOST_INBOX_COORDINATOR`バインディングと`InboxCoordinator`のSQLite migrationもデプロイで作成される。名前付き環境を使う場合は、このバインディングも明示する。既存環境からの更新・復元時は[同期基盤の前提](operations.ja.md#同期基盤の前提)を確認する。

コマンドが返すWorker URLを`AGENTPOST_API_URL`に使う。CIには実メール送信や自動デプロイを含めていない。

## 4. Catch-all

Email Routingの対象ドメインで、catch-allの宛先を**Worker `agentpost`**にする。通常の転送先メールアドレスに向けない。

メールアドレスごとのRouting ruleは不要。WorkerはD1で発行済みかつ有効な宛先のみ受け入れ、その他にはSMTP拒否を返す。アドレスの有効化・無効化はAPIに反映される。無効化より前に受け入れた受信処理は、後から原文保存を完了できる。

公式資料: [ルーティング設定](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/)。

## 5. 実送受信の確認

外部のテスト用メールアドレスを用意し、次を順に行う。送信はその宛先を明示して実施する。

1. 選択した資格情報（管理者トークンまたは権限を付与したOAuth本人）で受信箱を発行する。
2. 外部メールから発行アドレスに送る。APIで本文・添付・元の`.eml`を取得できることを確認する。
3. 発行アドレスから外部メールに送る。outboxの`accepted`に加え、外部メールの受信・SPF/DKIM/DMARC結果を確認する。
4. 外部からのメールにreply APIで返信する。Reply-To、差出人、件名、スレッドを確認する。
5. 同じIdempotency-Keyで送信APIを再実行し、outbox IDが変わらず、宛先へのメールが増えないことを確認する。
6. 別の受信箱トークンで最初の受信箱を取得できないことを確認する。
7. 受信箱を無効化し、受信拒否とトークン失効を確認する。
8. Workers Logs、Queues/DLQ、Cron Triggerの実行を確認し、次節の監視を設定する。

## 6. 監視と復旧確認

`GET /healthz`はWorkerの生存だけを見る。**`GET /v1/health`を管理者認証付きの外部監視に登録**し、503を通知対象にする。管理者権限が必要。OAuth専用の無人監視は、Access Service Authと明示的にadminを付与したサービスIDで構成する。このリポジトリには外部監視サービスへの登録や通知先の設定は含まれていない。

受信・送信の外部テストを定期的に行う場合は、専用の宛先と実行間隔を決めてから設定する。単なるHTTPヘルスチェックではDNS、メール受信、到達性の障害を検出できない。

[運用設計](operations.ja.md)の復旧手順をステージングで実施する。D1のTime TravelとR2の保存原文を使って復旧できることを確認する。バックアップの確認や復旧訓練が済むまでは、安定稼働を検証済みと扱わない。

## 受信Webhookを有効にする

現在のWrangler設定はメール処理とは別の`AGENTPOST_WEBHOOK_JOBS`キューとDLQを宣言します。既存環境の更新時も専用キューを作成し、`0006_inbox_webhooks.sql`を適用してください。通知の有効化には独立した暗号鍵と信頼するorigin許可リストが必要です。各受信箱の通知先は既定では未設定です。[Webhook設定・署名検証・復旧](webhooks.ja.md)に従い、許可された通知先で受信確認してから稼働を報告します。メール本文や資格情報を通知に含めません。

## 受信メールの転送

転送を無効のままにする場合も、今回のWorker更新前に`0007_forwarding.sql`を適用します。Cloudflare Email Routingで宛先を検証し、許可リストを非公開に保存してから、管理者のAPI・CLI・MCPで全体と個別の設定を行います。新たなキューや送信用bindingは不要です。稼働確認には許可された宛先で[転送の確認](forwarding.ja.md)を完了してください。
