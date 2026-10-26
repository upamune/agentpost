# 受信メールのWebhook

[English](webhooks.md) | [日本語](webhooks.ja.md)

受信箱ごとにWebhookを1つ設定し、メールの原文保存と解析が完了したら通知できます。通知はメールIDだけを含み、本文は認証付きAPI・MCPで取得します。MCP Eventsのドラフトとは独立した機能です。既存の受信箱には既定でWebhookを設定しません。

## ホスト側の準備

`0006_inbox_webhooks.sql`を含むD1 migrationを適用し、現在のWrangler設定にある専用キューを作成します。

```sh
mise exec -- bun run wrangler queues create agentpost-webhooks
mise exec -- bun run wrangler queues create agentpost-webhooks-dlq
mise exec -- bun run wrangler d1 migrations apply DB --remote
mise exec -- bun run wrangler secret put AGENTPOST_WEBHOOK_ENCRYPTION_KEY
```

暗号鍵には独立した32バイトの乱数を64文字の16進数で指定します（`openssl rand -hex 32`）。非公開で保管し、D1とは別にバックアップします。`AGENTPOST_WEBHOOK_ALLOWED_ORIGINS`には、例えば`["https://hooks.example.com"]`のように、信頼する完全一致のoriginをJSON配列で指定します。Wranglerの各環境に`AGENTPOST_WEBHOOK_JOBS` producerと専用consumer・DLQを宣言し、設定を確認してデプロイしてください。

鍵やorigin設定がなければWebhookの有効化を拒否します。URLと署名秘密鍵はAES-GCMでまとめて暗号化し、受信箱と設定IDに結び付けます。暗号鍵だけを交換すると既存設定を復号できません。自動的な鍵ローテーションには対応していないため、受信箱ごとの再設定が必要です。

許可するのは運用者または信頼するサービスが管理するドメインに限定し、DNSも信頼する主体が管理してください。URLは公開DNSホスト名、HTTPSの443番、URL資格情報・fragmentなしに限定します。IPアドレス、ローカル・内部向けの名前、リダイレクトは拒否します。origin許可リストは運用者の信頼境界であり、一般的なDNS rebinding対策ではありません。信頼しない相手がDNSを書き換えられるoriginを許可しないでください。パス・queryは許可して暗号化しますが、認証にはURL内の資格情報ではなく署名秘密鍵を使ってください。

## 受信箱への設定

既にその受信箱を操作できる受信箱トークン、所有するOAuth agent、管理者のいずれかを使います。通知先も利用者が許可したURLに限定し、受信メールの内容を新たな通知先への承認と扱いません。

```sh
agentpost webhook set INBOX_UUID --webhook-url https://hooks.example.com/mail
agentpost webhook get INBOX_UUID
agentpost webhook deliveries INBOX_UUID
agentpost webhook delete INBOX_UUID
```

`set`は`whsec_`で始まる`secret`を**一度だけ**返します。応答JSONを非公開に保存し、受信側のsecret managerへ設定します。`get`には秘密鍵を含めません。`set`が成功するたびに設定と署名秘密鍵を交換し、旧設定の未完了通知を取り消します。既存メールは再通知しません。タイムアウト後は`get`で確認してから再設定を判断してください。秘密鍵を紛失した場合は、意図的な再設定と受信側の更新が必要です。既に開始したHTTP要求は取り消せません。

HTTP APIは次のとおりです。

| メソッド | パス                                     | 入力・結果                                                               |
| -------- | ---------------------------------------- | ------------------------------------------------------------------------ |
| GET      | `/v1/inboxes/{inbox}/webhook`            | メタデータ。署名秘密鍵は含まない                                         |
| PUT      | `/v1/inboxes/{inbox}/webhook`            | `{"url":"https://hooks.example.com/mail"}`。メタデータと秘密鍵を一度返す |
| DELETE   | `/v1/inboxes/{inbox}/webhook`            | 無効化し、未完了通知を取り消す                                           |
| GET      | `/v1/inboxes/{inbox}/webhook/deliveries` | `{"deliveries":[...]}`。最新50件の状態                                   |

MCPツールは`get_webhook`、`set_webhook`、`delete_webhook`、`list_webhook_deliveries`です。通知先は`--webhook-url`で指定します。CLIの通常の`--url`はAgentpost APIの接続先を指定するため、Webhook通知先に使わないでください。

## 通知の検証と処理

JSONをPOSTし、[Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md)のHMAC-SHA256ヘッダーで署名します。

- `webhook-id`：再試行でも変わらない通知ID。
- `webhook-timestamp`：その試行時点のUnix秒。
- `webhook-signature`：`v1,BASE64_SIGNATURE`。

```json
{
  "event_id": "message.received:MESSAGE_ID",
  "type": "message.received",
  "timestamp": "2026-10-26T00:00:00.000Z",
  "data": { "inbox_id": "INBOX_UUID", "message_id": "MESSAGE_ID" }
}
```

保管した`whsec_`秘密鍵と、保守されているStandard Webhooks検証ライブラリを使います。JSON解析や処理の前に、**受信したままの要求バイト列**・ヘッダー・時刻を検証してください。署名対象は`webhook-id + "." + webhook-timestamp + "." + raw_body`、HMAC鍵は`whsec_`を取り除いてBase64復号した値です。定数時間で比較し、例えば前後5分など受信側の許容範囲を外れた時刻を拒否します。解析後のJSONを再serializeして検証しないでください。

2xxを返す前に、`webhook-id`を一意にした処理項目を永続化します。署名が正しい重複通知は既存項目として受理し、副作用を二重実行しません。本文は受信箱に限定した資格情報で取得し、署名秘密鍵とは分離します。通知には送信者・件名・本文・添付・Agentpostのアクセストークンを含めません。署名が正しくても、メール本文は信頼しない外部データです。

## 配送と復旧

メールのready遷移と未配送通知の作成はD1で同時に確定します。永続化後にキューへ発行し、Cronで未配送の再発行と中断した処理の回収を行います。遅延と重複があり、配送は**at least once**、通知ごとに最大8回のclaim・試行です。タイムアウトしても受信側で受理済みの場合があるため、再試行でも`webhook-id`を維持します。実メール送信とは異なり、メールの結果不明は引き続き自動再送しません。

- 2xx：`delivered`。受信エンドポイントで受理した状態。
- ネットワーク障害・タイムアウト・HTTP 408/425/429・5xx：30秒からの指数backoff、上限1時間で試行上限まで再試行。
- リダイレクトを含むその他の非2xx：追従せず`failed`。
- 設定の削除・交換、受信箱の無効化：その設定で新たな送信を開始せず、未配送通知を`cancelled`にできる。

HTTP要求のタイムアウトは10秒です。キュー・Cronの遅延も加わるため、backoffは到着期限ではありません。送信前にWorkerが停止すると、8回のclaimでも8回のHTTP要求になるとは限りません。通知は自動削除しません。APIの履歴は最新50件で、終端失敗の自動再通知はありません。受信側、履歴、専用DLQ、Workerログ、認証付きhealthを確認してください。取りこぼしは`message list`と照合し、再生可能な履歴が必要ならMCP EventsかCLIのチェックポイントを使います。D1と独立した暗号鍵をバックアップし、復元も検証してから運用してください。

認証付きhealthの`failed_webhooks`は、現在有効な設定の失敗だけを数えます。受信側を修復して意図的に設定を交換するか、不要な設定を削除すると旧失敗は要確認件数から外れますが、履歴行は保持します。交換・削除は失敗メールの再通知にはならないため、履歴との照合は必要です。
