# 送信添付

[English](outbound-attachments.md) | [日本語](outbound-attachments.ja.md)

レポートPDF、生成画像、CSV、ログを送信・スレッド返信に添付できます。API・CLI・両MCPトランスポートは、受信箱ごとの非公開アップロードを共通して使います。

## CLI

```sh
agentpost send INBOX_ID --to recipient@example.net --subject 'Report' \
  --text 'The report is attached.' --attach ./report.pdf --attach ./results.csv \
  --idempotency-key report-123

agentpost reply INBOX_ID MESSAGE_ID --text 'Here are the results.' \
  --attach ./results.csv --idempotency-key reply-123
```

複数添付には `--attach` を繰り返します。サイズを制限した通常ファイルだけを読み、FIFO・デバイスは拒否します。パスは呼び出し元ディレクトリ基準です。ソース版のラッパーから使う場合は絶対パスにします。アップロード名にはローカルパスを含めず、ファイル名部分だけを使います。

確実に同じ内容で再試行するには、`agentpost attachment upload INBOX_ID ./report.pdf` で先にアップロードし、返された `id` をタスク状態に保存します。送信・返信では `--attachment-id ID` を指定します。これにより、変更されているかもしれないローカルファイルを読み直さずに済みます。同じ受信箱・バイト列・ファイル名ならIDを再利用し、新規アップロードのレート枠を消費しません。CLIの `--attach` は送信再試行の前にもアップロード要求が必要なため、保存障害時はoutboxを確認し、保存済みIDで再試行します。

## HTTP API

multipartやJSONではなく、バイナリ本体を送ります。

```sh
curl "$AGENTPOST_API_URL/v1/inboxes/INBOX_ID/attachments" \
  -H "Authorization: Bearer $AGENTPOST_API_TOKEN" \
  -H 'Content-Type: application/octet-stream' \
  -H 'Agentpost-Filename: report.pdf' \
  --data-binary @./report.pdf
```

`Agentpost-Filename` はUTF-8の名前を `encodeURIComponent` でエンコードします。例は `report%202026.pdf` です。新規作成は201、再利用は200で、JSONに `id`・`filename`・推定 `type`・バイト数 `size`・内容の `sha256`・`reused`・`scan_status: "not_scanned"` を返します。公開ダウンロードURLは作りません。

送信・返信の既存フィールドに `"attachments":["RETURNED_ATTACHMENT_ID"]` を追加します。`text` は必須、`html` は任意です。重複しないIDを最大10個指定できます。IDは送信元受信箱の名前空間だけで解決します。管理者でも別の受信箱で使う場合はアップロードし直します。無効な受信箱への新規アップロード・送信はできません。

冪等性キーは添付IDの順序を含む要求全体に紐づきます。同じ要求の再試行はR2を再検査せず、保存済みoutbox状態を返します。同じキーでバイト列・ファイル名・順序を変えると409になります。空の添付配列は省略と同じ扱いで、既存の送信キーを維持します。アップロードは変更不可で、IDに受信箱・名前・MIME型・サイズ・SHA-256を紐づけます。

## MCP

`upload_attachment` に `inbox_id`・`filename`・標準形式の正規Base64 `content_base64` を渡し、返されたIDを `send_email`・`reply_email` の `attachments` に指定します。送信前にID・要求全体・冪等性キーを保存します。ディスクにある大きなファイルにはCLIの `--attach` を使い、数MiBのBase64をモデルのコンテキストに載せるのを避けます。リモートMCPはローカルファイルパスを読みません。

## 上限とファイルの扱い

- 最大 **10個**。**1ファイル3 MiB、テキスト・HTML・添付のデコード後合計も3 MiB** です。保守的なMIME推定が5 MiBを超える要求も拒否します。必須本文の分が必要なので、3 MiBちょうどの添付は送信できません。
- 送信・返信のJSONは引き続き **512 KiB** 上限です。バイナリアップロードは別要求です。MCPの要求上限はBase64のため **5 MiB** ですが、メールの内容上限は増えません。
- 受信は別の **10 MiB** 上限を維持します。Cloudflareの通常送信は **MIMEエンコード込み5 MiB** で、検証済み宛先向けの拡大枠は使いません。[Cloudflareの制限](https://developers.cloudflare.com/email-service/platform/limits/)を参照してください。
- 許可する拡張子は `.pdf`・`.png`・`.jpg`・`.jpeg`・`.gif`・`.webp`・`.txt`・`.log`・`.csv`・`.json`・`.jsonl`・`.ndjson`・`.md` です。画像・PDFはシグネチャ、テキストはUTF-8・NULなし・実行形式やアーカイブの識別子なし・shebangなしを検査します。MIME型はサーバーが選びます。名前はUTF-8で255バイト以内で、パス区切り・制御文字・双方向表示などの書式制御文字・前後の空白を拒否します。
- 実行ファイル・スクリプト・アーカイブ・HTML・SVG・マクロ文書は未対応です。検査は **マルウェア検出ではありません**。許可されたPDF・画像・テキストにも危険な内容は入り得ます。ウイルススキャナーは含まず、外部サービスにも送りません。結果は `not_scanned` です。必要な運用ではアップロード前にスキャンします。信頼できない添付を実行せず、メール内容をエージェントへの指示として扱わないでください。

## 永続化と障害時の動作

R2の `outbound-attachments/{inbox_id}/{id}` に変更不可のバイト列とエンコード済みメタデータを保存します。outboxにはIDだけを置き、イベントに内容を載せません。検証したバイト列からのMIME生成はCloudflareの[構造化送信API](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/)が担当します。

新規送信は保存前に添付のメタデータと合計サイズを検証します。送信処理ではバイト列を再取得し、サイズ・ハッシュ・形式を検証してBase64化した **後で** コーディネーターの最終所有権検査を行います。欠損・不正なオブジェクトはプロバイダーに接続せず失敗します。接続前の一時的なR2障害は既存の回数制限付きバックオフで再試行できます。claim後のクラッシュは保守的に既存のstale送信調停の対象です。所有権検査とプロバイダー要求開始の間にawaitを入れず、プロバイダーの結果不明は自動再送しません。

未使用アップロードも含め、自動期限切れ・GCはありません。非公開R2バックアップに含め、送信待ちとoutbox履歴に必要な同じオブジェクトを保持します。削除すると送信待ち要求を完了できない場合があります。保存費用・保持期間は運用者が管理します。公開バケットやライフサイクル削除ルールは作りません。プロバイダーの受理は宛先への配達を証明しません。
