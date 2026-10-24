# リリース

[English](releases.md) | [日本語](releases.ja.md)

mainへのpushで[tagpr](https://github.com/Songmu/tagpr)がリリースPRを作成・更新します。
PRで`package.json`のバージョンと`CHANGELOG.md`を確認し、merge commitまたはsquashでマージすると、`v`付きタグとGitHub Releaseを作成します。
CLIとMCPが返すバージョンも`package.json`から読み込みます。
リリースPRのマージは管理者が判断してください。

このフローはソースのリリースです。npmへの公開、CLIバイナリの配布、本番へのデプロイは含みません。
Workerの導入・更新は[導入手順](deploy.ja.md)に従って行います。

## GitHub Appの初期設定

`TAGPR_APP_CLIENT_ID`が未登録の間、tagprジョブはスキップされます。
ワークフローの追加だけではリリースPRは作成されません。

1. [GitHub Appを作成](https://github.com/settings/apps/new)します。既存のリリース用Appがあれば再利用できます。
2. Webhookを無効にし、Repository permissionsにContents: Read and write、Pull requests: Read and write、Issues: Read-onlyを設定します。
3. Appを対象リポジトリだけにインストールし、秘密鍵を生成します。
4. 秘密鍵をActions secretに登録した後、Client IDをActions variableに登録します。鍵をGitやチャットに貼らないでください。

```sh
gh secret set TAGPR_APP_PRIVATE_KEY --repo upamune/agentpost < /absolute/path/to/app.private-key.pem
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
