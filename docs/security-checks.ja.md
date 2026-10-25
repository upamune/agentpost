# 継続的なセキュリティチェック

[English](security-checks.md) | [日本語](security-checks.ja.md)

agentpost は静的解析、依存関係・秘密情報のスキャン、敵対的テスト、有限範囲の形式検証を組み合わせます。README のバッジから現在の結果を確認できます。成功したバッジはそのチェックの完了を示すもので、安全性の認証や各導入環境の安全性の証明ではありません。

## 自動検査の対象

| 検査                                 | 対象                                                                         | 実行タイミング                                           | 結果                                                                                                                                                                              |
| ------------------------------------ | ---------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CodeQL の `security-extended`        | JavaScript/TypeScript のデータフローとセキュリティ規則                       | main への push、PR、毎日、手動                           | [Code scanning](https://github.com/upamune/agentpost/security/code-scanning)、[ワークフロー](https://github.com/upamune/agentpost/actions/workflows/codeql.yml)                   |
| OSV-Scanner                          | 開発依存も含む `bun.lock` の解決済み直接・間接依存                           | main への push、PR、毎日、手動                           | Code scanning と[ワークフローの成果物](https://github.com/upamune/agentpost/actions/workflows/osv.yml)                                                                            |
| Bun audit                            | 解決済み依存ツリーのレジストリアドバイザリ                                   | main への push、PR、毎日、手動                           | [Dependency audit](https://github.com/upamune/agentpost/actions/workflows/audit.yml)                                                                                              |
| Dependency review                    | PR で新しく持ち込まれる既知の脆弱性。Low から対象                            | PR、base/head を指定した手動実行                         | [Dependency review](https://github.com/upamune/agentpost/actions/workflows/dependency-review.yml)                                                                                 |
| Dependabot                           | Bun と SHA 固定した GitHub Actions の更新 PR、既知の脆弱性の修正 PR          | バージョン確認は毎週、アドバイザリ公開時                 | [Dependabot alerts](https://github.com/upamune/agentpost/security/dependabot)、依存更新 PR                                                                                        |
| zizmor の auditor persona            | ワークフローのインジェクション、危険なトリガー、権限、認証情報、Actions 設定 | main への push、PR、毎週、手動。ローカル CI はオフライン | Code scanning と [Workflow security](https://github.com/upamune/agentpost/actions/workflows/zizmor.yml)                                                                           |
| OpenSSF Scorecard                    | リポジトリとソフトウェアサプライチェーンの運用状況                           | main への push、毎週、手動                               | [公開スコア](https://scorecard.dev/viewer/?uri=github.com/upamune/agentpost)、Code scanning、[ワークフロー](https://github.com/upamune/agentpost/actions/workflows/scorecard.yml) |
| Gitleaks と GitHub secret protection | 到達可能な Git 履歴と認識対象の漏洩した認証情報                              | CI、GitHub 側の検出と push protection                    | [CI](https://github.com/upamune/agentpost/actions/workflows/ci.yml)、管理者向け秘密情報アラート                                                                                   |
| テストと TLA+                        | 敵対的な境界テスト、送受信の不変条件、実コードでの再現、変異自己検査         | main への push、PR                                       | CI と[形式検証](formal-verification.ja.md)                                                                                                                                        |

CodeQL、OSV、zizmor、Scorecard は SARIF を GitHub に送ります。各セキュリティワークフローのリポジトリアクセスは読み取りを基本とし、結果の登録に必要な権限だけをジョブ単位で与えます。Scorecard だけは公開結果の送信元を認証する OIDC ID を受け取り、本番のメール認証情報は使いません。`pull_request_target`、外部の GitHub App のインストール、PR へのスキャン結果コメントは使いません。Action の参照は pinact で SHA に固定します。

OSV の既知の脆弱性や zizmor の Low 以上の指摘はチェックを失敗させます。Dependency review は新しく持ち込まれるアドバイザリを拒否します。CodeQL と Scorecard は GitHub のアラート画面を使うため、ワークフローの完了だけでは指摘がないとは判断できません。Code scanning のアラートとリポジトリルールも確認します。検出結果は調査して修正するか、根拠と対象を限定して判断を記録します。バッジを緑にするための一括除外は追加しません。

SARIF を送るワークフローは public リポジトリを対象とし、private 向けの有料機能を有効化せずに GitHub の連携を使います。private な fork でもローカル検査、Gitleaks、Bun audit、テスト、形式検証は利用できます。[CodeQL](https://docs.github.com/en/code-security/code-scanning/introduction-to-code-scanning/about-code-scanning)、[OSV](https://google.github.io/osv-scanner/github-action/)、[zizmor](https://docs.zizmor.sh/integrations/)、[Scorecard](https://github.com/ossf/scorecard-action) の公式説明も参照してください。

## ローカルでの実行

```sh
mise install
mise exec -- bun install --frozen-lockfile
mise run ci
mise run security:dependencies
```

`ci` はオフラインの zizmor 検査を含みます。OSV の別コマンドは解決済みの `bun.lock` だけを調べ、ローカルの非公開設定を再帰的に収集しません。OSV はパッケージ名と解決済みバージョンをアドバイザリサービスに送信します。GitHub 側のオンライン検査には、オフラインでは検出できない項目もあります。

Dependabot の通常更新は、新しく公開された悪意あるバージョンをすぐ取り込むリスクを減らすため、上流のリリースから 7 日待ちます。アドバイザリに基づくセキュリティ更新には、この待機期間を適用しません。ローカルの zizmor 検査は Dependabot 設定を含む `.github` 全体を対象にします。

## リポジトリの保護

上流リポジトリは公開済みです。GitHub の秘密情報スキャン、push protection、Dependabot のアラートとセキュリティ更新、脆弱性の非公開報告を有効にしています。Actions は SHA 固定を必須にし、既定の権限を読み取り専用にしています。外部の貢献者によるワークフロー実行には、全員についてメンテナーの承認を要求します。

有効な `main security checks` ルールは、PR、main に追随したブランチ、レビュー会話の解決と、14 個の GitHub Actions 検査の通過を要求します。対象は整形、lint、型、テスト、ビルド、Action の固定、秘密情報、送受信それぞれの形式検証、Bun audit、OSV、zizmor、CodeQL、依存関係レビューです。別のコードスキャンルールでも CodeQL の全重大度の検出をマージの阻止対象にします。強制 push とブランチ削除を禁止し、ルールを迂回できる主体は設定していません。運用者が 1 人のため、他者の承認数は 0 に設定しています。独立した人間のレビューを保証する設定ではありません。

これらは上流 GitHub リポジトリの設定です。clone やセルフホスト環境には自動継承されません。fork の管理者は自分のリポジトリでも保護を設定してください。

## 報告と対応

脆弱性は [GitHub の非公開報告](https://github.com/upamune/agentpost/security/advisories/new)から、[SECURITY.md](../SECURITY.ja.md) に従って報告してください。本物のトークン、メール、導入先ホスト名、動作する攻撃の詳細は公開 issue や CI 成果物に含めません。本番の認証情報と非公開の導入用ファイルはリポジトリやスキャナーの対象に含まれません。

依存関係・認証の変更や新しいアドバイザリに応じて結果を確認します。スキャナーの障害を「指摘なし」とは扱いません。OSV は自前のジョブで終了コードを保持し、0（指摘なし）と 1（脆弱性あり）の完了したスキャンだけを登録します。127 などの障害は、空のレポートが書かれていても失敗とし、クリーンな結果を登録しません。シェルの実行を使う 3 ケースの回帰テストでこの境界を検査します。スコアは観測できた運用状況を測るもので、コードに脆弱性がない証明ではありません。スコアを上げるために検査を弱めたり、実態のない運用規程を作ったりしません。アラートの判断と修正は引き続きメンテナーが行います。

リリース自動化で将来登録する GitHub App の秘密鍵は、main だけを対象にした `release-automation` Environment に置きます。既存 App の登録は別の管理作業として残し、セキュリティ検査には App の鍵を要求しません。[リリース手順](releases.ja.md)を参照してください。

## 公開前監査 — 2026-10-26

コードの監査基点は `61e305b62f0c98dde3ca1a84d7829f195fd70c01` です。3 人の独立した敵対的レビュアーが、認証・OAuth・MCP・所有権、クライアントと導入手順、メール処理・復旧・ドメイン診断の境界を再点検しました。この範囲で新しく再現できた公開を止める脆弱性はありませんでした。過去の修正は[2026-10-25 の監査](security-audit.ja.md)に記録しています。

公開前に Gitleaks で到達可能な 21 コミットを検査しました。441 個の到達可能な blob を既知のローカル認証情報 5 個と実環境の識別子に照合する別検査でも、一致はありませんでした。照合した値は報告に含めていません。Bun audit の 287 パッケージと OSV が解析したロックファイルの 290 エントリーには既知のアドバイザリがありませんでした。担当者の検査は認証・Events の 39 テスト、クライアントの 28 テスト、モックした診断の 17 テスト、メール・診断・セキュリティの 69 テストを実行しています。重複があるため件数を足して固有の検査数とはしません。本番への攻撃や実メール送信は行っていません。ローカル CI では通常の Worker テスト 100 件、クライアントテスト 28 件、送受信の形式検証と変異自己検査も通過しています。

ワークフローは matrix の値をシェルのソースへ直接埋め込む形から、引用した環境変数を経由する形にし、将来のリリース鍵は main 専用 Environment に隔離しました。以前の matrix は信頼済みの固定リストであり、これは予防的な強化であって、外部からのコード実行を実証した指摘ではありません。

初回の GitHub 側の検査では、合成データを使う CLI ダウンロードテストに CodeQL のファイル競合が 4 件報告されました。テストがパスの属性を確認してから、そのパスの内容を読み書きしていたためです。本番のダウンロードは既に `wx` による排他的な `open` と、返されたハンドルへの書き込みを使っています。テストは同じハンドルで権限と内容を確認し、上書きとシンボリックリンクの確認には別途排他的に作成したファイルを使う形へ改善しました。検出規則の抑制は追加していません。zizmor は Dependabot の暗黙の待機期間が短い点も検出したため、両方の更新対象で 7 日を明示しました。OSV の正常・脆弱性検出・検査失敗を確かめるシェル回帰テスト 3 件を追加し、通常テストは Worker 100 件と Bun 31 件になっています。

Scorecard は、リポジトリ作成から日が浅いこと、独立したレビュー履歴がないこと、継続的な fuzzing がないこと、OpenSSF Best Practices に未登録であることも報告します。これらはアプリの悪用可能な脆弱性を示す指摘ではありません。バッジの点数を上げるために無視・非表示にせず、改善点として残します。

これはコードと公開範囲の監査です。システム全体の無欠陥性、MIME パーサーの全メモリ確保の上限、Cloudflare の実環境での分離、バックアップ復元、メールの到達性、悪意あるメールを根拠にした任意のエージェント操作の安全性は証明していません。各利用者は自分の環境で[導入時の確認](deploy.ja.md)を行ってください。
