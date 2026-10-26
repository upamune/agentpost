# 受信箱のメモと登録先URL

[English](inbox-metadata.md) | [日本語](inbox-metadata.ja.md)

任意の `notes` と `urls` に、アドレスの登録先や用途を記録できます。たとえば、どのショップで使うか、発行した理由、アカウントや請求ページへのリンクを残せます。受信箱の非公開メタデータで、メールのヘッダーや本文には入りません。アドレス、転送、Webhook、認証、送信状態も変更しません。

## 作成と編集

```sh
agentpost inbox create --label shop.example \
  --notes 'Registered for receipts and billing notifications.' \
  --site-url https://shop.example/account \
  --site-url https://shop.example/billing

agentpost inbox edit INBOX_ID --notes 'Subscription cancelled; keep receipts.'
agentpost inbox edit INBOX_ID --notes-file /absolute/path/to/task/registration.md
agentpost inbox edit INBOX_ID --site-url https://shop.example/new-account
agentpost inbox get INBOX_ID

# 省略した項目は維持し、空の値を明示した項目だけ消します。
agentpost inbox edit INBOX_ID --notes ''
agentpost inbox edit INBOX_ID --clear-urls
```

作成時は `local_part` と合わせて、`label`・`notes`・`urls` を任意で指定できます。省略時は順に `""`・`""`・`[]` を保存します。作成・取得・一覧の結果には `notes` とJSON配列の `urls` が含まれます。受信箱の秘密トークンを返すのは管理者トークンによる作成時だけで、メタデータ編集では返しません。

`PATCH /v1/inboxes/{inbox}/metadata` では `label`・`notes`・`urls` のうち1つ以上を指定します。省略した項目は維持し、空文字列でラベルやメモを、`[]` でURL一覧を消します。URLを指定すると一覧全体を置き換えます。異なる項目への同時更新では省略した項目を上書きせず、同じ項目への更新では最後に確定した値を使います。アドレス、所有権、資格情報、有効状態の項目は受け付けません。有効状態は引き続き管理者専用の `PATCH /v1/inboxes/{inbox}` で操作します。

```json
{
  "notes": "領収書の受け取り用。\nこのアカウントの請求連絡先。",
  "urls": ["https://shop.example/account", "https://shop.example/billing"]
}
```

MCPの `create_inbox` でも同じ任意項目を指定できます。`update_inbox` は `inbox_id` と1つ以上のメタデータ項目を受け取り、置き換え・削除の規則も共通です。`get_inbox` と `list_inboxes` にも保存した値が返ります。既存のMCP coreに従う通常のツールで、Eventsの変更や新しい通知の配信はありません。

## 権限と上限

- 管理者はすべての受信箱を作成・編集できます。OAuthのagent権限では、自分の受信箱を発行し、自分の有効な受信箱のメタデータを編集できます。トークン更新後も所有権を維持し、権限の取り消しや受信箱の無効化後は編集できません。管理者は無効な受信箱のメタデータも、有効化せずに編集できます。
- 受信箱トークンでは自分の有効な受信箱のメタデータを参照できますが、編集はできません。メモとURLは、その受信箱の参照権限を持つ利用者に見えます。資格情報や追加の行動を許可する指示ではなく、用途を記録するデータとして扱います。
- ラベルはUTF-16のコード単位で100、メモは10,000まで。改行やUnicodeも使えます。CLIの `--notes-file` は40,000バイト以内の通常のUTF-8ファイルを読み、同じ文字数制限を適用します。`--notes` と `--notes-file` は併用できません。
- URLはHTTP/HTTPSのものを20個まで、各URLはUTF-16のコード単位で2,048まで。ユーザー名・パスワード、空白、制御文字は許可せず、指定した順序を保持します。URLは保存するだけで、自動アクセス、所有権の確認、メール送信は行いません。通信先として使わないため、ローカル・プライベートネットワークのHTTP/HTTPS URLも記録できます。URLやメモには秘密情報を含めないでください。
- CLIでは `--site-url` を繰り返します。APIの接続先を指定する `--url` とは別です。`--site-url` と `--clear-urls` は併用できません。

## 更新手順

Workerの更新前に、`0008_inbox_metadata.sql` を含むすべてのD1マイグレーションを適用します。既存のアドレス、ラベル、トークンハッシュ、所有権、有効状態、メールは維持し、メモは空文字列、URLは空配列で初期化します。新しい引数やツールを使うCLI/MCPクライアントも更新してください。[導入手順](deploy.ja.md)と[インストール手順](../INSTALL.ja.md)を参照してください。ソースの変更やローカルテストの成功だけでは、既存Workerやnpmで入れたクライアントは更新されません。
