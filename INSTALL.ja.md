# AIエージェント向け導入手順

[English](INSTALL.md) | [日本語](INSTALL.ja.md)

利用者からagentpostのインストール・設定を依頼されたときに使う手順です。Worker API、単体実行ファイル・Bun CLI、MCPサーバー、任意で導入するエージェント用スキルを提供します。

## 導入方法を選ぶ

- **OAuthでリモートMCPへ接続:** 対応クライアントにAccessで保護した`/mcp` URLを登録し、クライアントのログイン・更新機能を使います。ほかの用途で必要でなければソースcheckout・CLI・`AGENTPOST_API_TOKEN`は不要です。[認証設定](docs/authentication.ja.md)を参照してください。

- **既存Workerへの接続:** npmパッケージ、検証した単体実行ファイル、またはソースを導入し、`AGENTPOST_API_URL`と`AGENTPOST_API_TOKEN`を設定します。必要ならMCPとスキルも設定します。Cloudflare管理用の資格情報は不要です。
- **ローカルWorkerを試す:** ソースの導入後、ローカル検証へ進みます。ドメインやCloudflareの資格情報は不要です。
- **自分のWorkerをホスト:** 利用者自身のCloudflareアカウントとドメインで[導入手順](docs/deploy.ja.md)を実施します。D1、R2、Queues、受信箱ごとのSQLite-backed Durable Objectを使います。Wranglerがデプロイ時にObjectのバインディングとmigrationを作成します。ローカルのインストールだけではデプロイしません。

既存のcheckout、ツール、資格情報、MCP設定を再利用してください。非公開リポジトリの取得には既存のGit認証を使い、取得失敗時はアクセス不足を報告します。可視性は変更しません。

## npmで導入する

Node.js 22.14以降で、スコープ付きの `@upamune/agentpost` を使います。スコープのない `agentpost` は別のパッケージです。npm版には実行時の依存パッケージ、ネイティブaddon、インストールスクリプトを含めず、Bunも不要です。

```sh
npm install --global --ignore-scripts @upamune/agentpost@X.Y.Z
agentpost --version
agentpost --help
```

`X.Y.Z` は公開済みのバージョンへ置き換えてください。エージェントが導入する場合、先に `upamune-agentpost-VERSION.tgz` を取得し、[リリース検証](docs/releases.ja.md)に従ってGitHubの署名付き来歴証明とチェックサムを検証します。その後、同じローカルアーカイブを `npm install --global --ignore-scripts /absolute/path/to/upamune-agentpost-VERSION.tgz` で導入してください。導入だけではクライアントを起動したりWorkerへ接続したりしません。来歴を検証できない場合は停止します。既存環境を保持し、許可されたユーザー所有のnpm prefixを使ってください。権限不足をsudoで回避しません。

版、実行コマンドとNodeの絶対パス、`npm root --global` を記録します。npm版は作業ディレクトリの `.env` などを自動で読みません。資格情報は後述の非公開設定で渡します。stdio MCPは、クライアントのPATHにNodeを含めて導入済みコマンドを使うか、Nodeの絶対パスを `command` に、`["/ABSOLUTE_NPM_ROOT/@upamune/agentpost/cli.mjs", "mcp"]` を `args` に指定します。後者はWindowsの `.cmd` ランチャーの違いも避けられます。既存のMCPサーバーと資格情報は保持してください。

## 単体実行ファイルを導入する

対象のOS・CPU・Linux libc向けのバイナリが掲載されている[GitHub Release](https://github.com/upamune/agentpost/releases)を選びます。選んだ実行ファイル、`SHA256SUMS`、manifest、来歴証明bundleを[検証手順](docs/releases.ja.md#ダウンロードの検証)に従って実行前に検証します。v0.1.1を含む過去のソース限定リリースには実行ファイルがないため、適したリリースがなければソースから導入します。来歴の欠落・検証失敗では停止します。

実行ファイルはBunを内包し、CLIとstdio MCP（`agentpost mcp`）に対応します。Bun・Node.js・ソースcheckoutは不要です。既存の導入を保持して新しい版別ディレクトリを選び、実行ファイルの絶対パスを記録します。macOS・Linuxでは、検証手順で `version` と `asset` を設定した後に実行します。

```sh
install_dir="/absolute/unused/path/agentpost-${version}"
mkdir "$install_dir" && install -m 755 "$asset" "$install_dir/agentpost" && \
  "$install_dir/agentpost" --version && "$install_dir/agentpost" --help
```

Windowsでは `New-Item -ItemType Directory -ErrorAction Stop` で新しいディレクトリを作り、検証した `.exe` を `agentpost.exe` としてコピーし、絶対パスで実行します。PATHへの追加は依頼された場合だけ行います。クライアントのファイル引数は現在の作業ディレクトリを基準にするため、エージェント設定ではタスクの絶対パスを使います。

単体実行ファイルは作業ディレクトリの `.env`・`bunfig.toml`・`package.json`・`tsconfig.json` を自動読込しません。呼び出し元プロセスや非公開のMCP環境設定から資格情報を渡します。Workerの導入・ローカル開発には、以下のソースcheckoutを使います。

## ソースから導入する

Gitと[mise](https://mise.jdx.dev/getting-started.html)が必要です。CLIはBun、WranglerはNode.jsで動きます。npmパッケージは公開しておらず、単体クライアントは別のリリース成果物です。

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

このコマンドは作業ディレクトリをcheckout先に変えます。別プロジェクトの本文・添付・カーソルファイルは絶対パスで指定してください。原文と添付のダウンロードは0600で新しいファイルを作ります。既存ファイルやシンボリックリンクは拒否するため、未使用の保存先を選びます。Windowsの権限はディレクトリのACLに従うため、利用者専用の非公開ディレクトリを使います。

## 検証付きリリースアーカイブから導入する

バージョンを固定したソース導入では、[GitHub Releases](https://github.com/upamune/agentpost/releases) からアーカイブと来歴証明の bundle を取得し、展開・実行の前に[リリースの検証手順](docs/releases.ja.md#ダウンロードの検証)に従います。配布元のリポジトリ、署名したワークフロー、選んだバージョンのタグを確認してください。チェックサムだけでは不十分です。来歴証明が欠けている場合や検証に失敗した場合は、導入の確認に失敗したと扱い、検証を省略しません。アーカイブにはソースと固定した lockfile を含み、Bun・npm パッケージ・単体バイナリは含みません。検証後、新しい永続ディレクトリに展開し、上記と同じ固定版の Bun・Node と依存関係を導入して、ソースの絶対パスとバージョンを記録します。開発用には main の clone も利用できます。

## 既存Workerに接続する

利用者の非公開設定やシークレット管理からAPI URLとトークンを取得します。値をチャット・シェルのトレース・ログ・コミット対象へ出さないでください。アプリの環境変数はすべて`AGENTPOST_`で始まります。[設定一覧](docs/deploy.ja.md#環境変数)を参照してください。

`AGENTPOST_API_URL`はWorkerのHTTPSベースURL、`AGENTPOST_API_TOKEN`は通常のメール操作用の受信箱トークンです。トークン方式では管理者トークンを発行・管理に限って使います。OAuth agentはネイティブのリモートMCPから自分の受信箱を発行・一覧できます。発行・トークン再発行の応答は秘密情報なので非公開に保存します。
受信箱トークンは閲覧と送信の両方ができます。通常のエージェントに管理者資格情報を渡さず、タスクごとに受信箱を分けます。429では`Retry-After`を守り、同じメールの再要求には同じ冪等キーを使います。

指定された受信箱UUIDで、送信を伴わない疎通確認を行います。

```sh
/absolute/path/to/agentpost inbox get INBOX_UUID
```

受信箱の発行を依頼された場合は、`inbox create --local-part research`で設定済みドメインに名前を指定できます。省略時はランダムです。同名は無効化済みでも競合し、再割り当てを行いません。

管理者なら`inbox list --limit 1`も使えます。`health`は管理者専用なので、拒否だけで受信箱トークンが不正とは判断できません。URL・資格情報・受信箱IDが不足している場合はソースの導入を完了し、不足設定を報告します。インストールの確認のためだけに受信箱を作ったり送信したりしません。

## MCPを設定する

ネイティブのリモートMCP OAuthでは、保護したURLを登録し、クライアントの認可フローを使います。ほかのサーバーを保持し、discovery・ログイン・ツール操作を確認してから成功と報告します。[OAuthの設定と権限](docs/authentication.ja.md)を参照してください。

トークン方式のstdio MCPでは、既存設定に`agentpost`を追加し、ほかのサーバーを保持します。以下は設定内容の例で、クライアントごとの設定ファイルの保存先を指定するものではありません。

```json
{
  "mcpServers": {
    "agentpost": {
      "command": "/absolute/path/to/agentpost",
      "args": ["mcp"],
      "env": {
        "AGENTPOST_API_URL": "https://YOUR_WORKER.workers.dev",
        "AGENTPOST_API_TOKEN": "YOUR_INBOX_TOKEN"
      }
    }
  }
}
```

Windowsでは `agentpost.exe` の絶対パスを使います。ソース導入の場合は `command: "mise"` と `args: ["exec", "--cd", "/absolute/path/to/agentpost", "--", "bun", "run", "src/cli.ts", "mcp"]` も使えます。パスを置き換え、資格情報はクライアントの非公開設定から渡します。stdioの標準出力はMCP専用です。実際のクライアントで接続・ツール検出を確認してから接続済みと報告します。設定ファイルを書くだけでは接続確認になりません。

Bearer認証付きStreamable HTTP対応クライアントは`https://YOUR_WORKER.workers.dev/mcp`に直接接続できます。また、対応するリモートMCPクライアントはoauth/bothでCloudflare Access Managed OAuthを使い、APIトークンをコピーせずに接続できます。[MCPとEvents](docs/mcp-events.ja.md)で本体仕様と実験的Eventsドラフトを確認してください。

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

追加のCI実行ファイルmatrixは7プラットフォームすべてのビルドと起動確認を行います。版タグのリリースで来歴証明付きの実行ファイルを添付します。[リリース手順](docs/releases.ja.md)も参照してください。ローカルでは `mise run cli:build PLATFORM --verify-reproducible` と `mise run cli:smoke --platform PLATFORM` を使い、ソース・package・lockfile・設定・ビルドスクリプトの変更を先にコミットします。

GitHub ActionsはmainへのpushとPRで検査とWorkerのdry-runビルドを行います。`mise run build`は`wrangler deploy --dry-run`で、デプロイやCLIバイナリ公開ではありません。ローカルの全検査は`mise install`後に`mise run ci`を使います。

実行ファイルまたはcheckout先、CLIの版、スキルの導入範囲、成功した接続・ローカル検査を報告します。資格情報の値を出さず、不足設定を列挙します。ソース導入、MCP接続、ローカル検証、本番デプロイを区別します。本番送受信にはドメイン、Email Routing/Sending Beta、DNS、資格情報、導入手順の実送受信確認が必要です。実送信は利用者が指定した宛先でのみ行い、インストールの依頼だけでは送信しません。

## ドメイン設定を診断する

ホスティング設定後や認証・到達性の問題では、管理者としてMCP `check_domain` またはCLI `domain check` を実行します。受信箱トークンやOAuth `agent` から管理者権限へ自動的に切り替えません。レポートのpass・warning・fail・unknownと修正案を確認し、診断だけで到達を保証しません。宛先の指定・許可がないテスト送信やDNS自動修正は行いません。[診断の設定と制限](docs/domain-diagnostics.ja.md)を参照してください。
