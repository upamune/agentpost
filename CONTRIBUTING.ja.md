# コントリビューション

[English](CONTRIBUTING.md) | [日本語](CONTRIBUTING.ja.md)

バグや機能提案は [issue](https://github.com/upamune/agentpost/issues)、変更案は PR で受け付けます。英語・日本語のどちらでも報告できます。脆弱性は [非公開報告](SECURITY.ja.md)を使い、再現には合成したメールや資格情報を使ってください。

大きな変更の前に、問題・期待する動作・互換性への影響を issue で説明してください。PR は目的を絞り、問題の発生条件、変更後の動作、検証内容を記載します。メンテナーが変更案を確認してマージします。独立したレビューを推奨しますが、現状はメンテナーが 1 人のため、別の人によるレビューは保証できません。

## 開発時の確認

固定したツールと依存関係を導入してから検査します。

```sh
mise trust
mise install
mise exec -- bun install --frozen-lockfile
mise run ci
mise run security:dependencies
```

TypeScript の strict 設定、既存の formatter・linter、SHA 固定した Action を使い、実装コメントとアプリ内の文言は英語にします。英語・日本語の文書は一緒に更新してください。バグ修正には回帰テスト、新機能には意味のあるテストを追加し、公開された振る舞いや安全性の条件を確認します。受信箱の所有権、送信の claim、有効状態の fence、保存、解析、復旧を変える際は、対応する形式検証も実行します。[AGENTS.md](AGENTS.md) と[形式検証](docs/formal-verification.ja.md)を参照してください。

セキュリティ fuzzing は PR・main・毎日実行します。再現方法は[セキュリティ検査](docs/security-checks.ja.md)を参照してください。検出入力は合成データにし、回帰テストへ追加する前に最小化します。悪用できる指摘は、攻撃方法が分かる公開修正案を出す前に非公開で報告してください。

`mise run ci` は、固定した [cccc](https://github.com/moznion/cccc) で認知的複雑度と循環的複雑度も検査します。ゲートは `mise run complexity`、全 JSON 測定結果は `mise run complexity:report` で確認できます。すべての関数識別子の上限は認知的複雑度8・循環的複雑度6で、既存の例外はありません。基準値の変更はレビュー対象とし、通過のためだけに再生成・引き上げをしないでください。対象範囲、識別子、レポート、限界は[複雑度の検査](docs/complexity.ja.md)を参照してください。

テストでは合成したプロバイダー応答とローカルストレージを使い、ビルドは dry-run です。本物のメール、API トークン、本番データを fixture に含めません。秘密情報の検査には全履歴を clone し、ステージ済み変更も `mise exec -- gitleaks git --staged --redact --no-banner` で確認します。

MCP と Events の変更は[固定した仕様](docs/mcp-events.ja.md)に従います。生成証跡と vendor 化したファイルは元の言語を保持します。Undici・Zod の overrides は Cloudflare のテストツールが選ぶ脆弱な版を置き換えており、上流が修正版を採用したら見直します。[Undici](https://github.com/advisories/GHSA-xjj6-f33q-929c)、[Zod](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) のアドバイザリも参照してください。

## 互換性とリリース

原本を先に保存する順序、受信箱ごとの認可、明示した token・OAuth モード、送信の条件付き claim を維持します。プロバイダーの受理は配送の証明ではなく、結果不明の送信を自動的に別の送信で置き換えません。各運用者が自分のドメインと Cloudflare アカウントを管理します。実在する宛先と操作への承認がある場合を除き、ローカルで検証してください。

必須検査を通した後、メンテナーがリリースします。ソースアーカイブにはチェックサムと署名された来歴証明を付けます。[リリース手順](docs/releases.ja.md)で検証してください。依存関係・開発ツールの変更も実装と同様に確認し、依存更新の自動マージは有効にしません。貢献コードにはリポジトリの MIT ライセンスを適用します。
