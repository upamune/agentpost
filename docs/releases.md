# Releases

[English](releases.md) | [日本語](releases.ja.md)

Once configured, [tagpr](https://github.com/Songmu/tagpr) creates/updates a release PR on pushes to main. Review `package.json` and `CHANGELOG.md`; merging with a merge commit or squash creates a `v` tag and a draft GitHub Release. CLI/MCP versions also come from `package.json`. A maintainer decides when to merge.

The separate [verified release workflow](../.github/workflows/release.yml) builds committed source archives, checksums, and signed SLSA provenance. It runs full CI and OSV before signing, verifies the downloaded draft assets, and then publishes. Immutable releases protect published tags and assets from replacement. This releases source only; it does not publish npm packages, CLI binaries, or production deployments. Deploy/update a Worker using the [deployment guide](deploy.md).

## Verify a download

Download the versioned archive, `SHA256SUMS`, `release-manifest.json`, and `provenance.sigstore.json` from the same [release](https://github.com/upamune/agentpost/releases). Verify provenance before extracting or running code:

```sh
gh attestation verify agentpost-0.1.1.tar.gz --repo upamune/agentpost \
  --bundle provenance.sigstore.json \
  --signer-workflow upamune/agentpost/.github/workflows/release.yml \
  --source-ref refs/tags/v0.1.1 --deny-self-hosted-runners
sha256sum --check SHA256SUMS
```

Use the actual version in the filenames and tag. On macOS, use `shasum -a 256 -c SHA256SUMS` for the checksum step. A checksum alone is not publisher authentication. The Sigstore bundle holds the signature and verification material; `provenance.intoto.jsonl` exposes the same signed DSSE envelope for SLSA consumers. A provenance signature establishes origin, not the absence of bugs or an independent SLSA certification.

`mise run release:build` creates a deterministic archive of Git HEAD in `dist/release/`. Uncommitted changes, ignored files, and local deployment credentials are excluded. The archive regression test checks these exclusions and reproducibility.

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
