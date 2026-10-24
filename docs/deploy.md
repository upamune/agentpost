# ドメイン取得後の導入

Cloudflareで購入したドメインを使う。ローカル検証と本番稼働は別で、最後の実送受信が通るまでは運用開始しない。

## 1. アカウントとドメイン

1. CloudflareのWorkers PaidとR2・Queuesを利用できる状態にする。
2. ダッシュボードのEmail Serviceで、購入ドメインの**Email RoutingとEmail Sendingの両方**を有効化する。
3. Cloudflareが提示するMX・SPF・DKIM・DMARCの設定・検証を完了する。SendingはBetaなので、そのアカウントで実際に有効化できることを確認する。
4. APIトークンに、対象アカウントの**Email Sending: Edit**権限を付与する。Worker実行時のトークンはメール送信に限定し、DNS変更・アカウント管理の権限を付けない。

`wrangler.jsonc`の`vars.EMAIL_DOMAIN`を購入ドメインに変える。`CF_ACCOUNT_ID`はそのドメインとEmail Sendingを所有するアカウントのID。

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

`ADMIN_TOKEN`には32〜256文字の英数字・`_`・`-`からなるランダム文字列を使用する。生成例は`openssl rand -hex 32`。ローカル開発用とは別の値を生成する。秘密情報をREADME・チャット・Gitに貼らない。

```sh
mise exec -- bun run wrangler secret put ADMIN_TOKEN
mise exec -- bun run wrangler secret put CF_ACCOUNT_ID
mise exec -- bun run wrangler secret put CF_EMAIL_API_TOKEN
mise run ci
mise exec -- bun run deploy
```

コマンドが返すWorker URLを`MAIL_API_URL`に使う。CIには実メール送信や自動デプロイを含めていない。

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
