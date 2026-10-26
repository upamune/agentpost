# 受信メールの転送

[English](forwarding.md) | [日本語](forwarding.ja.md)

登録先ごとのメールをAgentpostの受信箱に保存しながら、いつもの受信箱へ転送できます。全体の既定値と、受信箱ごとの継承・別宛先・転送なしを設定します。新規環境では転送は無効です。

| 受信箱のモード    | 転送先                                       |
| ----------------- | -------------------------------------------- |
| `inherit`（既定） | 全体の転送先を使用。全体が無効なら転送しない |
| `custom`          | 全体の設定に関係なく、この受信箱の宛先を使用 |
| `off`             | 全体に転送先があっても転送しない             |

設定・宛先の取得・転送履歴・調査済みの記録はすべて管理者専用です。受信箱トークンとOAuthの`agent`権限では操作できず、運用者の個人アドレスも取得できません。メール本文を転送設定変更の承認として扱いません。

## 運用者の設定

1. Worker更新前に`0007_forwarding.sql`を適用します。
2. [Cloudflare Email Routingの転送先アドレス](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/)に宛先を追加し、確認メールで検証します。実際の`message.forward()`でCloudflareが検証済みかを確認します。
3. Worker Secretの`AGENTPOST_FORWARD_ALLOWED_DESTINATIONS`に、`["operator@example.net","team@example.org"]`のようなJSON配列を保存します。`mise exec -- bun run wrangler secret put AGENTPOST_FORWARD_ALLOWED_DESTINATIONS`を実行し、ターミナルで非公開に入力します。ローカルではGit管理外の`.dev.vars`に設定できます。未設定なら宛先を許可しません。個人アドレスを追跡対象のWrangler設定やGitに保存しないでください。
4. 管理者のクライアントから設定します。

```sh
# INBOX_IDを省略すると全体の設定。
agentpost forwarding set --destination operator@example.net
agentpost forwarding get

# 受信箱ごとの別宛先、転送なし、継承への復帰。
agentpost forwarding set INBOX_ID --destination team@example.org
agentpost forwarding off INBOX_ID
agentpost forwarding inherit INBOX_ID
agentpost forwarding get INBOX_ID

# 全体の既定値だけ停止。customの受信箱には影響しません。
agentpost forwarding off
```

運用者の許可リストと完全に一致する宛先だけを使用します。`@`の前の大文字・小文字は維持し、ドメインは小文字に統一します。直接の転送ループを防ぐため、受信ドメインとそのサブドメインには転送できません。許可リストが不正な場合も転送しません。リストから削除した宛先は、保存済みの設定に残っていても新しい転送を拒否します。設定操作自体はメールや確認メールを送りません。

受信中のSMTPハンドラで[Email Routing標準の`message.forward()`](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/)を使います。Email Sending BetaのREST APIや、追加の送信用binding・トークンは使いません。キャッチオールはWorkerを向いたままにし、受信箱への保存・イベント・Webhookを維持してください。直接転送するルールには置き換えません。

## 保存・重複・設定変更

最初にR2へMIME原文を保存します。条件付きPUTにより、同時受信のうち先に保存した転送判断を固定します。D1の索引とともに転送判断を記録し、受信箱が有効な間に原子的な`pending`→`sending`を取得してから転送します。同じ原文の同時・重複受信はこの記録を共有します。識別は既存の受信箱ID＋原文ハッシュです。MIMEが異なるメールを意味的に重複排除するものではありません。

全体・個別設定の変更は**以後に受け付けるメール**に適用します。保存済みメールを再転送したり、受信済みの転送先を変更したり、開始済みの転送を取り消したりはしません。受信箱の無効化は新規受信と新しい転送claimを止めますが、それ以前にclaim済みの転送は後で完了する場合があります。送信開始済みのコピーは無効化・offでも取り消せません。受信箱を再度有効にしても、以前のskippedメールを再転送しません。

原文保存や索引作成が失敗した場合は転送しません。保存後の転送失敗では原文を失わず、解析・イベント・Webhookも継続できます。R2からの索引修復で転送判断は復元できますが、SMTPセッションは復元できません。転送メタデータのない旧形式の原文も遡って転送しません。

## 状態と復旧

```sh
agentpost forwarding deliveries INBOX_ID
agentpost health
```

| 状態       | 意味                                                                  |
| ---------- | --------------------------------------------------------------------- |
| `pending`  | 転送判断を保存済み、未claim。生存中のSMTPハンドラだけが実行可能       |
| `sending`  | 一度だけclaim済み。転送開始済みの可能性あり                           |
| `accepted` | 標準転送の呼び出し成功。相手への配信完了ではない                      |
| `unknown`  | 標準転送の例外、claim後の中断、復旧後の遅延完了。受理済みの可能性あり |
| `blocked`  | 宛先・ループ・無効受信箱の制約、またはclaim前にSMTPセッションが終了   |
| `skipped`  | その原文の受信時点で転送なし                                          |

claim済み・結果不明の転送は**自動再試行しません**。標準転送は元のSMTPハンドラでしか利用できず、Cron・キューから`.eml`を再構成して実行できません。2分を過ぎた`sending`はunknown、未claimのpendingはblockedにします。通常の送信機能で元の送信者を偽装して代用しないでください。Cloudflareのアクティビティと保存済み原文を確認し、運用者が復旧します。

認証付きヘルスチェックに`blocked_forwarding`・`unknown_forwarding`・`oldest_forwarding`を表示します。未調査のblocked/unknownと、滞留したpending/sendingは503の対象です。調査後は根拠を記録して通知対象を解除できます。

```sh
agentpost forwarding resolve INBOX_ID MESSAGE_ID --note 'Provider activity checked; recovery recorded privately'
```

`resolved_at`と記録を保存し、ヘルスチェックの注意件数を解除します。元の結果は変更せず、送信や再試行も行いません。D1の転送判断・試行記録とR2原文を一緒にバックアップしてください。原文だけでは転送開始済みか復元できません。D1の巻き戻しは重複抑止の保証外です。復元前に受信を止め、結果を照合します。

## HTTP APIとMCP

管理者用エンドポイントです。

- `GET /v1/forwarding`と`PUT /v1/forwarding`。設定は`{"destination":"operator@example.net"}`、無効化は`{"destination":null}`。
- `GET /v1/inboxes/{inbox}/forwarding`と`PUT`。`{"mode":"inherit"}`、`{"mode":"off"}`、`{"mode":"custom","destination":"team@example.org"}`。GETには`effective_destination`を含みます。Cloudflareでの検証は別途必要です。
- `GET /v1/inboxes/{inbox}/forwarding/deliveries`で最新50件の状態を取得します。
- `POST /v1/inboxes/{inbox}/forwarding/deliveries/{message}/resolve`に`{"note":"Operator evidence"}`を送り、未調査のblocked/unknownに調査記録を残します。

MCPは`get_global_forwarding`・`set_global_forwarding`・`get_inbox_forwarding`・`set_inbox_forwarding`・`list_forwarding_deliveries`・`resolve_forwarding`です。`set_inbox_forwarding`は`inbox_id`と、同じモードのオブジェクトを含む`configuration`を受け取ります。他のAPIと受信箱の所有権は維持します。

## プライバシーと実環境の確認

原文の本文と添付を転送し、追跡ピクセル除去や無害化は行いません。Cloudflare・送信先による経路ヘッダーの変更、厳しいDMARC方針、受信側のフィルタリングで配信が左右されます。`X-Agentpost-Forwarded`は単純なループを抑止する印であり、認証情報ではありません。外部の転送ルールで循環させたり、ループ用ヘッダーを除去したりしないでください。

エイリアスから返信するにはAgentpostを使ってください。転送先の個人メールから直接返信すると、個人アドレスが相手に見える場合があります。この機能は個人の受信箱からの返信用reverse aliasを実装しません。ドメインや本文からの関連付けも残ります。

ローカルテストは標準転送の呼び出しだけを差し替えます。実際の転送先検証、SMTP受理、認証・ヘッダー、受信先への配信は未確認です。有効化前に許可された送信元・宛先で試し、原文と転送後のMIME、全体・個別・off設定、受信箱への保存と転送先への配信を別々に確認してください。
