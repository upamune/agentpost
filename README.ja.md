<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/svg/logo-dark.svg">
    <img src="assets/brand/svg/logo.svg" alt="agentpost" width="420">
  </picture>
</h1>

[![npm](https://img.shields.io/npm/v/%40upamune%2Fagentpost)](https://www.npmjs.com/package/@upamune/agentpost)

[![CI](https://github.com/upamune/agentpost/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/upamune/agentpost/actions/workflows/ci.yml)
[![CodeQL](https://github.com/upamune/agentpost/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/upamune/agentpost/actions/workflows/codeql.yml)

[![Verified release](https://github.com/upamune/agentpost/actions/workflows/release.yml/badge.svg)](https://github.com/upamune/agentpost/actions/workflows/release.yml)

[English](README.md) | [日本語](README.ja.md) | [Webサイト](https://upamune.github.io/agentpost/ja/)

**サイトごとに、別のメールアドレスを。エージェントで受信・送信・返信まで。**

登録、領収書、ニュースレター。いつものメールアドレスをすべてのサイトに渡す代わりに、専用のアドレスを使えます。自分のドメインに独立した受信箱を作り、エージェントがCLI・MCP・APIで受信・転送・送信・返信を担当。不要になったアドレスだけ無効化できます。自分のCloudflareアカウントで動かすオープンソースです。

```sh
# 1. 登録先の専用アドレスを作る（管理者の資格情報で実行）。
agentpost inbox create --label shop.example
# JSON結果に含まれるアドレスの例: cedar-moon-river@example.com

# 2. 登録に使い、届いたメールを読む。
agentpost message list INBOX_ID
agentpost message get INBOX_ID MESSAGE_ID

# 3. 同じ専用アドレスから、添付付きで返信する。
agentpost reply INBOX_ID MESSAGE_ID \
  --text 'Thanks! Here is the requested document.' --attach document.pdf

# 4. 専用アドレスから、新しいメールも送れる。
agentpost send INBOX_ID --to support@shop.example \
  --subject 'Invoice request' --text 'Could you send a copy of my invoice?'

# 5. 不要になったら、このアドレスだけ停止する（管理者）。
agentpost inbox disable INBOX_ID
```

[インスタンスと認証情報の設定](INSTALL.ja.md)が必要です。IDはプレースホルダーで、添付の例にはローカルの `document.pdf` を用意してください。名前を指定しない場合はランダムな英単語3つをハイフンで結び、`--local-part`で好きな名前も指定できます。受信箱トークンは受信・送信に使えます。発行と無効化には管理者権限が必要です（OAuthのagent権限では自分の受信箱を発行できます）。送信状態と冪等キーの扱いは[送信と安全な再試行](#メールを送る)を参照してください。

DuckDuckGo Email Protectionのような**登録先ごとのエイリアス**が主な用途で、それぞれの受信箱をエージェントで操作できます。任意の[標準転送](docs/forwarding.ja.md)を設定すると、Cloudflareで検証済み・運用者が許可した宛先へコピーを送れます。全体の既定値と、受信箱ごとの継承・別宛先・転送なしに対応します。**メール内トラッカーの除去は行いません**。メールは自分のCloudflareアカウントに保存します。ドメインや本文から関連付けられる可能性は残り、匿名性を保証するものではありません。無効化すると新しい受信と送信を止めます。保存済みのメールは保持し、アドレス名も予約されたままです。

[操作できるデモを見る](https://upamune.github.io/agentpost/ja/#workflow) · [セキュリティチェック](docs/security-checks.ja.md)

## CLIとMCPクライアントを導入する

```sh
npm install --global @upamune/agentpost
agentpost --version
agentpost --help
```

Node.js 22.14以降が必要です。npm版にBunは不要で、実行時の依存をバンドルし、インストールスクリプトを含めません。stdio MCPは `agentpost mcp` で起動します。スコープのないnpmパッケージ `agentpost` は別のプロジェクトです。[導入・検証手順](INSTALL.ja.md)に、版の固定、単体実行ファイル、資格情報、エージェントの設定を記載しています。

## できること

- 登録先ごとに、英単語3つのランダムなアドレスや指定した名前を発行できます。ラベルに用途を記録し、不要なアドレスだけ無効化できます。既存・無効化済みアドレスを発行操作で再割り当てすることはありません。
- メールの本文、HTML、添付ファイル、原文の`.eml`を取得できます。
- 発行したアドレスからメールを送信し、Reply-Toとスレッド情報を引き継いで返信できます。
- エージェントとの接続に、JSONを返すCLI、HTTP API、stdioとStreamable HTTPのMCPサーバーを提供します。Bunを内包する単体CLI/MCPは、macOS・Linux（glibc/musl）のx64/arm64およびWindows x64向けリリース成果物です。[検証と導入](docs/releases.ja.md)を参照してください。
- 受信と送信状態の変化を監視し、保存したカーソルから再開できます。
- 受信箱トークンで、エージェントが操作できるメールを受信箱ごとに分離できます。

現在は初期開発段階です。
各セルフホスト環境で、認証・DNS・実際のメール送受信を確認する必要があります。
送信に使う[Cloudflare Email Sending](https://developers.cloudflare.com/email-service/get-started/send-emails/)はBetaです。
本番導入前に、利用する環境で送受信と復旧手順を確認してください。

## AIエージェント向けの導入

AIエージェントには[INSTALL.md](INSTALL.ja.md)を渡してください。
既存Workerへの接続、ローカルでの動作確認、MCPの設定、自分のCloudflareアカウントへの導入を区別して進められる手順です。

```text
次の手順を読んで、agentpostをこのプロジェクトで使えるように設定してください。
https://github.com/upamune/agentpost/blob/main/INSTALL.ja.md
```

メール操作用の[agentpostスキル](skills/agentpost/SKILL.md)も同梱しています。
受信箱の操作、送信時の冪等キー、送信状態の確認、イベント監視の扱いをエージェントに伝えます。
次はCodex向けの導入例です。スキルを使うプロジェクトのディレクトリで実行してください。
Claude Codeでは`--agent codex`を`--agent claude-code`に変更します。

```sh
mise exec bun@1.4.4 -- bunx skills@1.7.4 add upamune/agentpost \
  --skill agentpost --agent codex --yes
```

スキルの導入と、CLI本体のインストールや接続先の設定は別です。
CLI本体の準備と接続確認は`INSTALL.md`に従ってください。

## ローカルで試す

[mise](https://mise.jdx.dev/getting-started.html)をインストールして、次のコマンドを実行します。
必要なBunとNode.jsのバージョンはリポジトリで固定しています。
ローカルの受信テストには、独自ドメインやCloudflareの認証情報は不要です。

```sh
git clone https://github.com/upamune/agentpost.git
cd agentpost
mise trust
mise install
mise exec -- bun install --frozen-lockfile
mise exec -- bun run setup:local
mise exec -- bun run db:migrate:local
mise run dev
```

`setup:local`はランダムな管理者トークンを含む`.dev.vars`を作成します。
既存のファイルは上書きしません。
このファイルはGitの管理対象外です。

サーバーを起動したまま、別のターミナルから受信テストを実行できます。

```sh
mise exec -- bun run smoke:local
```

このテストは受信箱の発行、テストメールの投入、キューによる解析、本文と原文の取得を確認します。
外部へのメール送信は行いません。

### CLIで受信箱を作る

リポジトリのルートで、接続先とトークンを設定します。
`AGENTPOST_API_TOKEN`には`.dev.vars`の`AGENTPOST_ADMIN_TOKEN`の値を指定してください。

```sh
export AGENTPOST_API_URL=http://localhost:8787
export AGENTPOST_API_TOKEN='YOUR_ADMIN_TOKEN'

mise exec -- bun run cli inbox create --label research-agent
```

名前を指定する場合は、`@`の前の部分を渡します。

```sh
mise exec -- bun run cli inbox create --local-part research --label research-agent
```

これで`research@自分のドメイン`を発行します。`--local-part`の省略時は`cedar-moon-river@自分のドメイン`のように英単語3つをハイフンで結びます。自動生成の重複は最大8回試し、既存の受信箱や資格情報は変更しません。名前は小文字で保存し、同名は無効化済みでも409で拒否します。[命名規則](docs/http-api.ja.md#受信箱の名前)も参照してください。

応答に含まれる`id`、`address`、`token`を保存します。
受信箱トークンは作成時と再発行時にだけ返されます。
以後、その受信箱だけを扱うエージェントには`token`を渡してください。

```sh
export AGENTPOST_API_TOKEN='YOUR_INBOX_TOKEN'

mise exec -- bun run cli inbox get YOUR_INBOX_UUID
mise exec -- bun run cli message list YOUR_INBOX_UUID
mise exec -- bun run cli events watch --inbox YOUR_INBOX_UUID \
  --cursor-file .agentpost/received.cursor.json
```

CLIはJSONを標準出力に返し、イベント監視では1行に1件のJSON（NDJSON）を返します。
コマンドの一覧は`mise exec -- bun run cli --help`で確認できます。
設定に使う環境変数はすべて`AGENTPOST_`で始まります。
Worker、CLI、MCPそれぞれの設定先は[環境変数の一覧](docs/deploy.ja.md#環境変数)を参照してください。

## Cloudflareに導入する

実際のメールを送受信するには、次の準備が必要です。

- Cloudflare DNSで管理する独自ドメイン
- Cloudflare Workers Paidと、D1、R2、Queues、Durable Objectsを利用できるアカウント
- 対象ドメインのEmail RoutingとEmail Sendingの有効化
- Email SendingのAPIトークンと、選択した[認証方式の設定](docs/authentication.ja.md)

[導入手順](docs/deploy.ja.md)に沿って、ストレージとキューの作成、DNS、Secrets、デプロイ、catch-allの設定を行ってください。
アドレスごとのルーティング設定は不要です。
agentpostが発行した有効なアドレスだけでメールを受け入れます。

導入後は`AGENTPOST_API_URL`をWorkerのHTTPS URLに変更すると、同じCLIとMCPを使えます。
ローカルの`.dev.vars`に`AGENTPOST_CF_ACCOUNT_ID`と`AGENTPOST_CF_EMAIL_API_TOKEN`を設定した場合も、実際の送信APIを呼びます。
そのため、送信テストには自分で管理する宛先を指定してください。

### メールを送る

**冪等キー**を省略するとUUIDv4を自動生成し、成功結果と送信エラーで通知します。内容とともに保存し、同じメールを再要求するときはそのキーを明示してください。省略したままの再呼び出しは別送信です。永続的なエージェント処理では、初回の前にキーを決めて保存する方法も使えます。

```sh
mise exec -- bun run cli send YOUR_INBOX_UUID \
  --to recipient@example.net \
  --subject 'Hello' \
  --text 'Hello from my agent' \
  --idempotency-key task-123-message-1

mise exec -- bun run cli outbox get YOUR_INBOX_UUID YOUR_SEND_UUID
```

送信を要求すると、状態を確認するためのoutbox IDが返されます。
`accepted`はCloudflareが要求を受理した状態で、宛先への配達完了を意味しません。
タイムアウトなどで結果が`unknown`になった場合は、自動再送せず、管理者が送信結果を確認します。

## 受信メールを転送する

受信箱に保存しながら、Cloudflareで検証済み・運用者が許可した宛先へ転送できます。管理者が全体の既定値と受信箱ごとの設定を操作します。

```sh
agentpost forwarding set --destination operator@example.net
agentpost forwarding set INBOX_ID --destination team@example.org
agentpost forwarding off INBOX_ID
agentpost forwarding inherit INBOX_ID
```

初期状態は無効です。先に`0007_forwarding.sql`を適用し、Cloudflareで宛先を検証して、`AGENTPOST_FORWARD_ALLOWED_DESTINATIONS`を非公開に設定します。変更は以後の受信に適用し、結果不明の転送を自動で再試行しません。[設定と復旧](docs/forwarding.ja.md)では、個人アドレスを公開せずエイリアスから返信する方法も説明しています。

## 受信箱ごとのWebhook

`agentpost webhook set INBOX_UUID --webhook-url https://hooks.example.com/mail`で、解析済みの受信メールをIDだけの署名付き通知として送れます。ホスト側の明示的なorigin許可と暗号鍵が必要です。秘密鍵の保存、重複排除、再試行は[Webhookの手順](docs/webhooks.ja.md)を参照してください。

## MCPから使う

MCPクライアントから、受信箱の発行、受信メールの取得、送信、返信、送信状態の確認を行えます。
対応するプロトコルはMCP **2026-07-28**、公式TypeScript SDKはv2.4.0です。

| 操作       | ツール                                      |
| ---------- | ------------------------------------------- |
| 受信箱     | `create_inbox`、`list_inboxes`、`get_inbox` |
| 受信メール | `list_messages`、`get_message`              |
| 送信と返信 | `send_email`、`reply_email`                 |
| 送信状態   | `get_send_status`、`list_outbox`            |

### stdio

クライアントの設定例です。
`/absolute/path/to/agentpost`をcloneしたディレクトリに置き換えてください。
ローカルサーバーに接続する場合は`AGENTPOST_API_URL`を`http://localhost:8787`に変更します。

```json
{
  "mcpServers": {
    "agentpost": {
      "command": "mise",
      "args": [
        "exec",
        "--cd",
        "/absolute/path/to/agentpost",
        "--",
        "bun",
        "run",
        "src/cli.ts",
        "mcp"
      ],
      "env": {
        "AGENTPOST_API_URL": "https://YOUR_WORKER.workers.dev",
        "AGENTPOST_API_TOKEN": "YOUR_INBOX_TOKEN"
      }
    }
  }
}
```

受信箱の新規発行と一覧取得には管理者トークンが必要です。
管理者トークンは全受信箱を操作できるため、必要なエージェントにだけ渡してください。

### Streamable HTTP

`AGENTPOST_AUTH_MODE`で`token`（既定）・`oauth`・`both`を選べます。トークン接続は`Authorization: Bearer <token>`を送ります。MCP標準OAuthはCloudflare Access Managed OAuthを設定し、保護したHTTPSの`/mcp` URLを対応クライアントへ登録します。ブラウザログインとトークン更新はクライアントが処理します。

OAuthの`agent`はadmin APIトークンなしで自分の受信箱を発行・操作でき、明示的に`admin`を与えた本人が全体を管理します。ロール、Access設定、bothでの入口は[認証と認可](docs/authentication.ja.md)を参照してください。OAuthでの発行はbothでも受信箱トークンを含めません。上記CLI・stdio手順はトークン方式のままです。

### MCP Events

受信通知の`message.received`と、送信状態通知の`message.send_status_changed`を提供します。
`events/list`、`events/poll`、`events/stream`に対応し、pollとpushで購読できます。

**MCP Eventsへの対応は作業部会のドラフトに基づく実験的な機能です**。
MCP本体の確定仕様とは別に扱い、対応クライアントで利用してください。
参照したドラフト、購読とカーソルの扱いは[MCPとEventsの対応範囲](docs/mcp-events.ja.md)を参照してください。

## HTTP API

受信箱の発行から送受信、イベント監視まで、Bearerトークン付きのHTTP APIで操作できます。

```sh
curl "$AGENTPOST_API_URL/v1/inboxes" \
  -H "Authorization: Bearer $AGENTPOST_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"label":"research-agent"}'
```

上の発行例には管理者トークンが必要です。
エンドポイントと送信例は[HTTP APIリファレンス](docs/http-api.ja.md)に記載しています。

## 保存と障害対応

メールの原文と本文はR2、受信箱、処理状態、イベント履歴はD1に保存します。
Cloudflare WorkersがAPIとMCPを提供し、Queuesでメールを処理します。
送信・受信箱の無効化・送信中断の復旧は、受信箱ごとのDurable Objectで順番に処理します。

受信時は原文を保存してから解析します。
キューへの投入や解析が失敗した場合は、保存済みの原文から復旧を試みます。
送信時は要求を永続化します。
キュー処理が重複しても、条件付きの状態更新で二重送信を防ぎます。

監視項目、再試行の条件、障害時の復旧手順は[運用設計](docs/operations.ja.md)を参照してください。

## ドメイン設定の診断

管理者は `mise exec -- bun run cli domain check`、APIの `GET /v1/domain/check`、MCPの `check_domain` でSPF・DKIM・明示DMARC・送受信用MXを確認できます。任意の専用資格情報があればCloudflareの送信設定とも照合します。修正案と確認不能な項目を表示し、メール送信やDNS変更は行いません。[診断範囲と設定](docs/domain-diagnostics.ja.md)を参照してください。通過しても受信トレイへの到達は保証できません。

## 制約

| 項目                | 対応範囲                                                                      |
| ------------------- | ----------------------------------------------------------------------------- |
| 受信サイズ          | 1通あたり10 MiBまで                                                           |
| 解析結果のJSON      | 16 MiBまで。超過時も原文は保持                                                |
| APIのJSONリクエスト | 512 KiBまで                                                                   |
| 送信形式            | テキスト必須・HTML任意・[送信添付](docs/outbound-attachments.ja.md)は最大10個 |
| 保存期間            | メールとイベントを無期限に保存。自動削除は未対応                              |
| イベント配信        | at-least-once。受信側で`eventId`による重複除去が必要                          |
| 認証                | トークン、Cloudflare AccessのMCP OAuth、または両方                            |
| インターフェース    | API、CLI、MCP。Web UI、IMAP、クライアント向けSMTPサーバーは未提供             |

直近の敵対的調査と修正は[セキュリティ調査](docs/security-audit.ja.md)にまとめています。

メール本文や添付は信頼できない外部入力です。
エージェントに渡す際の権限設定と、脆弱性の報告方法は[SECURITY.md](SECURITY.ja.md)を参照してください。

## 開発とコントリビューション

```sh
mise run format
mise run ci
```

CIではmainへのpushとPRごとに、整形、静的解析、型検査、テスト、Workerのdry-runビルド、秘密情報チェックを自動実行します。
依存パッケージの脆弱性監査もpush・PRと毎日実行します。
版タグのリリースでは、7プラットフォーム向けの単体CLI/MCP実行ファイルを、署名付き来歴証明とチェックサムと一緒に添付します。過去のソース限定リリースは変更せず、npmクライアントは `@upamune/agentpost` としてGitHub OIDCと来歴証明を使って公開します。CIでは実際のメールや本番デプロイを使わず全プラットフォームの起動確認を行います。
実メールの送信と本番への自動デプロイは行いません。
リリースPRとタグ・GitHub Releaseはtagprで管理します。GitHub Appの初期設定とリリースの確認方法は[リリース手順](docs/releases.ja.md)を参照してください。
送信停止・復旧の競合と、受信原文・索引の復旧は[pstack / TLA+形式検証](docs/formal-verification.ja.md)で検査します。モデル検査、実コードでの再現、ガードを壊す変異検査をCIで実行します。
不具合や提案は[Issues](https://github.com/upamune/agentpost/issues)、開発手順は[CONTRIBUTING.md](CONTRIBUTING.ja.md)を参照してください。

## ライセンス

[MIT](LICENSE)。
同梱スキルの著作権・ライセンス表記は各スキルのディレクトリに保持しています。
