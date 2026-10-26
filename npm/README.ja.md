<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/upamune/agentpost/main/assets/brand/svg/logo-dark.svg">
    <img src="https://raw.githubusercontent.com/upamune/agentpost/main/assets/brand/svg/logo.svg" alt="agentpost" width="420">
  </picture>
</h1>

AIエージェントに必要な数のメールアドレスを、自分のドメインで発行できます。CloudflareへセルフホストしたAPIを通じて、CLIとMCPから送受信します。

```sh
npm install --global @upamune/agentpost
agentpost --version
agentpost --help
```

Node.js 22.14以降が必要です。CLIとMCPクライアントを1ファイルにまとめ、実行時の依存パッケージやインストールスクリプトを含めません。Bunとソースcheckoutは不要です。実行コマンドは `agentpost` です。スコープのない別作者のnpmパッケージ `agentpost` は本プロジェクトとは無関係です。

`AGENTPOST_API_URL` と `AGENTPOST_API_TOKEN` は非公開のプロセス環境で設定してください。資格情報はチャットやGitに含めません。作業ディレクトリの `.env` などは自動で読み込みません。通常のメール操作には受信箱トークンを使い、送信を確認・再試行する際は同じ冪等性キーを維持します。結果が不明な送信は自動再送しません。

stdio MCPは、導入した `agentpost` の絶対パス、`args: ["mcp"]`、非公開の環境変数を設定します。MCPの標準出力はプロトコル専用です。

このクライアントはWorkerをデプロイしません。[英語の導入手順](https://github.com/upamune/agentpost/blob/main/INSTALL.md)、[日本語の導入手順](https://github.com/upamune/agentpost/blob/main/INSTALL.ja.md)、[リリース検証](https://github.com/upamune/agentpost/blob/main/docs/releases.ja.md)を参照してください。公開版はGitHub OIDCのTrusted Publishingとnpmの来歴証明を使います。
