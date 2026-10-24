# 認証と認可

[English](authentication.md) | [日本語](authentication.ja.md)

agentpostはCloudflare Access Managed OAuthによるリモートMCP接続、事前設定のBearerトークン、または両方を選べます。認証で本人を確かめ、アプリのロールと受信箱の所有者で操作権限を決めます。

## 方式を選ぶ

Workerのvarsで`AGENTPOST_AUTH_MODE`を設定します。

| 方式            | 受け付ける資格情報                   | 必要な設定                                                      |
| --------------- | ------------------------------------ | --------------------------------------------------------------- |
| `token`（既定） | 従来の管理者・受信箱Bearerトークン   | `AGENTPOST_ADMIN_TOKEN`。専用カーソル鍵は任意                   |
| `oauth`         | 検証済みのAccessアプリケーション署名 | 下記Access設定と`AGENTPOST_CURSOR_KEY`。管理者APIトークンは不要 |
| `both`          | どちらも利用可能                     | 両方式の設定                                                    |

不明な方式や有効な方式の設定不足は503で拒否します。明示されたAccess署名が不正でも、Bearerトークンへフォールバックしません。token専用ではAccessヘッダーを本人確認に使いません。HTTPS、レート制限、Origin検査は各方式で共通です。

## Cloudflareを設定する

認可サーバーはCloudflare、保護するリソースサーバーはagentpostです。ログイン画面、認可コード発行、refresh token保存、独自のOAuth認可サーバーは実装しません。

1. Workerをデプロイし、`0005_oauth_ownership.sql`を含むD1 migrationsを適用します。
2. 同じCloudflare・Zero Trustアカウントで正規ホスト名のAccessアプリを設定します。許可する利用者をポリシーで限定し、IdP側のMFA要件も設定します。
3. **Managed OAuth**を有効にします。MCPクライアントが必要とするredirect URIだけを許可し、デスクトップで必要な場合だけloopbackを許可します。アクセストークンは短命にし（Cloudflareは5〜15分を推奨）、用途に応じてgrant/sessionの期間を決めます。
4. `https://YOUR_HOST/.well-known/oauth-authorization-server`にある認可サーバーメタデータの`issuer`を正確に取得します。Access JWTの発行元とは異なる場合があり、team domainで代用しません。
5. 下記のvarsを設定し、`mise exec -- bun run wrangler secret put AGENTPOST_CURSOR_KEY`で独立したカーソル鍵を登録します。値は`openssl rand -hex 32`などで生成し、Gitやチャットには出しません。

varsの例です。IDとURLはすべて置き換えます。

```json
{
  "AGENTPOST_AUTH_MODE": "oauth",
  "AGENTPOST_ACCESS_TEAM_DOMAIN": "https://YOUR_TEAM.cloudflareaccess.com",
  "AGENTPOST_ACCESS_AUD": "YOUR_64_CHARACTER_APPLICATION_AUD_TAG",
  "AGENTPOST_OAUTH_RESOURCE_URL": "https://mail.example.com/mcp",
  "AGENTPOST_OAUTH_AUTHORIZATION_SERVER": "https://EXACT_ISSUER_FROM_ACCESS_METADATA",
  "AGENTPOST_ACCESS_PRINCIPALS": "{\"user:YOUR_OPERATOR_SUB\":\"admin\",\"user:YOUR_AGENT_USER_SUB\":\"agent\"}"
}
```

| 設定                                   | 意味                                                                               |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| `AGENTPOST_ACCESS_TEAM_DOMAIN`         | 信頼する`*.cloudflareaccess.com`のHTTPS origin。JWTの発行元とJWKSの取得先          |
| `AGENTPOST_ACCESS_AUD`                 | 対象アプリのAUD。小文字の16進数64文字                                              |
| `AGENTPOST_OAUTH_RESOURCE_URL`         | `/mcp`で終わる正規のHTTPS URL。ユーザー情報・クエリ・fragmentは禁止                |
| `AGENTPOST_OAUTH_AUTHORIZATION_SERVER` | AccessメタデータのOAuth AS issuer。パスや末尾のスラッシュも正確に保持              |
| `AGENTPOST_ACCESS_PRINCIPALS`          | 本人IDとロールの対応をJSONで指定。未登録の本人には権限を与えない                   |
| `AGENTPOST_CURSOR_KEY`                 | 32〜256文字のランダムな英数字・`_`・`-`。OAuth/bothでは必須の独立したWorker Secret |

信頼できるAccessセッションのアプリケーションIDから`user:<sub>`を取得します。Service TokenはClient IDに相当する`service:<common_name>`です。識別子はCloudflareの信頼できるセッション・本人情報から非公開で確認します。ロールは`admin`と`agent`です。メールアドレスのヘッダーから管理者を自動登録しません。Accessを通れてもこの一覧に存在しない本人は403です。Service AuthポリシーとService TokenヘッダーはAccess側で設定し、agentpost管理者トークンとして保存しません。

公式資料: [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)、[アプリケーションJWT](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)、[JWT検証](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)。

## MCPクライアントを接続する

MCP OAuthに対応するクライアントへ`https://YOUR_HOST/mcp`をリモートStreamable HTTPサーバーとして登録します。discovery、ブラウザ認可、PKCEを使うコード交換、refresh tokenの安全な保存はクライアントが行います。クライアントの事前登録か、Accessが対応する登録フローが必要です。OAuth接続へ管理者トークンを貼り付けません。

Workerは`/.well-known/oauth-protected-resource/mcp`とrootの別名でRFC 9728メタデータを返し、401の`WWW-Authenticate`で正規URLを案内します。AS自身のメタデータとエンドポイントはCloudflareが処理します。公開のリソースメタデータはGET/HEAD/OPTIONSとCORSに対応します。認証付きAPI/MCPのブラウザ要求には従来の同一origin制限を維持するため、別originのアプリはネイティブまたはバックエンドのMCPクライアントを使います。

Managed OAuthのアクセストークンはopaqueです。Cloudflareが本人情報に解決して`Cf-Access-Jwt-Assertion`を渡します。WorkerはRS256署名、設定済みJWKS、発行元、対象アプリ、必須claim、有効期限・開始時刻、`type: app`を検証します。メールアドレスやroleヘッダーを本人確認として信頼しません。JWKSは設定したteamのエンドポイントだけから取得し、redirectを拒否し、タイムアウトとサイズ制限を設けます。検証基盤の障害は503、不正な資格情報は401です。

CLIとstdio MCPは従来の環境変数によるトークン方式を使います。この変更はリモートHTTP MCPへのOAuth追加であり、CLIのブラウザログイン・refresh token管理は追加しません。無人実行はtoken/bothで受信箱トークンを使うか、Access Service Authと明示的なサービスIDの権限を設定します。MCPの標準OAuthはHTTP向けで、stdioには適用しません。

## 操作権限

| 本人・資格情報                | 許可する操作                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 管理者トークン・OAuth `admin` | 全受信箱、発行、トークンが有効な場合の管理、無効化・有効化、health、結果照合                                 |
| 受信箱トークン                | その有効な受信箱の閲覧・送信・返信・イベント。新規発行・全体一覧・管理は不可                                 |
| OAuth `agent`                 | 自分が所有する受信箱の発行・一覧・有効な受信箱の閲覧・送信・返信。イベントには所有する`inbox_id`の明示が必要 |

OAuth agentは無効化・有効化、トークン再発行、health、結果照合を行えません。新規発行時に発行元と本人に紐付く安定した所有者ハッシュをD1へ保存します。JWTが更新されても所有者とイベントカーソルの範囲は維持します。本人のロール変更では古いカーソルを拒否します。MCPツールと内部のイベントpollも同じAPI認可を通ります。SMTP受信、Queues、CronはHTTP OAuthクライアントではありません。

OAuthでの発行はbothでも受信箱トークンを返さず、agentが自分の権限より長く使える静的トークンを発行できないようにします。トークン認証での発行は従来の応答を維持します。OAuth専用では再発行も拒否します。bothでは管理者が明示的に再発行して操作を委任できます。この委任トークンはOAuth権限の失効とは独立し、再発行か受信箱の無効化まで有効です。既存のランダム・指定名の受信箱は`owner_id = NULL`を維持し、トークンが有効ならそのトークンと、管理者からアクセスできます。後からログインした利用者へ自動的に割り当てません。

所有者はAccessの本人単位であり、MCPクライアントやタスク単位ではありません。同じ利用者でログインした複数のエージェントは、その利用者の所有受信箱を共有します。分離が必要なら本人IDを分けるか、受信箱ごとのトークンを使います。アプリのロールをOAuth scopeとして勝手に広告しません。

## bothでの入口と失効

Accessのログイン制限はagentpostの静的トークンにも適用されます。Workerを`both`にするだけでAccessの入口を迂回できるわけではありません。分かりやすい構成は、同じWorkerへAccessで保護したOAuth用ホスト名と、別のトークン用ホスト名を割り当てる方法です。両方をHTTPSと意図したポリシーで保護します。OAuth専用では署名のない`workers.dev`への直接アクセスも認可しません。

内部のイベントpoll（通常5秒ごと）でJWTを再検証し、期限切れや現在の設定に権限がない場合は終了します。これはリモートの失効照会ではありません。発行済み署名は有効期限まで使える場合があり、旧Workerのストリームはそのデプロイ時のロール設定を保持できます。Accessのsession期間を設定し、権限設定を更新するときは古いストリームを切断・排出します。更新したトークンと保存済みカーソルで再開し、拒否されたチェックポイントを勝手に捨てません。

`AGENTPOST_CURSOR_KEY`を新設・変更すると、トークン購読を含む従来の暗号化カーソルが無効になります。移行を計画し、メッセージ/outbox状態と照合してから新しいチェックポイントを作ります。token専用でこのSecretを省略した場合は、互換性のため従来の管理者Secretから導く鍵を使います。

所有者ハッシュ、トークンハッシュ、送信の冪等性情報はD1にあり、MIME原文だけでは所有者を復元できません。権限・データを復元する前に[バックアップと復旧](operations.ja.md)を確認してください。

## 検証と本番の確認

`test/oauth.test.ts`では実RS256署名とJWKS、不正署名・対象アプリ・発行元・期限・型の拒否、設定不足、所有者の分離、トークン互換、カーソルの継続、ストリームの期限切れ、実際のMCP SDKによるdiscoveryとPKCEコード交換を検証します。認可サーバーとCloudflareのopaqueトークン解決はローカルの代替実装です。実際のAccessアプリ、IdPログイン、本番MCPホストへの接続を検証済みとは扱いません。本番でOAuthを有効にする前に実接続を確認してください。
