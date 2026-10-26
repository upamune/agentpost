# リリース

[English](releases.md) | [日本語](releases.ja.md)

mainへのpushで[tagpr](https://github.com/Songmu/tagpr)がリリースPRを作成・更新します。
PRで`package.json`のバージョンと`CHANGELOG.md`を確認し、merge commitまたはsquashでマージすると、`v`付きタグと draft の GitHub Release を作成します。
CLIとMCPが返すバージョンも`package.json`から読み込みます。
リリースPRのマージは管理者が判断してください。

[検証付きリリースワークフロー](../.github/workflows/release.yml)は、コミット済みソースのアーカイブ、CLI/MCPの単体実行ファイル、チェックサム、署名付きSLSA来歴証明を生成します。全CIとOSVの成功後に署名し、draftからダウンロードした全成果物を検証して公開します。immutable releaseで公開後のタグと成果物の置き換えを防ぎます。npmへの公開やWorkerのデプロイは行いません。Workerには[導入手順](deploy.ja.md)を使います。

## 単体実行ファイル

Bunを内包し、CLIコマンドと `agentpost mcp` の両方を使えます。利用側にBun・Node.js・ソースcheckoutは不要です。名前は `agentpost-VERSION-SUFFIX` です。

| プラットフォーム        | 成果物の末尾                            |
| ----------------------- | --------------------------------------- |
| macOS arm64 / x64       | `darwin-arm64` / `darwin-x64`           |
| Linux glibc arm64 / x64 | `linux-arm64` / `linux-x64`             |
| Linux musl arm64 / x64  | `linux-arm64-musl` / `linux-x64-musl`   |
| Windows arm64 / x64     | `windows-arm64.exe` / `windows-x64.exe` |

Alpine Linuxにはmusl版を選びます。実行ファイルはCLI/MCPクライアントであり、WorkerのホストにはソースとCloudflareのツールが必要です。v0.1.1を含む過去のソース限定リリースにバイナリは追加しません。必要な実行ファイルが実際に掲載されているリリースを選びます。

[共通ビルドワークフロー](../.github/workflows/executables.yml)でBunとネイティブのGitHub-hosted runnerを固定します。全ターゲットを2回コンパイルしてバイト比較し、CLIのリクエスト、stdio MCPのツール検出、Events、作業ディレクトリの `.env`・`bunfig.toml` からの分離を確認します。musl版はdigest固定のBun Alpineイメージで外部ネットワークを無効にして検査します。macOS版にApple notarization、Windows版にAuthenticode署名はなく、配布元の認証にはGitHubの来歴証明を使います。動作要件は[Bun](https://bun.sh/docs/installation)に従います。

## ダウンロードの検証

新しいダウンロード先を使い、`X.Y.Z` を選んだバージョンへ置き換えます。同じ[リリース](https://github.com/upamune/agentpost/releases)から実行ファイル1つ（またはソースの `agentpost-VERSION.tar.gz`）と検証用ファイルを取得します。実行・展開の前に3つの対象の来歴を認証します。

```sh
version="X.Y.Z" # Select a release that lists standalone assets.
asset="agentpost-${version}-darwin-arm64" # Choose the platform from the table.
gh release download "v$version" --repo upamune/agentpost \
  --pattern "$asset" --pattern SHA256SUMS --pattern release-manifest.json \
  --pattern provenance.sigstore.json
for file in "$asset" SHA256SUMS release-manifest.json; do
  gh attestation verify "$file" --repo upamune/agentpost \
    --bundle provenance.sigstore.json \
    --signer-workflow upamune/agentpost/.github/workflows/release.yml \
    --source-ref "refs/tags/v$version" --deny-self-hosted-runners || exit 1
done
awk -v name="$asset" '$2 == name {print}' SHA256SUMS > selected.sha256
test "$(wc -l < selected.sha256)" -eq 1 || exit 1
shasum -a 256 -c selected.sha256 # On Linux, sha256sum -c selected.sha256 also works.
```

PowerShellでは次のように検証します。

```powershell
$Version = "X.Y.Z"
$Asset = "agentpost-$Version-windows-arm64.exe"
gh release download "v$Version" --repo upamune/agentpost --pattern $Asset --pattern SHA256SUMS --pattern release-manifest.json --pattern provenance.sigstore.json
if ($LASTEXITCODE -ne 0) { throw "Download failed" }
foreach ($File in @($Asset, "SHA256SUMS", "release-manifest.json")) {
  gh attestation verify $File --repo upamune/agentpost --bundle provenance.sigstore.json --signer-workflow upamune/agentpost/.github/workflows/release.yml --source-ref "refs/tags/v$Version" --deny-self-hosted-runners
  if ($LASTEXITCODE -ne 0) { throw "Provenance verification failed" }
}
$Rows = @(Get-Content SHA256SUMS | Where-Object { $_ -match ('^[a-f0-9]{64}  ' + [regex]::Escape($Asset) + '$') })
if ($Rows.Count -ne 1) { throw "Missing or ambiguous checksum" }
$Expected = ($Rows[0] -split '  ', 2)[0]
if ((Get-FileHash -Algorithm SHA256 $Asset).Hash.ToLowerInvariant() -ne $Expected) { throw "Checksum mismatch" }
```

チェックサムだけでは配布元を認証できません。bundleには署名と検証資料を含み、`provenance.intoto.jsonl` は同じ署名付きDSSE envelopeをSLSA向けに公開します。署名は配布元の証明であり、バグ不在や独立したSLSA認証の証明ではありません。`release-manifest.json` にソースのコミット、バージョン、Bunのバージョン、全payloadのサイズとdigestを記録します。一部だけ取得した場合は選んだチェックサムの行を検証し、全payloadを取得した場合は `SHA256SUMS` 全体を検証できます。

`mise run release:build` はGit HEADのアーカイブを `dist/release/` に作り、未コミットの変更、無視されたファイル、ローカルの導入用資格情報を含めません。`mise run cli:build PLATFORM --verify-reproducible` は `dist/executables/` に実行ファイルを作り、ソース・package・lockfile・TypeScriptとツールの設定・ビルドスクリプトのコミットを必須にします。検査済みの8ビルドを集め、`mise run release:finalize` で不足・余分・空・symlinkの成果物を拒否してチェックサムとmanifestをまとめます。ソースの本人性と元アーカイブのdigestも確認します。PR・mainのCIも同じ共通ワークフローで全ターゲットのビルド・起動確認を行います。

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
gh release view v0.1.1 --repo upamune/agentpost
```
