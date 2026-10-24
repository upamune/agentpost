# Releases

[English](releases.md) | [日本語](releases.ja.md)

Once configured, [tagpr](https://github.com/Songmu/tagpr) creates/updates a release PR on pushes to main. Review `package.json` and `CHANGELOG.md`; merging with a merge commit or squash creates a `v` tag and GitHub Release. CLI/MCP versions also come from `package.json`. A maintainer decides when to merge.

This releases source only. It does not publish npm packages, CLI binaries, or production deployments. Deploy/update a Worker using the [deployment guide](deploy.md).

## GitHub App setup

The tagpr job is skipped while `TAGPR_APP_CLIENT_ID` is unset. Adding the workflow alone does not create release PRs.

1. [Create a GitHub App](https://github.com/settings/apps/new), or reuse an existing release App.
2. Disable webhooks. Set repository permissions: Contents and Pull requests **Read and write**, Issues **Read-only**.
3. Install it only on the intended repository and generate a private key.
4. Register the key as an Actions secret, then the Client ID as an Actions variable. Keep the key out of Git and chat.

```sh
gh secret set TAGPR_APP_PRIVATE_KEY --repo upamune/agentpost < /absolute/path/to/app.private-key.pem
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
gh release view v0.1.0 --repo upamune/agentpost
```
