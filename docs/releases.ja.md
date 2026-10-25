# リリース

[English](releases.md) | [日本語](releases.ja.md)

mainへのpushで[tagpr](https://github.com/Songmu/tagpr)がリリースPRを作成・更新します。
PRで`package.json`のバージョンと`CHANGELOG.md`を確認し、merge commitまたはsquashでマージすると、`v`付きタグと draft の GitHub Release を作成します。
CLIとMCPが返すバージョンも`package.json`から読み込みます。
リリースPRのマージは管理者が判断してください。

別の[検証付きリリースワークフロー](../.github/workflows/release.yml)が、コミット済みソースのアーカイブ、チェックサム、署名付き SLSA 来歴証明を生成します。全 CI と OSV を通した後で署名し、draft からダウンロードした成果物を再検証して公開します。immutable release により、公開後のタグと成果物の置き換えを防ぎます。このフローはソースのリリースであり、npm への公開、CLI バイナリの配布、本番へのデプロイは含みません。
Workerの導入・更新は[導入手順](deploy.ja.md)に従って行います。

## ダウンロードの検証

同じ[リリース](https://github.com/upamune/agentpost/releases)から、バージョン付きアーカイブ、`SHA256SUMS`、`release-manifest.json`、`provenance.sigstore.json` を取得します。展開や実行の前に来歴を検証してください。

```sh
gh attestation verify agentpost-0.1.0.tar.gz --repo upamune/agentpost \
  --bundle provenance.sigstore.json \
  --signer-workflow upamune/agentpost/.github/workflows/release.yml \
  --source-ref refs/tags/v0.1.0 --deny-self-hosted-runners
sha256sum --check SHA256SUMS
```

ファイル名とタグは実際のバージョンに合わせます。macOS のチェックサム確認は `shasum -a 256 -c SHA256SUMS` を使ってください。チェックサムだけでは配布者を認証できません。Sigstore bundle は署名と検証用の情報を保持し、`provenance.intoto.jsonl` は同じ署名済み DSSE envelope を SLSA 利用者に提供します。来歴の署名は出所を確認するものであり、バグの不在や独立した SLSA 認証を意味しません。

`mise run release:build` は Git HEAD の決定的なアーカイブを `dist/release/` に作ります。未コミットの変更、無視ファイル、ローカルの導入用資格情報は含めません。アーカイブの回帰テストで除外と再現性を確認します。

## プレビューと再実行

main で公開しないプレビューを実行すると、全検査と検証可能な成果物の生成だけを行い、タグやリリースは作りません。

```sh
gh workflow run release.yml --repo upamune/agentpost --ref main
```

タグの push は公開を開始します。復旧時は既存のバージョンタグを指定し、`-f publish=true` 付きで同じワークフローを実行します。タグは `package.json` と一致し、main から到達できるコミットを指す必要があります。公開済みの immutable release を変更する場合は新しいバージョンを使い、タグ移動や成果物の上書きは行いません。失敗時は点検可能な draft を残し、不完全な immutable release は公開しません。App の設定が未完了の初回は、メンテナーが確認済みのバージョンタグを作って開始できます。ワークフロー自体はタグを作成・移動しません。

## GitHub Appの初期設定

インストールした App の数値 App ID を、作成専用の `version tag creators` ルールに Integration として明示追加します。`version tag integrity` の更新・削除保護は変更しません。

`release-automation` Environment のデプロイ対象を main ブランチだけに制限し、秘密鍵はその Environment のシークレットとして登録します。Client ID はジョブの有効化判定に使うためリポジトリ変数に置きます。

`TAGPR_APP_CLIENT_ID`が未登録の間、tagprジョブはスキップされます。
ワークフローの追加だけではリリースPRは作成されません。

1. [GitHub Appを作成](https://github.com/settings/apps/new)します。既存のリリース用Appがあれば再利用できます。
2. Webhookを無効にし、Repository permissionsにContents: Read and write、Pull requests: Read and write、Issues: Read-onlyを設定します。
3. Appを対象リポジトリだけにインストールし、秘密鍵を生成します。
4. 秘密鍵をActions secretに登録した後、Client IDをActions variableに登録します。鍵をGitやチャットに貼らないでください。

```sh
gh secret set TAGPR_APP_PRIVATE_KEY --env release-automation --repo upamune/agentpost < /absolute/path/to/app.private-key.pem
gh variable set TAGPR_APP_CLIENT_ID --repo upamune/agentpost --body 'YOUR_APP_CLIENT_ID'
```

`TAGPR_`はリリース自動化の認証設定で、アプリ本体の`AGENTPOST_`設定とは別です。
Appの権限を変更した場合は、インストール先で変更を承認してください。

ActionsからPRを作成する設定も有効にします。通常のワークフロートークンは読み取り権限のままにします。

```sh
gh api -X PUT repos/upamune/agentpost/actions/permissions/workflow -F can_approve_pull_request_reviews=true
gh api repos/upamune/agentpost/actions/permissions/workflow
gh secret list --repo upamune/agentpost
gh variable list --repo upamune/agentpost
gh workflow run tagpr.yml --repo upamune/agentpost --ref main
gh run list --repo upamune/agentpost --workflow tagpr.yml
gh pr list --repo upamune/agentpost --label tagpr
```

初回は前回タグがないため、変更履歴は最初のコミットから始まります。
最初のリリースは`0.1.0`を想定し、提案が異なる場合はリリースPR内の`package.json`を編集してからマージします。
バージョンと変更履歴の差分、PRのCI成功を確認するまでマージしないでください。

## 通常のリリースと復旧

通常はpatchを提案します。
変更PRの`major`・`breaking`ラベルはmajor、`minor`・`enhancement`・`feature`はminorの提案に使います。
リリースPRに直接`tagpr:major`・`tagpr:minor`を指定するか、バージョンファイルを編集して調整できます。
変更履歴の分類は[release.yml](../.github/release.yml)で管理します。

実行が失敗した場合はAppのインストール先・権限・認証設定を確認し、Actionsからtagprを再実行します。
手動実行はmainを指定してください。
既存タグを移動したり、別のワークフローから同じタグを作成したりしないでください。
マージ後はタグの対象コミットとGitHub Releaseを確認します。

```sh
git fetch origin --tags
git tag --points-at origin/main
gh release view v0.1.0 --repo upamune/agentpost
```
