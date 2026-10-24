# AIエージェント向け導入手順

[English](INSTALL.md) | [日本語](INSTALL.ja.md)

利用者からagentpostのインストール・設定を依頼されたときに使う手順です。Worker API、Bun CLI、MCPサーバー、任意で導入するエージェント用スキルを提供します。

## 導入方法を選ぶ

- **既存Workerへの接続:** ソースを取得し、`AGENTPOST_API_URL`と`AGENTPOST_API_TOKEN`を設定します。必要ならMCPとスキルも設定します。Cloudflare管理用の資格情報は不要です。
- **ローカルWorkerを試す:** ソースの導入後、ローカル検証へ進みます。ドメインやCloudflareの資格情報は不要です。
- **自分のWorkerをホスト:** 利用者自身のCloudflareアカウントとドメインで[導入手順](docs/deploy.ja.md)を実施します。D1、R2、Queues、受信箱ごとのSQLite-backed Durable Objectを使います。Wranglerがデプロイ時にObjectのバインディングとmigrationを作成します。ローカルのインストールだけではデプロイしません。

既存のcheckout、ツール、資格情報、MCP設定を再利用してください。非公開リポジトリの取得には既存のGit認証を使い、取得失敗時はアクセス不足を報告します。可視性は変更しません。

## ソースから導入する

Gitと[mise](https://mise.jdx.dev/getting-started.html)が必要です。CLIはBun、WranglerはNode.jsで動きます。npmパッケージや単体CLIバイナリはまだ配布していません。

永続的なcheckout先を選びます。既存ディレクトリを使う場合は内容を確認し、未コミットの変更を保持してください。

```sh
git clone https://github.com/upamune/agentpost.git
cd agentpost
mise trust
mise install bun node
mise exec -- bun install --frozen-lockfile
mise exec -- bun run cli --version
mise exec -- bun run cli --help
```

別の作業ディレクトリからはcheckoutの絶対パスを指定します。

```sh
mise exec --cd /absolute/path/to/agentpost -- bun run src/cli.ts --help
```

このコマンドは作業ディレクトリをcheckout先に変えます。別プロジェクトの本文・添付・カーソルファイルは絶対パスで指定してください。原文と添付のダウンロードは0600で新しいファイルを作ります。既存ファイルやシンボリックリンクは拒否するため、未使用の保存先を選びます。

## 既存Workerに接続する

利用者の非公開設定やシークレット管理からAPI URLとトークンを取得します。値をチャット・シェルのトレース・ログ・コミット対象へ出さないでください。アプリの環境変数はすべて`AGENTPOST_`で始まります。[設定一覧](docs/deploy.ja.md#環境変数)を参照してください。

`AGENTPOST_API_URL`はWorkerのHTTPSベースURL、`AGENTPOST_API_TOKEN`は通常のメール操作用の受信箱トークンです。管理者トークンは発行・管理に限って使います。発行・トークン再発行の応答は秘密情報なので非公開に保存します。
受信箱トークンは閲覧と送信の両方ができます。通常のエージェントに管理者資格情報を渡さず、タスクごとに受信箱を分けます。429では`Retry-After`を守り、同じメールの再要求には同じ冪等キーを使います。

指定された受信箱UUIDで、送信を伴わない疎通確認を行います。

```sh
mise exec --cd /absolute/path/to/agentpost -- bun run src/cli.ts inbox get INBOX_UUID
```

管理者なら`inbox list --limit 1`も使えます。`health`は管理者専用なので、拒否だけで受信箱トークンが不正とは判断できません。URL・資格情報・受信箱IDが不足している場合はソースの導入を完了し、不足設定を報告します。インストールの確認のためだけに受信箱を作ったり送信したりしません。

## MCPを設定する

利用者がMCPを使う場合、既存設定に`agentpost`を追加し、ほかのサーバーを保持します。以下は設定内容の例で、クライアントごとの設定ファイルの保存先を指定するものではありません。

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

パスを置き換え、資格情報はクライアントの非公開設定から渡します。stdioの標準出力はMCP専用です。実際のクライアントで接続・ツール検出を確認してから接続済みと報告します。設定ファイルを書くだけでは接続確認になりません。

Bearer認証付きStreamable HTTP対応クライアントは`https://YOUR_WORKER.workers.dev/mcp`に直接接続できます。OAuthは未実装です。[MCPとEvents](docs/mcp-events.ja.md)で本体仕様と実験的Eventsドラフトを確認してください。

## エージェント用スキルを導入する

配布用スキルは[`skills/agentpost`](skills/agentpost/SKILL.md)です。受信箱操作、冪等な再要求、送信状態、再開可能な監視を説明します。スキルの導入だけではCLIのインストール・認証設定・Workerのデプロイは行いません。英語を既定とし、同梱の[日本語ガイド](skills/agentpost/references/guide.ja.md)も参照できます。

スキルを使うプロジェクトで実行してください。以下はCodex向けです。Claude Codeでは`codex`を`claude-code`に変え、ほかのクライアントはinstallerの対応名を使います。グローバル導入の指定がなければプロジェクト単位で導入します。

```sh
mise exec bun@1.4.4 -- bunx skills@1.7.4 add upamune/agentpost \
  --skill agentpost --agent codex --yes
```

既存checkoutがあれば`upamune/agentpost`を絶対パスに置き換えます。`--skill agentpost`で利用者向けスキルだけを選び、開発用スキルを除外します。導入先にスキルと参照ファイルがあることを確認します。installerへAPIトークンは渡しません。

## ローカルWorkerを検証する

ソースcheckoutで実行します。

```sh
mise exec -- bun run setup:local
mise exec -- bun run db:migrate:local
mise run dev
```

`setup:local`はランダムな`AGENTPOST_ADMIN_TOKEN`を含むGit管理外の`.dev.vars`を作り、既存ファイルは上書きしません。別ターミナルで受信テストを行います。

```sh
mise exec -- bun run smoke:local
```

ローカル受信箱を作り、Wranglerへテスト原文を投入し、解析・本文・原文取得を検証します。外部へメールを送りません。別ポートなら`AGENTPOST_LOCAL_URL`を設定します。ローカル専用の確認ではCloudflare送信用資格情報を設定しません。

## ビルドと完了の報告

GitHub ActionsはmainへのpushとPRで検査とWorkerのdry-runビルドを行います。`mise run build`は`wrangler deploy --dry-run`で、デプロイやCLIバイナリ公開ではありません。ローカルの全検査は`mise install`後に`mise run ci`を使います。

checkout先、CLIの版、スキルの導入範囲、成功した接続・ローカル検査を報告します。資格情報の値を出さず、不足設定を列挙します。ソース導入、MCP接続、ローカル検証、本番デプロイを区別します。本番送受信にはドメイン、Email Routing/Sending Beta、DNS、資格情報、導入手順の実送受信確認が必要です。実送信は利用者が指定した宛先でのみ行い、インストールの依頼だけでは送信しません。
