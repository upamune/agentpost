# HTTP API

`AGENTPOST_API_URL`にはWorkerのHTTPS URLを指定します。
ローカル開発では`http://localhost:8787`を使えます。
`/healthz`以外のAPIには`Authorization: Bearer <token>`が必要です。

管理者トークンは受信箱の発行と管理、および全受信箱へのアクセスに使います。
受信箱トークンは、発行された一つの受信箱のメール取得と送受信に使えます。
トークンの再発行や受信箱の無効化は管理者が行います。

## エンドポイント

`{inbox}`は受信箱ID、`{message}`は受信メールID、`{send}`はoutbox IDです。

| Method | Path                                                         | 操作                                             |
| ------ | ------------------------------------------------------------ | ------------------------------------------------ |
| GET    | `/healthz`                                                   | 生存確認。認証不要                               |
| POST   | `/v1/inboxes`                                                | ランダムアドレス発行（管理者）                   |
| GET    | `/v1/inboxes?limit=25&offset=0`                              | 受信箱一覧（管理者）                             |
| GET    | `/v1/inboxes/{inbox}`                                        | 受信箱の詳細                                     |
| PATCH  | `/v1/inboxes/{inbox}`                                        | `{"active":false}`などで有効状態を変更（管理者） |
| POST   | `/v1/inboxes/{inbox}/token`                                  | 受信箱トークンの再発行（管理者）                 |
| GET    | `/v1/inboxes/{inbox}/messages?limit=25&cursor=...`           | 受信一覧                                         |
| GET    | `/v1/inboxes/{inbox}/messages/{message}`                     | 本文と添付情報                                   |
| GET    | `/v1/inboxes/{inbox}/messages/{message}/raw`                 | 元の`.eml`                                       |
| GET    | `/v1/inboxes/{inbox}/messages/{message}/attachments/{index}` | 添付ダウンロード（indexは0始まり）               |
| POST   | `/v1/inboxes/{inbox}/messages/{message}/reprocess`           | 保存済み原文の再解析                             |
| POST   | `/v1/inboxes/{inbox}/send`                                   | 送信要求の登録                                   |
| POST   | `/v1/inboxes/{inbox}/messages/{message}/reply`               | Reply-Toとスレッド情報を使った返信               |
| GET    | `/v1/inboxes/{inbox}/outbox?limit=25&offset=0`               | 送信要求一覧                                     |
| GET    | `/v1/inboxes/{inbox}/outbox/{send}`                          | 送信状態とプロバイダー応答                       |
| POST   | `/v1/inboxes/{inbox}/outbox/{send}/resolve`                  | 確認済みの送信結果を記録（管理者）               |
| GET    | `/v1/events`                                                 | イベント型の一覧                                 |
| POST   | `/v1/events/poll`                                            | イベントの取得                                   |
| GET    | `/v1/health`                                                 | ストレージ疎通、滞留、要確認件数（管理者）       |

一覧の`limit`は1〜100、既定値は25です。
受信一覧の続きは応答の`next_cursor`、受信箱と送信要求の一覧の続きは`next_offset`を使って取得します。
イベントの入力とカーソルの仕様は[MCPとEventsの対応範囲](mcp-events.md)を参照してください。

## 受信箱を発行する

```sh
curl "$AGENTPOST_API_URL/v1/inboxes" \
  -H "Authorization: Bearer $AGENTPOST_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"label":"research-agent"}'
```

応答の`id`、`address`、`token`を保存してください。
発行要求の応答を受け取れなかった場合は、再発行前に管理者の一覧APIで確認します。
トークンを紛失した場合は再発行できますが、旧トークンは失効します。

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
結果の確認と記録は[運用設計](operations.md)に従ってください。

受信箱の無効化は、同じ受信箱で先行する送信処理が終わり、無効化を保存してから成功を返します。タイムアウトは停止完了を意味しません。状態を確認してから後続の操作へ進んでください。
