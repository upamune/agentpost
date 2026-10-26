# HTTP API

[English](http-api.md) | [日本語](http-api.ja.md)

`AGENTPOST_API_URL`にはWorkerのHTTPS URLを指定します。
ローカル開発では`http://localhost:8787`を使えます。
APIは選択した[認証方式](authentication.ja.md)を使います。トークン方式は`Authorization: Bearer <token>`、OAuth方式はAccess経由の検証済みアプリ署名で認証します。`/healthz`とOAuthの保護リソースdiscoveryは公開です。

管理者トークンは受信箱の発行と管理、および全受信箱へのアクセスに使います。
受信箱トークンは、発行された一つの受信箱のメール取得と送受信に使えます。
トークンが有効な方式での再発行や受信箱の無効化は管理者が行います。OAuth agentは自分の受信箱の発行・一覧・有効な受信箱の閲覧・送信・返信ができ、他人の受信箱や管理操作にはアクセスできません。

## エンドポイント

`{inbox}`は受信箱ID、`{message}`は受信メールID、`{send}`はoutbox IDです。

| Method | Path                                                         | 操作                                                      |
| ------ | ------------------------------------------------------------ | --------------------------------------------------------- |
| GET    | `/healthz`                                                   | 生存確認。認証不要                                        |
| POST   | `/v1/inboxes`                                                | ランダムまたは指定名のアドレス発行（管理者・OAuth agent） |
| GET    | `/v1/inboxes?limit=25&offset=0`                              | 受信箱一覧（管理者は全体・OAuth agentは自分の所有分）     |
| GET    | `/v1/inboxes/{inbox}`                                        | 受信箱の詳細                                              |
| PATCH  | `/v1/inboxes/{inbox}`                                        | `{"active":false}`などで有効状態を変更（管理者）          |
| PATCH  | `/v1/inboxes/{inbox}/metadata`                               | ラベル・メモ・URLを編集（管理者 / OAuth所有者）           |
| POST   | `/v1/inboxes/{inbox}/token`                                  | 受信箱トークンの再発行（管理者）                          |
| GET    | `/v1/inboxes/{inbox}/messages?limit=25&cursor=...`           | 受信一覧                                                  |
| GET    | `/v1/inboxes/{inbox}/messages/{message}`                     | 本文と添付情報                                            |
| GET    | `/v1/inboxes/{inbox}/messages/{message}/raw`                 | 元の`.eml`                                                |
| GET    | `/v1/inboxes/{inbox}/messages/{message}/attachments/{index}` | 添付ダウンロード（indexは0始まり）                        |
| POST   | `/v1/inboxes/{inbox}/messages/{message}/reprocess`           | 保存済み原文の再解析                                      |
| POST   | `/v1/inboxes/{inbox}/send`                                   | 送信要求の登録                                            |
| POST   | `/v1/inboxes/{inbox}/messages/{message}/reply`               | Reply-Toとスレッド情報を使った返信                        |
| GET    | `/v1/inboxes/{inbox}/outbox?limit=25&offset=0`               | 送信要求一覧                                              |
| GET    | `/v1/inboxes/{inbox}/outbox/{send}`                          | 送信状態とプロバイダー応答                                |
| POST   | `/v1/inboxes/{inbox}/outbox/{send}/resolve`                  | 確認済みの送信結果を記録（管理者）                        |
| GET    | `/v1/events`                                                 | イベント型の一覧                                          |
| POST   | `/v1/events/poll`                                            | イベントの取得                                            |
| GET    | `/v1/domain/check`                                           | ドメインの送信DNS・Cloudflare設定診断（管理者）           |
| GET    | `/v1/health`                                                 | ストレージ疎通、滞留、要確認件数（管理者）                |

一覧の`limit`は1〜100、既定値は25です。
受信一覧の続きは応答の`next_cursor`、受信箱と送信要求の一覧の続きは`next_offset`を使って取得します。
イベントの入力とカーソルの仕様は[MCPとEventsの対応範囲](mcp-events.ja.md)を参照してください。

## 受信箱を発行する

```sh
curl "$AGENTPOST_API_URL/v1/inboxes" \
  -H "Authorization: Bearer $AGENTPOST_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"label":"research-agent"}'
```

応答の`id`と`address`、含まれる場合は秘密の`token`を非公開に保存してください。OAuthでの発行はbothでもトークンを返さず、OAuth専用では再発行も無効です。受信箱へのアクセスはOAuthの権限で行います。
発行要求の応答を受け取れなかった場合は、再発行前に管理者の一覧APIで確認します。
トークンを紛失した場合は再発行できますが、旧トークンは失効します。

### 受信箱の名前

自動発行は独自に選定した512語から暗号学的乱数で独立に3回選びます（134,217,728通り、27ビット）。同じ語が繰り返される場合もあります。名前は公開の識別子であり、資格情報や匿名性の保証ではありません。D1の原子的なINSERTで確保し、自動生成の重複は最大8回試してから503を返します。明示した名前の競合は再試行せず409です。無効化済みアドレスは予約されたままで、従来のUUID形式のアドレスも移行なしで使えます。

`local_part`を省略すると、`cedar-moon-river@example.com`のようにランダムな英単語3つをハイフンで結んで発行します。名前を選ぶ場合は`@`より前の部分を渡します。

```json
{ "local_part": "research.team+1", "label": "research-agent" }
```

設定済みのドメインに`research.team+1@example.com`のようなアドレスを作ります。名前は1〜64文字で、ASCIIの英数字、`_`、`+`、`-`、途中の単独の`.`を使えます。先頭・末尾のドット、連続ドット、空白、日本語などのUnicode、完全なメールアドレスは400で拒否します。全体は254文字以内で、大文字は小文字に統一します。ドットや`+`以降も名前の一部で、別名として省略・統合しません。

発行には管理者またはOAuth `agent`権限が必要です。OAuthでの新規発行には発行元と本人に紐付く所有者を記録します。D1の原子的なINSERTで名前を確保し、明示した名前の同名要求・同時発行・無効化済みの名前は409で拒否します。既存の受信箱やトークンを変更・返却せず、発行による名前の再割り当ても行いません。既存の受信箱を確認・管理し、競合をトークン再発行の承認とは解釈しないでください。従来のランダム受信箱にmigrationは不要です。

CLIでは`inbox create --local-part research.team+1`、MCPでは`create_inbox`の`local_part`に指定します。どちらも省略時はランダム発行です。

## 受信箱のメタデータ

作成時は `label`・`local_part` と合わせて、任意の `notes`（自由記述）と `urls`（HTTP/HTTPS URLの配列）を指定できます。作成・取得・一覧の結果に含み、省略時は順に `""` と `[]` になります。`PATCH /v1/inboxes/{inbox}/metadata` はラベル・メモ・URLの1項目以上を更新します。省略項目は維持し、空の値で消し、URLを指定すると一覧全体を置き換えます。編集は管理者またはOAuth所有者に限定し、受信箱トークンでは参照だけ可能です。URLへの自動アクセスは行いません。[使用例・上限・必須のD1マイグレーション](inbox-metadata.ja.md)を確認してください。

## 送信と返信

`Idempotency-Key`は任意です。省略するとAPIがUUIDv4を生成し、応答の`Idempotency-Key`ヘッダーと成功時のoutbox JSONの`idempotency_key`で返します。明示するキーはASCII英数字・`_.:-`の1〜128文字で、空・不正値は400です。同じ受信箱で同じメールを再要求する場合は保存したキーと内容を維持し、別の内容に同じキーを使うと409になります。

CLI・MCPは準備・ネットワーク要求の**前**に採番し、成功結果と送信エラーでキーを通知します（MCPは`structuredContent.idempotency_key`も返します）。タスク状態に保存してください。キー省略の再呼び出しは別送信になり、クライアントの自動再試行はありません。HTTPを直接使い、応答紛失後にも復旧したい場合は、呼び出し側で送信前にキーを生成・保存してください。サーバーで生成したキーは応答自体を紛失すると呼び出し側へ届きません。キーが不明なら、次の操作を決める前にoutbox履歴を調べてください。

```sh
curl "$AGENTPOST_API_URL/v1/inboxes/INBOX_ID/send" \
  -H "Authorization: Bearer $AGENTPOST_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: task-123-message-1' \
  -d '{"to":["recipient@example.net"],"subject":"Hello","text":"Hello from my agent"}'
```

`to`は1〜50件の宛先配列です。
送信本文は`text`が必須で、`html`を追加できます。
差出人は受信箱のアドレスを使うため、`from`は指定できません。
返信では`text`と任意の`html`を指定し、宛先と件名とスレッド情報は元のメールから設定します。

`202`は送信要求を永続化した状態です。
応答の`id`でoutboxの状態を確認してください。
`accepted`はCloudflareでの受理であり、宛先への配達完了ではありません。
`unknown`は管理者による確認が必要で、新しいキーによる自動再送は行いません。
結果の確認と記録は[運用設計](operations.ja.md)に従ってください。

受信箱の無効化は、同じ受信箱で先行する送信処理が終わり、無効化を保存してから成功を返します。タイムアウトは停止完了を意味しません。状態を確認してから後続の操作へ進んでください。

CLI・stdio MCPの成功JSON応答は64 MiBまでです。大きなoutbox一覧ではlimitを下げて取得してください。無効化後の新しい受信は拒否しますが、既に受け入れた原文の保存は後から完了できます。

## ドメイン診断

`GET /v1/domain/check` は設定済みのドメインに固定した読み取り専用の診断です。レポートを生成できれば検査がfailでもHTTP 200を返すため、JSONの `status` と `checks` を確認してください。管理者トークンまたはOAuth `admin` が必要です。送信やDNS変更は行いません。[検査範囲・終了コード・制限](domain-diagnostics.ja.md)を参照してください。

## 添付アップロード

`POST /v1/inboxes/{inbox}/attachments` は `application/octet-stream` とパーセントエンコードした `Agentpost-Filename` を受け取り、非公開の添付IDを返します。送信・返信は任意の `attachments` ID配列を受け付けます。バイナリはJSON本体に含めません。[上限・冪等性・危険ファイルの扱い](outbound-attachments.ja.md)を参照してください。

## 受信Webhook

受信箱ごとの`GET`・`PUT`・`DELETE /v1/inboxes/{inbox}/webhook`で設定し、`GET /v1/inboxes/{inbox}/webhook/deliveries`で最新50件を確認します。`PUT`の入力は`{"url":"https://hooks.example.com/mail"}`です。署名秘密鍵は設定時に一度だけ返します。[ホスト側の許可リスト・署名検証・配送契約](webhooks.ja.md)を確認してください。

## 受信メールの転送

管理者専用の全体設定、受信箱ごとの継承・個別・off設定、履歴、調査記録は[転送API](forwarding.ja.md#http-apiとmcp)を参照してください。通常の認証・JSON Content-Type・サイズ・Origin・レート制限も適用します。
