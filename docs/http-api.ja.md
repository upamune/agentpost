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

`local_part`を省略するとランダムに発行します。名前を選ぶ場合は`@`より前の部分を渡します。

```json
{ "local_part": "research.team+1", "label": "research-agent" }
```

設定済みのドメインに`research.team+1@example.com`のようなアドレスを作ります。名前は1〜64文字で、ASCIIの英数字、`_`、`+`、`-`、途中の単独の`.`を使えます。先頭・末尾のドット、連続ドット、空白、日本語などのUnicode、完全なメールアドレスは400で拒否します。全体は254文字以内で、大文字は小文字に統一します。ドットや`+`以降も名前の一部で、別名として省略・統合しません。

発行には管理者またはOAuth `agent`権限が必要です。OAuthでの新規発行には発行元と本人に紐付く所有者を記録します。D1の原子的なINSERTで名前を確保し、同名の要求・同時発行・無効化済みの名前は409で拒否します。既存の受信箱やトークンを変更・返却せず、発行による名前の再割り当ても行いません。既存の受信箱を確認・管理し、競合をトークン再発行の承認とは解釈しないでください。従来のランダム受信箱にmigrationは不要です。

CLIでは`inbox create --local-part research.team+1`、MCPでは`create_inbox`の`local_part`に指定します。どちらも省略時はランダム発行です。

## 送信と返信

送信と返信には`Idempotency-Key`ヘッダーが必須です。
同じ受信箱で同じメールの要求を再試行する場合は、同じキーを使います。
別の内容に同じキーを使うと409を返します。

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
