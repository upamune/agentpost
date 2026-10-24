# Cloudflareへの導入

Cloudflare DNSで管理する独自ドメインを使う。ローカル検証と本番稼働は別で、最後の実送受信が通るまでは運用開始しない。

## 環境変数

利用者が設定する環境変数には`AGENTPOST_`プレフィックスを付ける。
CLIとstdioのMCPはプロセスの環境変数を読み、Workerは`wrangler.jsonc`の`vars`とWorkers Secretsを読む。ローカルのWorker Secretsは`.dev.vars`に設定する。

| 名前                           | 設定先                   | 用途                                                                    |
| ------------------------------ | ------------------------ | ----------------------------------------------------------------------- |
| `AGENTPOST_API_URL`            | CLI / stdio MCP          | APIの接続先。ローカルは`http://localhost:8787`、本番はWorkerのHTTPS URL |
| `AGENTPOST_API_TOKEN`          | CLI / stdio MCP          | 操作に使う管理者トークンまたは受信箱トークン                            |
| `AGENTPOST_ADMIN_TOKEN`        | Worker Secret            | 全受信箱を管理するトークン                                              |
| `AGENTPOST_EMAIL_DOMAIN`       | `wrangler.jsonc`の`vars` | メールアドレスを発行するドメイン                                        |
| `AGENTPOST_CF_ACCOUNT_ID`      | Worker Secret            | Email Sendingを利用するCloudflareアカウントID                           |
| `AGENTPOST_CF_EMAIL_API_TOKEN` | Worker Secret            | Email Sending権限を持つCloudflare APIトークン                           |
| `AGENTPOST_LOCAL_URL`          | ローカル受信テスト       | `smoke:local`の接続先。既定値は`http://127.0.0.1:8787`                  |

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
管理者トークンの値はイベントカーソルの署名にも使うため、名前の変更と同時に値を変えると既存カーソルは無効になる。

## 1. アカウントとドメイン

1. CloudflareのWorkers PaidとR2・Queuesを利用できる状態にする。
2. ダッシュボードのEmail Serviceで、購入ドメインの**Email RoutingとEmail Sendingの両方**を有効化する。
3. Cloudflareが提示するMX・SPF・DKIM・DMARCの設定・検証を完了する。SendingはBetaなので、そのアカウントで実際に有効化できることを確認する。
4. APIトークンに、対象アカウントの**Email Sending: Edit**権限を付与する。Worker実行時のトークンはメール送信に限定し、DNS変更・アカウント管理の権限を付けない。

`wrangler.jsonc`の`vars.AGENTPOST_EMAIL_DOMAIN`を購入ドメインに変える。`AGENTPOST_CF_ACCOUNT_ID`はそのドメインとEmail Sendingを所有するアカウントのID。

公式資料: [ドメイン設定](https://developers.cloudflare.com/email-service/configuration/domains/)、[送信](https://developers.cloudflare.com/email-service/get-started/send-emails/)、[REST API](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/)。

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
mise exec -- bun run wrangler d1 migrations apply DB --remote
```

R2は非公開のままにし、`r2.dev`や公開カスタムドメインを有効化しない。メール取得は認証付きWorker APIを通す。

## 3. Secretsとデプロイ

`AGENTPOST_ADMIN_TOKEN`には32〜256文字の英数字・`_`・`-`からなるランダム文字列を使用する。生成例は`openssl rand -hex 32`。ローカル開発用とは別の値を生成する。秘密情報をREADME・チャット・Gitに貼らない。

```sh
mise exec -- bun run wrangler secret put AGENTPOST_ADMIN_TOKEN
mise exec -- bun run wrangler secret put AGENTPOST_CF_ACCOUNT_ID
mise exec -- bun run wrangler secret put AGENTPOST_CF_EMAIL_API_TOKEN
mise run ci
mise exec -- bun run deploy
```

コマンドが返すWorker URLを`AGENTPOST_API_URL`に使う。CIには実メール送信や自動デプロイを含めていない。

## 4. Catch-all

Email Routingの対象ドメインで、catch-allの宛先を**Worker `agentpost`**にする。通常の転送先メールアドレスに向けない。

メールアドレスごとのRouting ruleは不要。WorkerはD1で発行済みかつ有効な宛先のみ受け入れ、その他にはSMTP拒否を返す。アドレスの有効化・無効化はAPIに反映される。

公式資料: [ルーティング設定](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/)。

## 5. 実送受信の確認

外部のテスト用メールアドレスを用意し、次を順に行う。送信はその宛先を明示して実施する。

1. 管理者トークンでランダム受信箱を発行する。
2. 外部メールから発行アドレスに送る。APIで本文・添付・元の`.eml`を取得できることを確認する。
3. 発行アドレスから外部メールに送る。outboxの`accepted`に加え、外部メールの受信・SPF/DKIM/DMARC結果を確認する。
4. 外部からのメールにreply APIで返信する。Reply-To、差出人、件名、スレッドを確認する。
5. 同じIdempotency-Keyで送信APIを再実行し、outbox IDが変わらず、宛先へのメールが増えないことを確認する。
6. 別の受信箱トークンで最初の受信箱を取得できないことを確認する。
7. 受信箱を無効化し、受信拒否とトークン失効を確認する。
8. Workers Logs、Queues/DLQ、Cron Triggerの実行を確認し、次節の監視を設定する。

## 6. 監視と復旧確認

`GET /healthz`はWorkerの生存だけを見る。**`GET /v1/health`を管理者認証付きの外部監視に登録**し、503を通知対象にする。このリポジトリには外部監視サービスへの登録や通知先の設定は含まれていない。

受信・送信の外部テストを定期的に行う場合は、専用の宛先と実行間隔を決めてから設定する。単なるHTTPヘルスチェックではDNS、メール受信、到達性の障害を検出できない。

[運用設計](operations.md)の復旧手順をステージングで実施する。D1のTime TravelとR2の保存原文を使って復旧できることを確認する。バックアップの確認や復旧訓練が済むまでは、安定稼働を検証済みと扱わない。
