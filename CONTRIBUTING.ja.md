# 開発への参加

[English](CONTRIBUTING.md) | [日本語](CONTRIBUTING.ja.md)

不具合や提案は[Issues](https://github.com/upamune/agentpost/issues)へ。脆弱性の報告は[SECURITY.md](SECURITY.ja.md)に従ってください。

リポジトリをcloneし、[READMEのローカル手順](README.ja.md#ローカルで試す)で依存と開発用Secretsを用意します。PRを送る前に次を実行してください。

```sh
mise run format
mise run ci
```

CIはモックの送信処理とローカルストレージを使います。実メール、実際のAPIトークンや本番データをテストに追加しないでください。ビルドはdry-runで、デプロイしません。`mise run secrets`はローカルに存在するGit履歴を検査するため、全履歴を取得したcloneで実行してください。ステージ中の差分は`mise exec -- gitleaks git --staged --redact --no-banner`で追加確認できます。

変更の目的と確認した動作をPRに記載してください。メール処理の変更では[運用設計](docs/operations.ja.md)の永続化・送信状態を保ち、MCPやEventsでは[参照仕様](docs/mcp-events.ja.md)との互換性を確認します。

依存更新時は`mise exec -- bun audit`も確認してください。`package.json`の`overrides`は、MiniflareとCloudflare Vitestプラグインが固定するUndici・Zodの脆弱な版を同一メジャーの修正版に置き換えます。上流が修正版を採用したら削除を検討してください。参照: [Undiciの修正版](https://github.com/advisories/GHSA-xjj6-f33q-929c)、[Zodの修正版](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)。

ドキュメント、コードコメント、エージェント向けの指示は英語を既定にします。保守する文書には日本語版の`*.ja.md`と相互リンクを用意し、両方を更新してください。生成された検証証拠と外部由来のスキルは元の言語・ライセンス表記を保持します。
