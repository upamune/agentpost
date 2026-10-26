# Releases

[English](releases.md) | [日本語](releases.ja.md)

Once configured, [tagpr](https://github.com/Songmu/tagpr) creates/updates a release PR on pushes to main. Review `package.json` and `CHANGELOG.md`; merging with a merge commit or squash creates a `v` tag and a draft GitHub Release. CLI/MCP versions also come from `package.json`. A maintainer decides when to merge.

The [verified release workflow](../.github/workflows/release.yml) produces committed source archives and standalone CLI/MCP executables, checksums, and signed SLSA provenance. Full CI and OSV run before signing; all downloaded draft assets are checked before publication. Immutable releases protect published tags and assets. This does not publish npm packages or deploy a Worker; use the [deployment guide](deploy.md).

## Standalone executables

Each executable embeds Bun and serves both CLI commands and `agentpost mcp`. Bun, Node.js and a source checkout are unnecessary on the client. Names are `agentpost-VERSION-SUFFIX`:

| Platform                | Asset suffix                          |
| ----------------------- | ------------------------------------- |
| macOS arm64 / x64       | `darwin-arm64` / `darwin-x64`         |
| Linux glibc arm64 / x64 | `linux-arm64` / `linux-x64`           |
| Linux musl arm64 / x64  | `linux-arm64-musl` / `linux-x64-musl` |
| Windows x64             | `windows-x64.exe`                     |

Choose musl for Alpine Linux. These are CLI/MCP clients; hosting the Worker still requires the source and Cloudflare tooling. Previous source-only releases, including v0.1.1, do not gain binary assets retroactively. Select a release that actually lists the executable you need.

Bun and native GitHub-hosted runners are pinned in [the reusable build workflow](../.github/workflows/executables.yml). Every target is compiled twice for a byte comparison and smoke-tested for CLI requests, stdio MCP/tool discovery, Events, and isolation from local `.env`/`bunfig.toml`. Musl tests run in the digest-pinned Bun Alpine image with external networking disabled. macOS binaries have no Apple notarization and Windows binaries have no Authenticode signature; GitHub attestations authenticate the release origin. Platform requirements follow [Bun](https://bun.sh/docs/installation).

## Verify a download

Use a new download directory and replace `X.Y.Z` with the chosen version. Download one executable (or the source archive `agentpost-VERSION.tar.gz`) and the verification files from the same [release](https://github.com/upamune/agentpost/releases). Authenticate all three subjects before executing or extracting anything:

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

For PowerShell:

```powershell
$Version = "X.Y.Z"
$Asset = "agentpost-$Version-windows-x64.exe"
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

A checksum alone is not publisher authentication. The bundle holds the signature and verification material; `provenance.intoto.jsonl` exposes the same signed DSSE envelope for SLSA consumers. A signature establishes origin, not absence of bugs or independent SLSA certification. `release-manifest.json` records source commit, version, Bun version and every payload's size/digest. Partial downloads verify only their selected checksum row; downloading every payload permits checking the complete `SHA256SUMS` file.

`mise run release:build` archives Git HEAD into `dist/release/`; uncommitted changes, ignored files and local deployment credentials are excluded. `mise run cli:build PLATFORM --verify-reproducible` writes a standalone executable into `dist/executables/` (use target IDs without `.exe`, such as `windows-x64`) and requires committed source, package, lockfile, TypeScript/tool configuration and build scripts. After all seven verified builds are collected, `mise run release:finalize` rejects missing, unexpected, empty or symlink assets and creates the combined checksums/manifest. It also checks source identity and the original source archive digest. PR/main CI builds and smoke-tests all targets through the same reusable workflow.

## Preview and retry

Run a nonpublishing preview on main; it performs full checks and generates verifiable artifacts without creating a tag or release:

```sh
gh workflow run release.yml --repo upamune/agentpost --ref main
```

A tag push triggers publication. For recovery, run the same workflow on an existing version tag with `-f publish=true`. The tag must match `package.json` and point to a commit reachable from main. Use a new version for an already published immutable release; never move its tag or overwrite its assets. A failed run leaves an inspectable draft, not a partially published immutable release. The initial release may be bootstrapped by a maintainer creating the reviewed version tag while the App setup below is pending. The workflow itself never creates or moves tags.

## GitHub App setup

Restrict the `release-automation` Environment to deployments from the main branch and store the private key as an Environment secret. Keep the Client ID in repository variables so the job can decide whether automation is enabled before entering the Environment.

The tagpr job is skipped while `TAGPR_APP_CLIENT_ID` is unset. Adding the workflow alone does not create release PRs.

1. [Create a GitHub App](https://github.com/settings/apps/new), or reuse an existing release App.
2. Disable webhooks. Set repository permissions: Contents and Pull requests **Read and write**, Issues **Read-only**.
3. Install it only on the intended repository and generate a private key.
4. Add the installed App's numeric App ID as an Integration bypass actor to the `version tag creators` creation-only ruleset. Keep `version tag integrity` update/deletion protection unchanged. Register the key as an Actions secret, then the Client ID as an Actions variable. Keep the key out of Git and chat.

```sh
gh secret set TAGPR_APP_PRIVATE_KEY --env release-automation --repo upamune/agentpost < /absolute/path/to/app.private-key.pem
gh variable set TAGPR_APP_CLIENT_ID --repo upamune/agentpost --body 'YOUR_APP_CLIENT_ID'
```

`TAGPR_` configures release automation separately from application `AGENTPOST_` variables. Approve installation permission changes when modifying the App.

Enable workflow PR creation while keeping the ordinary workflow token read-only:

```sh
gh api -X PUT repos/upamune/agentpost/actions/permissions/workflow -F can_approve_pull_request_reviews=true
gh api repos/upamune/agentpost/actions/permissions/workflow
gh secret list --repo upamune/agentpost
gh variable list --repo upamune/agentpost
gh workflow run tagpr.yml --repo upamune/agentpost --ref main
gh run list --repo upamune/agentpost --workflow tagpr.yml
gh pr list --repo upamune/agentpost --label tagpr
```

Without a previous tag, the first changelog starts at the first commit. The intended initial version is `0.1.0`; edit the release PR's version if the proposal differs. Verify version/changelog changes and passing PR CI before merging.

## Routine releases and recovery

The default increment is patch. Change PR labels `major`/`breaking` suggest major, and `minor`/`enhancement`/`feature` suggest minor. Adjust with release PR labels `tagpr:major` / `tagpr:minor` or edit the version file. Changelog categories live in [release.yml](../.github/release.yml).

On failure, check App installation, permissions, and credentials, then rerun tagpr on main. Do not move existing tags or let another workflow create the same tag. After merging, inspect the tagged commit and GitHub Release:

```sh
git fetch origin --tags
git tag --points-at origin/main
gh release view v0.1.1 --repo upamune/agentpost
```
